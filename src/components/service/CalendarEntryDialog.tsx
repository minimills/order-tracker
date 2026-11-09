// @permission-scope service.calendar
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import { useAuth } from '../../lib/auth'
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
}

/** A technician's own calendar entry: customer, dates, on site or travel, notes. */
export default function CalendarEntryDialog({
  entry,
  people,
  defaultTech,
  onClose,
  onSaved,
}: {
  entry: ManualEntry | null
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
    customer_text: entry?.customer_text ?? '',
    start_date: entry?.start_date ?? todayISO(),
    end_date: entry?.end_date ?? todayISO(),
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
    const match = customers.find((c) => c.name.toLowerCase() === f.customer_text.trim().toLowerCase())
    const row = {
      tech_email: f.tech_email,
      kind: f.kind,
      customer_id: match?.id ?? null,
      customer_text: f.customer_text.trim() || null,
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
      title={entry ? 'Calendar Entry' : 'Add a Calendar Entry'}
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
        </div>
        <Field label="Notes" htmlFor="ce-notes">
          <textarea id="ce-notes" rows={3} className={inputClass} value={f.notes} disabled={!mayEdit} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
