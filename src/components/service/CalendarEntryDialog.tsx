// @permission-scope service.calendar
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass, Switch } from '../form'
import { useAuth } from '../../lib/auth'
import { hfxParts, hfxToIso, inputToMinutes, minutesToInput } from '../../lib/calendarTime'
import { confirmAction } from '../../lib/confirm'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import { tr } from '../../i18n'

export type EntryKind = 'onsite' | 'travel' | 'training' | 'other'
export type Share = { type: 'user' | 'group' | 'department'; target: string; name?: string }
export type ManualEntry = {
  id: string
  tech_email: string
  kind: EntryKind
  customer_id: string | null
  customer_text: string | null
  start_date: string
  end_date: string
  notes: string | null
  title: string | null
  all_day: boolean
  starts_at: string | null
  ends_at: string | null
  /** 0053 */
  visibility?: 'private' | 'shared'
  order_id?: string | null
  order_code?: string | null
  done_at?: string | null
  done_by_name?: string | null
  owner_name?: string
  editable?: boolean
  shares?: Share[]
}

type Choices = { people: { email: string; name: string }[]; groups: { id: string; name: string }[]; departments: { id: string; name: string }[] }
const SERVICE_KINDS: EntryKind[] = ['onsite', 'travel', 'training']
const KIND_LABEL: Record<EntryKind, string> = { other: 'Appointment', onsite: 'On site', travel: 'Travel', training: 'Training' }

/** What a click on the calendar fills in for a new entry. */
export type EntryPreset = { start_date: string; end_date: string; all_day: boolean; start_min?: number; end_min?: number }

/** A calendar entry: kind, title, customer, all day or a start and end time, notes, private or shared (people, groups, departments), and for service entries an order. */
export default function CalendarEntryDialog({
  entry,
  preset,
  people,
  defaultTech,
  onClose,
  onSaved,
}: {
  entry: ManualEntry | null
  preset?: EntryPreset | null
  people: { email: string; name: string }[]
  defaultTech: string
  onClose: () => void
  onSaved: () => void
}) {
  const { can } = usePermissions()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const manage = can('service.calendar.manage', 'edit')
  const service = can('service')
  const [f, setF] = useState({
    tech_email: entry?.tech_email ?? (manage ? defaultTech || me : me),
    kind: entry?.kind ?? ('other' as EntryKind),
    visibility: entry?.visibility ?? ('private' as 'private' | 'shared'),
    order_id: entry?.order_id ?? '',
    title: entry?.title ?? '',
    customer_text: entry?.customer_text ?? '',
    all_day: entry ? entry.all_day !== false : (preset?.all_day ?? true),
    start_date: entry?.starts_at && !entry.all_day ? hfxParts(entry.starts_at).date : (entry?.start_date ?? preset?.start_date ?? todayISO()),
    end_date: entry?.ends_at && !entry.all_day ? hfxParts(entry.ends_at).date : (entry?.end_date ?? preset?.end_date ?? preset?.start_date ?? todayISO()),
    start_time: minutesToInput(entry?.starts_at && !entry.all_day ? hfxParts(entry.starts_at).minutes : (preset?.start_min ?? 9 * 60)),
    end_time: minutesToInput(entry?.ends_at && !entry.all_day ? hfxParts(entry.ends_at).minutes : (preset?.end_min ?? 10 * 60)),
    notes: entry?.notes ?? '',
  })
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [shares, setShares] = useState<Share[]>(entry?.shares ?? [])
  // A new service or training entry starts shared with the Service / Training team.
  const [team, setTeam] = useState<Share[]>([])
  const [choices, setChoices] = useState<Choices>({ people: [], groups: [], departments: [] })
  const [orders, setOrders] = useState<{ order_id: string; order_code: string; customer_name: string | null }[]>([])
  const [adding, setAdding] = useState<{ type: Share['type']; target: string }>({ type: 'user', target: '' })
  const mayEdit = entry ? entry.editable !== false : true
  const mayShare = can('service.calendar.share', 'edit')
  const nameOf = (x: Share) =>
    x.name ??
    (x.type === 'user'
      ? choices.people.find((p) => p.email === x.target)?.name
      : x.type === 'group'
        ? `Group: ${choices.groups.find((g) => g.id === x.target)?.name ?? ''}`
        : `Department: ${choices.departments.find((d) => d.id === x.target)?.name ?? ''}`) ??
    x.target

  useEffect(() => {
    if (!supabase) return
    supabase.rpc('calendar_share_choices').then(({ data }) => data && setChoices(data as Choices))
    supabase.rpc('calendar_settings').then(({ data }) => {
      const t = (((data as { service_team?: { type: Share['type']; target: string }[] } | null)?.service_team) ?? []).map((x) => ({ type: x.type, target: x.target }))
      setTeam(t)
    })
    if (service)
      supabase
        .from('order_service_info')
        .select('order_id, order_code, customer_name, training_needed, technician_email, service_start, archived, stage')
        .eq('archived', false)
        .neq('stage', 'Cancelled')
        .order('order_number', { ascending: false })
        .limit(300)
        .then(({ data }) =>
          setOrders(
            ((data as { order_id: string; order_code: string; customer_name: string | null; training_needed: boolean; technician_email: string | null; service_start: string | null }[] | null) ?? []).filter(
              (o) => o.training_needed || o.technician_email || o.service_start,
            ),
          ),
        )
  }, [service])

  /** Changing the kind of a new entry: service kinds are shared with the team, others start private. */
  function setKind(k: EntryKind) {
    if (!entry && SERVICE_KINDS.includes(k) && f.kind === 'other' && team.length) {
      setF({ ...f, kind: k, visibility: 'shared' })
      if (!shares.length) setShares(team)
    } else setF({ ...f, kind: k })
  }

  useEffect(() => {
    supabase
      ?.from('customer_list')
      .select('id, name')
      .eq('archived', false)
      .order('name')
      .limit(1000)
      .then(({ data }) => setCustomers((data as { id: string; name: string }[] | null) ?? []))
  }, [])

  async function save() {
    if (!supabase) return
    if (!f.start_date || !f.end_date) return toast.error(tr("Enter the dates."))
    if (f.end_date < f.start_date) return toast.error(tr("The end date must be on or after the start date."))
    const startsAt = f.all_day ? null : hfxToIso(f.start_date, inputToMinutes(f.start_time))
    const endsAt = f.all_day ? null : hfxToIso(f.end_date, inputToMinutes(f.end_time))
    if (startsAt && endsAt && endsAt <= startsAt) return toast.error(tr("The end time must be after the start time."))
    if (f.visibility === 'shared' && !shares.length) return toast.error(tr("Choose who the entry is shared with, or make it private."))
    const match = customers.find((c) => c.name.toLowerCase() === f.customer_text.trim().toLowerCase())
    const row = {
      ...(entry ? { id: entry.id } : {}),
      visibility: f.visibility,
      shares: f.visibility === 'shared' ? shares.map((x) => ({ type: x.type, target: x.target })) : [],
      order_id: f.kind !== 'other' && f.order_id ? f.order_id : null,
      tech_email: f.tech_email,
      kind: f.kind,
      title: f.title.trim() || null,
      customer_id: match?.id ?? null,
      customer_text: f.customer_text.trim() || null,
      all_day: f.all_day,
      starts_at: startsAt,
      ends_at: endsAt,
      start_date: f.start_date,
      end_date: f.end_date,
      notes: f.notes.trim() || null,
    }
    setSaving(true)
    const { error } = await supabase.rpc('save_calendar_entry', { p: row })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Calendar entry saved."))
    onSaved()
  }

  async function archive() {
    if (!supabase || !entry) return
    if (!(await confirmAction(tr("Archive this calendar entry? It disappears from the calendar and the phone calendar."), { get confirmLabel() {
    return tr("Archive")
  }, danger: true }))) return
    const { error } = await supabase.rpc('archive_calendar_entry', { p_entry: entry.id })
    if (error) return toast.error(friendlyError(error))
    onSaved()
  }

  return (
    <Modal
      title={entry ? (mayEdit ? tr("Edit Calendar Entry") : tr("Calendar Entry")) : tr("Add a Calendar Entry")}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          {entry && mayEdit && (
            <button type="button" className="mr-auto text-sm text-red-700 underline" onClick={archive}>
              {tr("Archive")}
            </button>
          )}
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            {tr("Cancel")}
          </button>
          {mayEdit && (
            <button type="button" className={buttonClass} onClick={save} disabled={saving}>
              {saving ? tr("Saving…") : tr("Save Changes")}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Can permission="service.calendar.manage" level="edit">
          <Field label={tr("Whose calendar")} htmlFor="ce-tech">
            <select
              id="ce-tech"
              className={inputClass}
              value={f.tech_email}
              disabled={!mayEdit || (!!entry && entry.tech_email !== me)}
              onChange={(e) => setF({ ...f, tech_email: e.target.value, visibility: e.target.value !== me ? 'shared' : f.visibility })}
            >
              {!people.some((p) => p.email === f.tech_email) && <option value={f.tech_email}>{f.tech_email}</option>}
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </Can>
        {entry?.owner_name && entry.tech_email !== me && (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {tr("On")} {entry.owner_name}{tr("’s calendar")}{mayEdit ? '' : tr(", shared with you. Only its owner can change it.")}
          </p>
        )}
        {entry?.done_at && (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900">
            {tr("Done")}{entry.done_by_name ? ` (${entry.done_by_name})` : ''}{tr(": the training of this order was marked as done.")}
          </p>
        )}
        {(service || f.kind !== 'other') && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={tr("Kind of entry")}>
            {(['other', ...SERVICE_KINDS] as EntryKind[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={f.kind === k}
                disabled={!mayEdit || (k !== 'other' && !service)}
                className={`rounded-md border px-3 py-2 text-sm font-medium ${f.kind === k ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                onClick={() => setKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        <Field label={tr("Title")} htmlFor="ce-title" hint={tr("Optional. Without a title the entry shows its kind and the customer.")}>
          <input id="ce-title" className={inputClass} maxLength={200} value={f.title} disabled={!mayEdit} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label={tr("Customer")} htmlFor="ce-customer" hint={tr("Pick from the list or type any name.")}>
          <input
            id="ce-customer"
            list="ce-customers"
            className={inputClass}
            value={f.customer_text}
            disabled={!mayEdit}
            onChange={(e) => setF({ ...f, customer_text: e.target.value })}
          />
          <datalist id="ce-customers">
            {customers.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">
            {tr("All day")}
          </span>
          <Switch checked={f.all_day} label={tr("All day")} disabled={!mayEdit} onChange={(on) => setF({ ...f, all_day: on })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr("From")} htmlFor="ce-start">
            <input
              id="ce-start"
              type="date"
              className={inputClass}
              value={f.start_date}
              disabled={!mayEdit}
              onChange={(e) => setF({ ...f, start_date: e.target.value, end_date: f.end_date < e.target.value ? e.target.value : f.end_date })}
            />
          </Field>
          <Field label={tr("Until")} htmlFor="ce-end">
            <input id="ce-end" type="date" className={inputClass} value={f.end_date} min={f.start_date} disabled={!mayEdit} onChange={(e) => setF({ ...f, end_date: e.target.value })} />
          </Field>
          {!f.all_day && (
            <>
              <Field label={tr("Start time")} htmlFor="ce-start-time">
                <input
                  id="ce-start-time"
                  type="time"
                  step={900}
                  className={inputClass}
                  value={f.start_time}
                  disabled={!mayEdit}
                  onChange={(e) => {
                    // Keep the length when the start moves (like a phone calendar).
                    const len = inputToMinutes(f.end_time) - inputToMinutes(f.start_time)
                    const start = inputToMinutes(e.target.value)
                    const end = f.start_date === f.end_date && len > 0 ? Math.min(start + len, 23 * 60 + 45) : inputToMinutes(f.end_time)
                    setF({ ...f, start_time: e.target.value, end_time: minutesToInput(end) })
                  }}
                />
              </Field>
              <Field label={tr("End time")} htmlFor="ce-end-time">
                <input id="ce-end-time" type="time" step={900} className={inputClass} value={f.end_time} disabled={!mayEdit} onChange={(e) => setF({ ...f, end_time: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        {!f.all_day && <p className="text-xs text-slate-500">{tr("Times are Halifax time.")}</p>}
        {f.kind !== 'other' && service && (
          <Field label={tr("Order")} htmlFor="ce-order" hint={tr("Optional. “Mark Training as Done” on the order also completes its linked entries.")}>
            <select id="ce-order" className={inputClass} value={f.order_id ?? ''} disabled={!mayEdit} onChange={(e) => setF({ ...f, order_id: e.target.value })}>
              <option value="">{tr("No order")}</option>
              {entry?.order_id && !orders.some((o) => o.order_id === entry.order_id) && <option value={entry.order_id}>{tr("Order")} {entry.order_code ?? ''}</option>}
              {orders.map((o) => (
                <option key={o.order_id} value={o.order_id}>
                  {tr("Order")} {o.order_code}
                  {o.customer_name ? ` – ${o.customer_name}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <fieldset className="space-y-2" data-setting="calendar-visibility">
          <legend className="text-sm font-medium">{tr("Who Sees It")}</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={tr("Who sees it")}>
            {(['private', 'shared'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={f.visibility === v}
                disabled={!mayEdit || (v === 'private' && f.tech_email !== me)}
                className={`rounded-md border px-3 py-2 text-left text-sm ${f.visibility === v ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                onClick={() => {
                  setF({ ...f, visibility: v })
                  if (v === 'shared' && !shares.length && SERVICE_KINDS.includes(f.kind)) setShares(team)
                }}
              >
                <span className="block font-medium">{v === 'private' ? tr("Private") : tr("Shared")}</span>
                <span className={`block text-xs ${f.visibility === v ? 'text-slate-200' : 'text-slate-500'}`}>
                  {v === 'private' ? tr("Only you. Nobody else, admins included.") : tr("Also on the calendars of the people chosen.")}
                </span>
              </button>
            ))}
          </div>
          {f.visibility === 'shared' && (
            <div className="space-y-2">
              {shares.length === 0 ? (
                <p className="text-xs text-slate-500">{tr("Not shared with anyone yet.")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {shares.map((x) => (
                    <li key={`${x.type}:${x.target}`} className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                      {nameOf(x)}
                      {mayEdit && (
                        <button type="button" aria-label={tr("Remove {{nameOf}}", { nameOf: nameOf(x) })} className="text-slate-500 hover:text-red-700" onClick={() => setShares(shares.filter((y) => y !== x))}>
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {mayEdit && (
                <Can
                  permission="service.calendar.share"
                  level="edit"
                  fallback={
                    <p className="text-xs text-slate-500">
                      {SERVICE_KINDS.includes(f.kind) ? tr("Service and training entries are shared with the Service / Training team.") : tr("Ask an admin to allow sharing with other people.")}
                    </p>
                  }
                >
                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label={tr("Share with")}
                      className={`${narrowInputClass} w-36`}
                      value={adding.type}
                      onChange={(e) => setAdding({ type: e.target.value as Share['type'], target: '' })}
                    >
                      <option value="user">{tr("A person")}</option>
                      <option value="group">{tr("A group")}</option>
                      <option value="department">{tr("A department")}</option>
                    </select>
                    <select aria-label={tr("Which")} className={`${narrowInputClass} min-w-40 flex-1`} value={adding.target} onChange={(e) => setAdding({ ...adding, target: e.target.value })}>
                      <option value="">{tr("Select…")}</option>
                      {(adding.type === 'user'
                        ? choices.people.filter((p) => p.email !== f.tech_email).map((p) => ({ id: p.email, name: p.name }))
                        : adding.type === 'group'
                          ? choices.groups
                          : choices.departments
                      ).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      disabled={!adding.target || !mayShare}
                      onClick={() => {
                        if (!shares.some((x) => x.type === adding.type && x.target === adding.target)) setShares([...shares, { type: adding.type, target: adding.target }])
                        setAdding({ ...adding, target: '' })
                      }}
                    >
                      {tr("Add")}
                    </button>
                    {team.length > 0 && (
                      <button
                        type="button"
                        className="text-xs text-blue-700 underline"
                        onClick={() => setShares([...shares, ...team.filter((t) => !shares.some((x) => x.type === t.type && x.target === t.target))])}
                      >
                        {tr("Add the Service / Training Team")}
                      </button>
                    )}
                  </div>
                </Can>
              )}
            </div>
          )}
        </fieldset>
        <Field label={tr("Notes")} htmlFor="ce-notes">
          <textarea id="ce-notes" rows={3} className={inputClass} value={f.notes} disabled={!mayEdit} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
