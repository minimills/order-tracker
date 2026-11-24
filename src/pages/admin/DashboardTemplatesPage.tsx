// @permission-scope admin.dashboards
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import DashboardCanvas from '../../components/dashboard/DashboardCanvas'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../../components/form'
import { confirmAction } from '../../lib/confirm'
import { dashData } from '../../lib/dashboardData'
import { friendlyError } from '../../lib/format'
import type { Layouts } from '../../lib/gridLayout'
import { supabase } from '../../lib/supabase'
import { useDepartments } from '../../lib/useDepartments'
import type { Widget } from '../../lib/widgets'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

type Template = { id: string; name: string; description: string | null; widgets: Widget[]; layouts: Layouts; locked: boolean; archived: boolean; updated_at: string }
type Target = { template_id: string; target_type: 'user' | 'department'; target: string }

/** Admin → Dashboard Templates: build starting dashboards, give them to people or departments, lock them. */
export default function DashboardTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [targets, setTargets] = useState<Target[]>([])
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [edit, setEdit] = useState<Template | null>(null)
  const [assign, setAssign] = useState<Template | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const { departments } = useDepartments()
  const data = useMemo(() => dashData(), [])

  const load = useCallback(async () => {
    if (!supabase) return
    const [t, g, p] = await Promise.all([
      supabase.from('dashboard_templates').select('*').order('name'),
      supabase.from('dashboard_template_targets').select('*'),
      supabase.rpc('dashboard_template_people_choices'),
    ])
    setTemplates((t.data as Template[]) ?? [])
    setTargets((g.data as Target[]) ?? [])
    setPeople(((p.data as { email: string; name: string | null }[]) ?? []).map((x) => ({ email: x.email, name: x.name || x.email })))
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function save(t: Template) {
    if (!supabase) return
    const { data: id, error } = await supabase.rpc('save_dashboard_template', {
      p: { id: t.id || null, name: t.name, description: t.description, widgets: t.widgets, layouts: t.layouts, locked: t.locked },
    })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Template saved. Select “Give It Now” to update the people it is for."))
    setEdit({ ...t, id: id as string })
    load()
  }
  async function giveNow(t: Template) {
    if (!supabase) return
    if (!(await confirmAction(tr("Give “{{name}}” to everyone it is for now? Their copy of this template is replaced (their other dashboards stay).", { name: t.name }), { get confirmLabel() {
    return tr("Give It Now")
  } }))) return
    const { data: n, error } = await supabase.rpc('apply_dashboard_template', { p_template: t.id })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Given to {{n}} {{value}}.", { n: n, value: n === 1 ? 'person' : 'people' }))
  }
  async function archive(t: Template) {
    if (!supabase) return
    const { error } = await supabase.rpc('save_dashboard_template', { p: { id: t.id, name: t.name, archived: !t.archived } })
    if (error) return toast.error(friendlyError(error))
    load()
  }
  const forText = (t: Template) => {
    const list = targets.filter((x) => x.template_id === t.id)
    if (!list.length) return 'Not given to anyone yet'
    return list.map((x) => (x.target_type === 'user' ? people.find((p) => p.email === x.target)?.name ?? x.target : departments.find((d) => d.id === x.target)?.name ?? 'a department')).join(', ')
  }

  if (edit)
    return (
      <div className="space-y-4">
        <AdminPageHeader title={edit.id ? tr("Template: {{name}}", { name: edit.name }) : tr("New Dashboard Template")}>
          {tr("Add and arrange the widgets. People only ever see the widgets they are allowed to see. Arrange it on a computer; tablets and phones get a layout worked out from it (or arrange it on those screens too).")}
        </AdminPageHeader>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <Field label={tr("Name")} htmlFor="dt-name">
            <input id="dt-name" className={inputClass} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </Field>
          <Field label={tr("Description")} htmlFor="dt-desc">
            <input id="dt-desc" className={inputClass} value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={edit.locked} onChange={(e) => setEdit({ ...edit, locked: e.target.checked })} />
            {tr("Lock it: people cannot change their copy (they can still use Reset to Template)")}
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => setEdit(null)}>
            {ACTION.close}
          </button>
          <button type="button" className={buttonClass} disabled={!edit.name.trim()} onClick={() => save(edit)}>
            {ACTION.save}
          </button>
          {edit.id && (
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setAssign(edit)}>
                {tr("Who Gets It")}
              </button>
              <button type="button" className={secondaryButtonClass} onClick={() => giveNow(edit)}>
                {tr("Give It Now")}
              </button>
            </>
          )}
        </div>
        <DashboardCanvas widgets={edit.widgets} layouts={edit.layouts} editing data={data} showAll onChange={(widgets, layouts) => setEdit({ ...edit, widgets, layouts })} />
        {assign && <AssignDialog template={assign} targets={targets} people={people} onClose={() => setAssign(null)} onSaved={load} />}
      </div>
    )

  return (
    <div className="space-y-4">
      <AdminPageHeader title={tr("Dashboard Templates")}>
        {tr("Starting dashboards for people or departments. Someone without a dashboard gets the templates meant for them when they first open the Dashboard; “Give It Now” replaces their copy. A locked template cannot be changed by the people who have it.")}
      </AdminPageHeader>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} onClick={() => setEdit({ id: '', name: '', description: '', widgets: [], layouts: {}, locked: false, archived: false, updated_at: '' })}>
          {tr("Create Template")}
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {ACTION.showArchived}
        </label>
      </div>
      {templates.filter((t) => showArchived || !t.archived).length === 0 ? (
        <p className="text-sm text-slate-500">{tr("No dashboard templates yet.")}</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
          {templates
            .filter((t) => showArchived || !t.archived)
            .map((t) => (
              <li key={t.id} className={`flex flex-wrap items-center gap-3 px-3 py-2 ${t.archived ? 'opacity-60' : ''}`} data-setting={`template-${t.id}`}>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{t.name}</span>
                  {t.locked && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs">{tr("Locked")}</span>}
                  <span className="block text-xs text-slate-500">
                    {t.widgets.length} {tr("widgets · For:")} {forText(t)}
                  </span>
                </span>
                <button type="button" className={secondaryButtonClass} onClick={() => setEdit(t)}>
                  {ACTION.edit}
                </button>
                <button type="button" className={secondaryButtonClass} onClick={() => setAssign(t)}>
                  {tr("Who Gets It")}
                </button>
                <button type="button" className={secondaryButtonClass} disabled={t.archived} onClick={() => giveNow(t)}>
                  {tr("Give It Now")}
                </button>
                <button type="button" className={secondaryButtonClass} onClick={() => archive(t)}>
                  {t.archived ? ACTION.restore : ACTION.archive}
                </button>
              </li>
            ))}
        </ul>
      )}
      {assign && <AssignDialog template={assign} targets={targets} people={people} onClose={() => setAssign(null)} onSaved={load} />}
    </div>
  )
}

function AssignDialog({ template, targets, people, onClose, onSaved }: { template: Template; targets: Target[]; people: { email: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const { departments } = useDepartments()
  const mine = targets.filter((t) => t.template_id === template.id)
  const [users, setUsers] = useState<string[]>(mine.filter((t) => t.target_type === 'user').map((t) => t.target))
  const [depts, setDepts] = useState<string[]>(mine.filter((t) => t.target_type === 'department').map((t) => t.target))
  async function save() {
    if (!supabase) return
    const list = [...users.map((u) => ({ type: 'user', target: u })), ...depts.map((d) => ({ type: 'department', target: d }))]
    const { error } = await supabase.rpc('set_dashboard_template_targets', { p_template: template.id, p_targets: list })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Saved. People without a dashboard get it when they open the Dashboard; select “Give It Now” to give it to everyone now."))
    onSaved()
    onClose()
  }
  const toggle = (list: string[], set: (l: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  return (
    <Modal
      title={tr("Who Gets “{{name}}”", { name: template.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={save}>
            {ACTION.save}
          </button>
        </>
      }
    >
      <div className="grid gap-4 text-sm sm:grid-cols-2">
        <fieldset>
          <legend className="mb-1 font-medium">{tr("Departments")}</legend>
          {departments
            .filter((d) => !d.archived)
            .map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <input type="checkbox" checked={depts.includes(d.id)} onChange={() => toggle(depts, setDepts, d.id)} />
                {d.name}
              </label>
            ))}
        </fieldset>
        <fieldset className="max-h-72 overflow-y-auto">
          <legend className="mb-1 font-medium">{tr("People")}</legend>
          {people.map((p) => (
            <label key={p.email} className="flex items-center gap-2">
              <input type="checkbox" checked={users.includes(p.email)} onChange={() => toggle(users, setUsers, p.email)} />
              {p.name}
            </label>
          ))}
        </fieldset>
      </div>
    </Modal>
  )
}
