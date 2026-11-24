// @permission-scope admin.production
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import ColourPicker from '../../components/boards/ColourPicker'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { askText } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useDepartments } from '../../lib/useDepartments'
import { loadSetting } from '../../lib/useSchedule'
import { tr } from '../../i18n'

type TemplateStage = { id: string; name: string; step: string; department_id: string | null; sort_order: number; archived: boolean }
type Settings = { office_department_id: string | null; colour: string; share_level: 'view' | 'edit' | 'manage' }

const DEFAULTS: Settings = { office_department_id: null, colour: '#0f766e', share_level: 'edit' }
const COLOURS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#475569']

/** What each stage means for the app (deadline, build checklist, step times). */
const STAGE_STEPS: { step: string; label: string }[] = [
  { step: 'fabrication', get label() {
    return tr("Fabrication (build checklist, step time)")
  } },
  { step: 'pickup', get label() {
    return tr("Ready for pick up (waiting to go to location 2)")
  } },
  { step: 'sandblasting', get label() {
    return tr("Sandblasting (build checklist, step time)")
  } },
  { step: 'powder_coating', get label() {
    return tr("Powder coating (build checklist, step time)")
  } },
  { step: 'assembly', get label() {
    return tr("Assembly (build checklist, step time)")
  } },
  { step: 'final_check', get label() {
    return tr("Final check (opens the machine’s final check)")
  } },
  { step: 'crating', get label() {
    return tr("Crating (skipped when the machine needs no crate)")
  } },
  { step: 'shipping', get label() {
    return tr("Shipping (deadline = expected ship date)")
  } },
  { step: 'other', get label() {
    return tr("Other (no deadline or checklist)")
  } },
]

/** Admin → Production: the stages every new production board starts with, and board settings. */
export default function ProductionPage() {
  const { departments } = useDepartments()
  const [stages, setStages] = useState<TemplateStage[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [showArchived, setShowArchived] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase
      .from('production_stage_template')
      .select('id, name, step, department_id, sort_order, archived')
      .order('sort_order')
      .order('name')
    if (error) toast.error(friendlyError(error))
    setStages((data as TemplateStage[]) ?? [])
  }, [])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
    loadSetting('production', DEFAULTS).then(setSettings)
  }, [load])

  const active = stages.filter((s) => !s.archived)
  const shown = showArchived ? stages : active
  const liveDepartments = departments.filter((d) => !d.archived)

  async function update(s: TemplateStage, patch: Partial<TemplateStage>) {
    if (!supabase) return
    const { error } = await supabase.from('production_stage_template').update(patch).eq('id', s.id)
    if (error) return toast.error(friendlyError(error))
    load()
  }

  async function move(s: TemplateStage, dir: -1 | 1) {
    if (!supabase) return
    const list = [...active]
    const i = list.findIndex((x) => x.id === s.id)
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    const results = await Promise.all(list.map((x, n) => supabase!.from('production_stage_template').update({ sort_order: (n + 1) * 10 }).eq('id', x.id)))
    const failed = results.find((r) => r.error)
    if (failed?.error) toast.error(friendlyError(failed.error))
    load()
  }

  async function rename(s: TemplateStage) {
    const name = await askText(tr("Enter a new name for the stage “{{name}}”.", { name: s.name }), { initial: s.name, get label() {
    return tr("Stage name")
  }, get confirmLabel() {
    return tr("Rename Stage")
  } })
    if (name && name !== s.name) update(s, { name })
  }

  async function add() {
    if (!supabase) return
    if (!newName.trim()) return toast.error(tr("Type a name for the stage."))
    const max = Math.max(0, ...stages.map((s) => s.sort_order))
    const { error } = await supabase.from('production_stage_template').insert({ name: newName.trim(), step: 'other', sort_order: max + 10 })
    if (error) return toast.error(friendlyError(error))
    setNewName('')
    load()
  }

  async function saveSettings() {
    if (!supabase) return
    setSaving(true)
    const { error } = await supabase.from('app_settings').upsert({ key: 'production', value: settings })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Production settings saved."))
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader title={tr("Production")}>
        {tr("Each order gets its own production board when it is confirmed. These are the stages every new production board starts with. Each stage belongs to a department: that department can open the board and is notified when a machine arrives in its stage. Boards that already exist keep their stages; change those in the board’s own settings.")}
      </AdminPageHeader>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="font-semibold">{tr("Default Stages")}</h2>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            {tr("Show archived")}
          </label>
        </div>
        {shown.length === 0 && <p className="p-4 text-sm text-slate-500">{tr("No stages yet. Add the first one below.")}</p>}
        <ul className="divide-y divide-slate-100">
          {shown.map((s) => {
            const idx = active.findIndex((x) => x.id === s.id)
            return (
              <li key={s.id} className={`grid gap-2 px-4 py-3 text-sm xl:grid-cols-[1fr_14rem_16rem_auto] xl:items-center ${s.archived ? 'bg-slate-50 text-slate-400' : ''}`}>
                <span className="font-medium">{s.name}</span>
                <select
                  aria-label={tr("Department for {{name}}", { name: s.name })}
                  className={inputClass}
                  value={s.department_id ?? ''}
                  disabled={s.archived}
                  onChange={(e) => update(s, { department_id: e.target.value || null })}
                >
                  <option value="">{tr("No department")}</option>
                  {liveDepartments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <select aria-label={tr("What {{name}} means", { name: s.name })} className={inputClass} value={s.step} disabled={s.archived} onChange={(e) => update(s, { step: e.target.value })}>
                  {STAGE_STEPS.map((x) => (
                    <option key={x.step} value={x.step}>
                      {x.label}
                    </option>
                  ))}
                </select>
                {s.archived ? (
                  <button type="button" className="justify-self-start text-xs underline" onClick={() => update(s, { archived: false })}>
                    {tr("Restore")}
                  </button>
                ) : (
                  <span className="flex items-center gap-2 text-xs">
                    <button type="button" className="rounded border border-slate-300 px-1.5" disabled={idx === 0} onClick={() => move(s, -1)} aria-label={tr("Move {{name}} up", { name: s.name })}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="rounded border border-slate-300 px-1.5"
                      disabled={idx === active.length - 1}
                      onClick={() => move(s, 1)}
                      aria-label={tr("Move {{name}} down", { name: s.name })}
                    >
                      ↓
                    </button>
                    <button type="button" className="underline" onClick={() => rename(s)}>
                      {tr("Rename")}
                    </button>
                    <button type="button" className="text-red-700 underline" onClick={() => update(s, { archived: true })}>
                      {tr("Archive")}
                    </button>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        <div className="flex gap-2 border-t border-slate-200 p-4">
          <input
            aria-label={tr("New stage name")}
            className={inputClass}
            placeholder={tr("New stage, for example Electrical testing")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button type="button" className={buttonClass} onClick={add}>
            {tr("Add Stage")}
          </button>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">{tr("Board Settings")}</h2>
        <Field label={tr("Office department")} htmlFor="prod-office" hint={tr("Can manage every production board and is notified when a deadline is missed.")}>
          <select
            id="prod-office"
            className={inputClass}
            value={settings.office_department_id ?? ''}
            onChange={(e) => setSettings({ ...settings, office_department_id: e.target.value || null })}
          >
            <option value="">{tr("No department")}</option>
            {liveDepartments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr("What the stage departments may do on the board")} htmlFor="prod-level">
          <select id="prod-level" className={inputClass} value={settings.share_level} onChange={(e) => setSettings({ ...settings, share_level: e.target.value as Settings['share_level'] })}>
            <option value="view">{tr("View only")}</option>
            <option value="edit">{tr("Edit cards (move, Start / Finish, mark items complete)")}</option>
            <option value="manage">{tr("Manage (also settings and sharing)")}</option>
          </select>
        </Field>
        <Field label={tr("Board colour")} htmlFor="prod-colour">
          <ColourPicker colours={COLOURS} value={settings.colour} onChange={(colour) => setSettings({ ...settings, colour })} label={tr("Board colour")} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => loadSetting('production', DEFAULTS).then(setSettings)}>
            {tr("Undo Changes")}
          </button>
          <button type="button" className={buttonClass} disabled={saving} onClick={saveSettings}>
            {saving ? tr("Saving…") : tr("Save Changes")}
          </button>
        </div>
      </section>
    </div>
  )
}
