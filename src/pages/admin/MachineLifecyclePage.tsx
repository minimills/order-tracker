// @permission-scope admin.machine_lifecycle
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, cardGridClass, inputClass, narrowInputClass, secondaryButtonClass } from '../../components/form'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { loadLifecycleSettings, type ItemKind, type LifecycleSettings } from '../../lib/machines'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'

const STEPS = [
  { value: 'other', label: 'Other work' },
  { value: 'sandblasting', label: 'Sandblasting' },
  { value: 'powder_coating', label: 'Powder coating' },
  { value: 'assembly', label: 'Assembly' },
  { value: 'final_check', label: 'Final check' },
]
type Item = { id: string; machine_type_id: string | null; stage: string; item_text: string; sort_order: number; archived: boolean }
type MachineType = { id: string; name: string }
const small = 'rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40'

/** Admin → Machine Lifecycle: warranty lengths, refurbishment stages and checklists, notes on documents. */
export default function MachineLifecyclePage() {
  const [s, setS] = useState<LifecycleSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const [types, setTypes] = useState<MachineType[]>([])
  const [typeId, setTypeId] = useState('')
  const [draft, setDraft] = useState({ stage: '', text: '' })

  const loadItems = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('refurb_checklist_items').select('id, machine_type_id, stage, item_text, sort_order, archived').eq('archived', false).order('stage').order('sort_order')
    setItems((data as Item[]) ?? [])
  }, [])
  useEffect(() => {
    loadLifecycleSettings().then(setS)
    supabase
      ?.from('machine_types')
      .select('id, name')
      .eq('archived', false)
      .order('name')
      .then(({ data }) => setTypes((data as MachineType[]) ?? []))
    // loadItems() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    loadItems()
  }, [loadItems])

  if (!s) return <p className="text-sm text-slate-500">Loading…</p>

  async function save() {
    if (!supabase || !s) return
    setSaving(true)
    const { data, error } = await supabase.rpc('set_machine_lifecycle_settings', { p: s })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    setS(data as LifecycleSettings)
    toast.success('Machine lifecycle settings saved.')
  }
  const stages = s.refurb_stages
  const setStage = (i: number, patch: Partial<{ name: string; step: string }>) => setS({ ...s, refurb_stages: stages.map((x, k) => (k === i ? { ...x, ...patch } : x)) })
  const moveStage = (i: number, d: -1 | 1) => {
    const list = [...stages]
    ;[list[i], list[i + d]] = [list[i + d], list[i]]
    setS({ ...s, refurb_stages: list })
  }
  const shownItems = items.filter((i) => (i.machine_type_id ?? '') === typeId)

  async function addItem() {
    if (!supabase || !draft.stage || !draft.text.trim()) return
    const sort = Math.max(0, ...shownItems.filter((i) => i.stage === draft.stage).map((i) => i.sort_order)) + 1
    const { error } = await supabase.from('refurb_checklist_items').insert({ machine_type_id: typeId || null, stage: draft.stage, item_text: draft.text.trim(), sort_order: sort })
    if (error) return toast.error(friendlyError(error))
    setDraft({ ...draft, text: '' })
    loadItems()
  }
  async function archiveItem(i: Item) {
    if (!supabase || !(await confirmAction(`Archive “${i.item_text}”? New refurbishments will not get it.`, { confirmLabel: ACTION.archive }))) return
    const { error } = await supabase.from('refurb_checklist_items').update({ archived: true }).eq('id', i.id)
    if (error) return toast.error(friendlyError(error))
    loadItems()
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader title="Machine Lifecycle">
        Warranty for new, refurbished and used machines, the stages and checklists of a refurbishment, and whether documents of a refurbished machine say which serial it was refurbished from.
      </AdminPageHeader>

      <div className={cardGridClass}>
        <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="warranty">
          <h2 className="mb-2 font-semibold">Warranty (months)</h2>
          <p className="mb-2 text-xs text-slate-500">Starts on the ship date of the order the machine was sold on. 0 = no warranty. A machine can have its own length on its page.</p>
          {(['new', 'refurbished', 'used'] as ItemKind[]).map((k) => (
            <label key={k} className="mb-2 flex items-center justify-between gap-3">
              <span>{k === 'new' ? 'New machines' : k === 'refurbished' ? 'Refurbished machines' : 'Used machines (sold as they are)'}</span>
              <input
                inputMode="numeric"
                className={`${narrowInputClass} w-20`}
                value={s.warranty[k]}
                onChange={(e) => setS({ ...s, warranty: { ...s.warranty, [k]: Number(e.target.value) || 0 } })}
              />
            </label>
          ))}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="refurb-documents">
          <h2 className="mb-2 font-semibold">Documents of Refurbished Machines</h2>
          <p className="mb-2 text-xs text-slate-500">They always use the new serial (for example LCR-2073-R). When enabled, they also say “Refurbished from LCR-2073”.</p>
          <label className="mb-2 flex items-center gap-2">
            <input type="checkbox" checked={s.refurb_note.ce} onChange={(e) => setS({ ...s, refurb_note: { ...s.refurb_note, ce: e.target.checked } })} /> CE Declarations of Conformity
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.refurb_note.commissioning} onChange={(e) => setS({ ...s, refurb_note: { ...s.refurb_note, commissioning: e.target.checked } })} /> Commissioning certificates
          </label>
          <h3 className="mt-4 mb-1 font-medium">Who can open refurbishment boards</h3>
          <select className={inputClass} value={s.refurb_share_level} onChange={(e) => setS({ ...s, refurb_share_level: e.target.value as LifecycleSettings['refurb_share_level'] })}>
            <option value="edit">Everyone with Boards (work on the cards)</option>
            <option value="view">Everyone with Boards (view only)</option>
            <option value="none">Only the person who started it and admins</option>
          </select>
        </section>
      </div>

      <section className="max-w-3xl rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="refurb-stages">
        <h2 className="mb-2 font-semibold">Refurbishment Stages</h2>
        <p className="mb-2 text-xs text-slate-500">New refurbishments get these stages on their board. The kind tells reports what the stage is; the last “Final check” stage is where the final check is signed.</p>
        <ul className="space-y-2">
          {stages.map((st, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <input aria-label="Stage name" className={`${narrowInputClass} min-w-0 flex-1`} value={st.name} onChange={(e) => setStage(i, { name: e.target.value })} />
              <select aria-label="Kind of stage" className={narrowInputClass} value={st.step} onChange={(e) => setStage(i, { step: e.target.value })}>
                {STEPS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
              <button type="button" className={small} disabled={i === 0} onClick={() => moveStage(i, -1)} aria-label={`Move ${st.name} up`}>
                ↑
              </button>
              <button type="button" className={small} disabled={i === stages.length - 1} onClick={() => moveStage(i, 1)} aria-label={`Move ${st.name} down`}>
                ↓
              </button>
              <button type="button" className={small} disabled={stages.length === 1} onClick={() => setS({ ...s, refurb_stages: stages.filter((_, k) => k !== i) })} aria-label={`Remove ${st.name}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className={`${secondaryButtonClass} mt-2`} onClick={() => setS({ ...s, refurb_stages: [...stages, { name: 'New stage', step: 'other' }] })}>
          Add Stage
        </button>
      </section>

      <button type="button" className={buttonClass} onClick={save} disabled={saving}>
        {saving ? ACTION.saving : ACTION.save}
      </button>

      <section className="max-w-3xl rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="refurb-checklists">
        <h2 className="mb-2 font-semibold">Refurbishment Checklists</h2>
        <p className="mb-2 text-xs text-slate-500">Tasks copied onto a new refurbishment’s card, per stage: the general list for every machine, then the extras of its machine type. Stages match by name.</p>
        <select aria-label="Checklist for" className={`${inputClass} mb-3`} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">General (every machine)</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              Extras for {t.name}
            </option>
          ))}
        </select>
        {stages.map((st) => {
          const list = shownItems.filter((i) => i.stage.toLowerCase() === st.name.toLowerCase())
          return (
            <div key={st.name} className="mb-3">
              <h3 className="font-medium">{st.name}</h3>
              {list.length === 0 ? (
                <p className="text-xs text-slate-500">No tasks.</p>
              ) : (
                <ul className="ml-4 list-disc">
                  {list.map((i) => (
                    <li key={i.id}>
                      {i.item_text}{' '}
                      <button type="button" className="ml-2 text-xs underline" onClick={() => archiveItem(i)}>
                        {ACTION.archive}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
        <div className="flex flex-wrap gap-2">
          <select aria-label="Stage" className={narrowInputClass} value={draft.stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })}>
            <option value="">Stage…</option>
            {stages.map((st) => (
              <option key={st.name}>{st.name}</option>
            ))}
          </select>
          <input aria-label="Task" className={`${narrowInputClass} min-w-0 flex-1`} placeholder="Task" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <button type="button" className={buttonClass} disabled={!draft.stage || !draft.text.trim()} onClick={addItem}>
            Add Task
          </button>
        </div>
      </section>
    </div>
  )
}
