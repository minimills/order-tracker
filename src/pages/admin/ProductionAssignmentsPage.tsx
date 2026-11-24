// @permission-scope admin.production_assignments
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import Can from '../../components/Can'
import { buttonClass, Field, narrowInputClass, secondaryButtonClass } from '../../components/form'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useDepartments } from '../../lib/useDepartments'
import { tr } from '../../i18n'

type TemplateStage = { id: string; name: string; step: string; sort_order: number }
type Rule = { id: string; stage_template_id: string; machine_type_id: string | null; assignee_type: 'user' | 'department'; user_email: string | null; department_id: string | null; applies_to: 'card' | 'tasks' | 'both' }
type Person = { email: string; name: string }
type MachineType = { id: string; name: string }
type Draft = { kind: 'user' | 'department'; who: string; type: string; applies: Rule['applies_to'] }

const APPLIES: Record<Rule['applies_to'], string> = { get both() {
    return tr("Card and its tasks")
  }, get card() {
    return tr("Card only")
  }, get tasks() {
    return tr("Tasks only")
  } }
const blank: Draft = { kind: 'user', who: '', type: '', applies: 'both' }

/**
 * Admin → Production Assignments: default people per production stage,
 * optionally only for one machine type. When a machine card enters the stage
 * (from the moment the order is confirmed), the card and the stage's tasks
 * get these people. Anyone allowed can change them on the card at any time.
 */
export default function ProductionAssignmentsPage() {
  const { departments } = useDepartments()
  const [stages, setStages] = useState<TemplateStage[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [types, setTypes] = useState<MachineType[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const [s, r, p, t] = await Promise.all([
      supabase.from('production_stage_template').select('id, name, step, sort_order').eq('archived', false).order('sort_order'),
      supabase.from('production_assignments').select('*').order('created_at'),
      supabase.rpc('people_choices'),
      supabase.from('machine_types').select('id, name').eq('archived', false).order('name'),
    ])
    const e = s.error ?? r.error
    if (e) toast.error(friendlyError(e))
    setStages((s.data as TemplateStage[]) ?? [])
    setRules((r.data as Rule[]) ?? [])
    setPeople(((p.data as Person[]) ?? []).sort((a, b) => a.name.localeCompare(b.name)))
    setTypes((t.data as MachineType[]) ?? [])
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const nameOf = (r: Rule) =>
    r.assignee_type === 'user'
      ? (people.find((p) => p.email === r.user_email)?.name ?? r.user_email ?? '')
      : tr("{{value}} (everyone in it)", { value: departments.find((d) => d.id === r.department_id)?.name ?? tr("Department") })

  async function add(stageId: string) {
    if (!supabase) return
    const d = drafts[stageId] ?? blank
    if (!d.who) return toast.error(d.kind === 'user' ? tr("Choose a person.") : tr("Choose a department."))
    setBusy(true)
    const { error } = await supabase.from('production_assignments').insert({
      stage_template_id: stageId,
      machine_type_id: d.type || null,
      assignee_type: d.kind,
      user_email: d.kind === 'user' ? d.who : null,
      department_id: d.kind === 'department' ? d.who : null,
      // A department can only go on the card (a task has one person).
      applies_to: d.kind === 'department' ? 'card' : d.applies,
    })
    setBusy(false)
    if (error) return toast.error(/duplicate|unique/i.test(error.message) ? tr("That default is already there.") : friendlyError(error))
    setDrafts((x) => ({ ...x, [stageId]: blank }))
    load()
  }
  async function remove(r: Rule) {
    if (!supabase) return
    const { error } = await supabase.from('production_assignments').delete().eq('id', r.id)
    if (error) return toast.error(friendlyError(error))
    load()
  }
  async function applyNow() {
    if (!supabase) return
    if (
      !(await confirmAction(
        tr("Use these defaults now on every machine card of the open production boards? People added by hand stay on the cards; tasks that already have someone keep them."),
        { get confirmLabel() {
    return tr("Apply to Open Boards")
  } },
      ))
    )
      return
    setBusy(true)
    const { data, error } = await supabase.rpc('apply_production_assignments')
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Defaults applied to {{count}} machine card.", { count: data }))
  }

  return (
    <div className="space-y-4">
      <AdminPageHeader
        title={tr("Production Assignments")}
        aside={
          <Can permission="admin.production_assignments" level="edit">
            <button type="button" className={secondaryButtonClass} onClick={applyNow} disabled={busy}>
              {tr("Apply to Open Boards")}
            </button>
          </Can>
        }
      >
        {tr("Who is put on a machine card (and its tasks) when it reaches each production stage, from the moment an order is confirmed. Defaults for one machine type are used instead of the defaults for every machine type. Assigning is optional: anyone allowed can change the people on a card or a task at any time, also while a task is running (its timer stays with the task and the change is logged).")}
      </AdminPageHeader>
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,24rem),1fr))]">
        {stages.map((s) => {
          const mine = rules.filter((r) => r.stage_template_id === s.id)
          const d = drafts[s.id] ?? blank
          const set = (patch: Partial<Draft>) => setDrafts((x) => ({ ...x, [s.id]: { ...(x[s.id] ?? blank), ...patch } }))
          return (
            <section key={s.id} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting={`assign-${s.step}`}>
              <h2 className="text-base font-semibold">{s.name}</h2>
              {mine.length === 0 ? (
                <p className="text-slate-500">{tr("Nobody is assigned automatically.")}</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {mine.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{nameOf(r)}</span>
                        <span className="block text-xs text-slate-500">
                          {r.machine_type_id ? (types.find((t) => t.id === r.machine_type_id)?.name ?? tr("One machine type")) : tr("Every machine type")} · {APPLIES[r.applies_to]}
                        </span>
                      </span>
                      <Can permission="admin.production_assignments" level="edit">
                        <button type="button" className="text-xs text-red-700 underline" onClick={() => remove(r)} aria-label={tr("Remove {{nameOf}} from {{name}}", { nameOf: nameOf(r), name: s.name })}>
                          {tr("Remove")}
                        </button>
                      </Can>
                    </li>
                  ))}
                </ul>
              )}
              <Can permission="admin.production_assignments" level="edit">
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr))]">
                    <Field label={tr("Assign")} htmlFor={`pa-kind-${s.id}`}>
                      <select id={`pa-kind-${s.id}`} className={`${narrowInputClass} w-full`} value={d.kind} onChange={(e) => set({ kind: e.target.value as Draft['kind'], who: '' })}>
                        <option value="user">{tr("A person")}</option>
                        <option value="department">{tr("A department")}</option>
                      </select>
                    </Field>
                    <Field label={d.kind === 'user' ? tr("Person") : tr("Department")} htmlFor={`pa-who-${s.id}`}>
                      <select id={`pa-who-${s.id}`} className={`${narrowInputClass} w-full`} value={d.who} onChange={(e) => set({ who: e.target.value })}>
                        <option value="">{tr("Choose…")}</option>
                        {d.kind === 'user'
                          ? people.map((p) => (
                              <option key={p.email} value={p.email}>
                                {p.name}
                              </option>
                            ))
                          : departments.map((dep) => (
                              <option key={dep.id} value={dep.id}>
                                {dep.name}
                              </option>
                            ))}
                      </select>
                    </Field>
                    <Field label={tr("Machine type")} htmlFor={`pa-type-${s.id}`}>
                      <select id={`pa-type-${s.id}`} className={`${narrowInputClass} w-full`} value={d.type} onChange={(e) => set({ type: e.target.value })}>
                        <option value="">{tr("Every machine type")}</option>
                        {types.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {d.kind === 'user' && (
                      <Field label={tr("Put on")} htmlFor={`pa-applies-${s.id}`}>
                        <select id={`pa-applies-${s.id}`} className={`${narrowInputClass} w-full`} value={d.applies} onChange={(e) => set({ applies: e.target.value as Rule['applies_to'] })}>
                          {Object.entries(APPLIES).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </div>
                  <button type="button" className={buttonClass} onClick={() => add(s.id)} disabled={busy}>
                    {tr("Add Default")}
                  </button>
                </div>
              </Can>
            </section>
          )
        })}
      </div>
      {stages.length === 0 && <p className="text-sm text-slate-500">{tr("There are no production stages yet. Add them in Admin → Production.")}</p>}
    </div>
  )
}
