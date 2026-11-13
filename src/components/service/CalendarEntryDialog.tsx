// @permission-scope service.calendar
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass, Switch } from '../form'
import { useAuth } from '../../lib/auth'
import { hfxParts, hfxToIso, inputToMinutes, minutesToInput } from '../../lib/calendarTime'
import { confirmAction } from '../../lib/confirm'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'

export type ManualEntry = {
  id: string
  tech_email: string
  kind: 'onsite' | 'travel'
  customer_id: string | null
  customer_text: string | null
  start_date: string
  end_date: string
  notes: string | null
  title: string | null
  all_day: boolean
  starts_at: string | null
  ends_at: string | null
}

/** What a click on the calendar fills in for a new entry. */
export type EntryPreset = { start_date: string; end_date: string; all_day: boolean; start_min?: number; end_min?: number }

/** A technician's own calendar entry: title, customer, all day or a start and end time, on site or travel, notes. */
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
  const [f, setF] = useState({
    tech_email: entry?.tech_email ?? (manage ? defaultTech || me : me),
    kind: entry?.kind ?? ('onsite' as 'onsite' | 'travel'),
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
  const mayEdit = manage || (f.tech_email === me && can('service.calendar.add', 'edit'))

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
    if (!f.start_date || !f.end_date) return toast.error('Enter the dates.')
    if (f.end_date < f.start_date) return toast.error('The end date must be on or after the start date.')
    const startsAt = f.all_day ? null : hfxToIso(f.start_date, inputToMinutes(f.start_time))
    const endsAt = f.all_day ? null : hfxToIso(f.end_date, inputToMinutes(f.end_time))
    if (startsAt && endsAt && endsAt <= startsAt) return toast.error('The end time must be after the start time.')
    const match = customers.find((c) => c.name.toLowerCase() === f.customer_text.trim().toLowerCase())
    const row = {
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
    const { error } = entry ? await supabase.from('tech_calendar_entries').update(row).eq('id', entry.id) : await supabase.from('tech_calendar_entries').insert(row)
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Calendar entry saved.')
    onSaved()
  }

  async function archive() {
    if (!supabase || !entry) return
    if (!(await confirmAction('Archive this calendar entry? It disappears from the calendar and the phone calendar.', { confirmLabel: 'Archive', danger: true }))) return
    const { error } = await supabase.from('tech_calendar_entries').update({ archived: true }).eq('id', entry.id)
    if (error) return toast.error(friendlyError(error))
    onSaved()
  }

  return (
    <Modal
      title={entry ? (mayEdit ? 'Edit Calendar Entry' : 'Calendar Entry') : 'Add a Calendar Entry'}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          {entry && mayEdit && (
            <button type="button" className="mr-auto text-sm text-red-700 underline" onClick={archive}>
              Archive
            </button>
          )}
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {mayEdit && (
            <button type="button" className={buttonClass} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Can permission="service.calendar.manage" level="edit">
          <Field label="Technician" htmlFor="ce-tech">
            <select id="ce-tech" className={inputClass} value={f.tech_email} disabled={!mayEdit} onChange={(e) => setF({ ...f, tech_email: e.target.value })}>
              {!people.some((p) => p.email === f.tech_email) && <option value={f.tech_email}>{f.tech_email}</option>}
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </Can>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Kind of day">
          {(['onsite', 'travel'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={f.kind === k}
              disabled={!mayEdit}
              className={`rounded-md border px-3 py-2 text-sm font-medium ${f.kind === k ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
              onClick={() => setF({ ...f, kind: k })}
            >
              {k === 'onsite' ? 'On site' : 'Travel'}
            </button>
          ))}
        </div>
        <Field label="Title" htmlFor="ce-title" hint="Optional. Without a title the entry shows “On site” or “Travel” and the customer.">
          <input id="ce-title" className={inputClass} maxLength={200} value={f.title} disabled={!mayEdit} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Customer" htmlFor="ce-customer" hint="Pick from the list or type any name.">
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
            All day
          </span>
          <Switch checked={f.all_day} label="All day" disabled={!mayEdit} onChange={(on) => setF({ ...f, all_day: on })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="ce-start">
            <input
              id="ce-start"
              type="date"
              className={inputClass}
              value={f.start_date}
              disabled={!mayEdit}
              onChange={(e) => setF({ ...f, start_date: e.target.value, end_date: f.end_date < e.target.value ? e.target.value : f.end_date })}
            />
          </Field>
          <Field label="Until" htmlFor="ce-end">
            <input id="ce-end" type="date" className={inputClass} value={f.end_date} min={f.start_date} disabled={!mayEdit} onChange={(e) => setF({ ...f, end_date: e.target.value })} />
          </Field>
          {!f.all_day && (
            <>
              <Field label="Start time" htmlFor="ce-start-time">
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
              <Field label="End time" htmlFor="ce-end-time">
                <input id="ce-end-time" type="time" step={900} className={inputClass} value={f.end_time} disabled={!mayEdit} onChange={(e) => setF({ ...f, end_time: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        {!f.all_day && <p className="text-xs text-slate-500">Times are Halifax time.</p>}
        <Field label="Notes" htmlFor="ce-notes">
          <textarea id="ce-notes" rows={3} className={inputClass} value={f.notes} disabled={!mayEdit} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
