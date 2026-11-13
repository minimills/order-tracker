// @permission-scope order.section.service
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass, Section } from '../form'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { serviceDates, type ServiceInfo } from '../../lib/service'
import { supabase } from '../../lib/supabase'

const FIELD_KEYS = ['order.field.training_needed', 'order.field.training_days', 'order.field.travel_days', 'order.field.technician', 'order.field.service_dates']

/* @layout-helper */
function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

const days = (n: number | null) => (n === null ? '—' : `${n} day${n === 1 ? '' : 's'}`)

/** Order page: on-site training and commissioning plan, with a link to the service log. */
export default function OrderServiceSection({ orderId }: { orderId: string }) {
  const [info, setInfo] = useState<ServiceInfo | null>(null)
  const [editing, setEditing] = useState(false)
  const { canAny } = usePermissions()

  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('order_service_info').select('*').eq('order_id', orderId).maybeSingle()
    setInfo((data as ServiceInfo | null) ?? null)
  }, [orderId])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (!info) return null
  return (
    <Section
      title="Service / Training"
      aside={
        <div className="flex flex-wrap gap-2">
          <Can permission="service">
            <Link to={`/service/${orderId}`} className={secondaryButtonClass}>
              Open Service Log
            </Link>
          </Can>
          {canAny(FIELD_KEYS, 'edit') && (
            <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)}>
              Edit Service
            </button>
          )}
        </div>
      }
    >
      <dl className="grid grid-cols-2 gap-4">
        <Can permission="order.field.training_needed">
          <Item label="Training needed">{info.training_needed ? 'Needed' : 'Not needed'}</Item>
        </Can>
        <Can permission="order.field.technician">
          <Item label="Technician">{info.technician_name ?? <span className="text-slate-400">Not assigned</span>}</Item>
        </Can>
        <Can permission="order.field.training_days">
          <Item label="On-site training days">{days(info.training_days)}</Item>
        </Can>
        <Can permission="order.field.travel_days">
          <Item label="Travel days">{days(info.travel_days)}</Item>
        </Can>
        <Can permission="order.field.service_dates">
          <Item label="Planned dates">{serviceDates(info.service_start, info.service_end) || <span className="text-slate-400">Not planned</span>}</Item>
        </Can>
        <Can permission="service.log">
          <Item label="Service log">
            {info.entries ? `${info.entries} day${info.entries === 1 ? '' : 's'}, ${Number(info.hours)} hours` : <span className="text-slate-400">No days logged</span>}
          </Item>
        </Can>
      </dl>
      {editing && (
        <ServiceFieldsDialog
          info={info}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            load()
          }}
        />
      )}
    </Section>
  )
}

/** Change the service plan (each field has its own permission). */
function ServiceFieldsDialog({ info, onClose, onSaved }: { info: ServiceInfo; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    training_needed: info.training_needed,
    training_days: info.training_days === null ? '' : String(info.training_days),
    travel_days: info.travel_days === null ? '' : String(info.travel_days),
    technician_email: info.technician_email ?? '',
    service_start: info.service_start ?? '',
    service_end: info.service_end ?? '',
  })
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)
  const { can } = usePermissions()

  useEffect(() => {
    supabase?.rpc('technician_choices').then(({ data }) => setPeople((data as { email: string; name: string }[] | null) ?? []))
  }, [])

  async function save() {
    if (!supabase) return
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    for (const v of [f.training_days, f.travel_days]) {
      if (v.trim() !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0)) return toast.error('Days must be a number of 0 or more.')
    }
    if (f.service_start && f.service_end && f.service_end < f.service_start) return toast.error('The end date must be on or after the start date.')
    const patch: Record<string, unknown> = {}
    if (can('order.field.training_needed', 'edit')) patch.training_needed = f.training_needed
    if (can('order.field.training_days', 'edit')) patch.training_days = num(f.training_days)
    if (can('order.field.travel_days', 'edit')) patch.travel_days = num(f.travel_days)
    if (can('order.field.technician', 'edit')) patch.technician_email = f.technician_email || null
    if (can('order.field.service_dates', 'edit')) {
      patch.service_start = f.service_start || null
      patch.service_end = f.service_end || null
    }
    setSaving(true)
    const { error } = await supabase.from('orders').update(patch).eq('id', info.order_id)
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Service details saved.')
    onSaved()
  }

  return (
    <Modal
      title={`Service for Order ${info.order_code}`}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Can permission="order.field.training_needed" level="edit">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={f.training_needed} onChange={(e) => setF({ ...f, training_needed: e.target.checked })} />
            On-site training and commissioning needed
          </label>
        </Can>
        <Can permission="order.field.training_days" level="edit">
          <Field label="On-site training days" htmlFor="sv-training">
            <input id="sv-training" inputMode="decimal" className={inputClass} value={f.training_days} onChange={(e) => setF({ ...f, training_days: e.target.value })} />
          </Field>
        </Can>
        <Can permission="order.field.travel_days" level="edit">
          <Field label="Travel days" htmlFor="sv-travel">
            <input id="sv-travel" inputMode="decimal" className={inputClass} value={f.travel_days} onChange={(e) => setF({ ...f, travel_days: e.target.value })} />
          </Field>
        </Can>
        <Can permission="order.field.technician" level="edit">
          <Field label="Technician" htmlFor="sv-tech" className="sm:col-span-2">
            <select id="sv-tech" className={inputClass} value={f.technician_email} onChange={(e) => setF({ ...f, technician_email: e.target.value })}>
              <option value="">Not assigned</option>
              {f.technician_email && !people.some((p) => p.email === f.technician_email) && <option value={f.technician_email}>{info.technician_name ?? f.technician_email}</option>}
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </Can>
        <Can permission="order.field.service_dates" level="edit">
          <Field label="Planned start" htmlFor="sv-start">
            <input id="sv-start" type="date" className={inputClass} value={f.service_start} onChange={(e) => setF({ ...f, service_start: e.target.value })} />
          </Field>
          <Field label="Planned end" htmlFor="sv-end">
            <input id="sv-end" type="date" className={inputClass} value={f.service_end} min={f.service_start || undefined} onChange={(e) => setF({ ...f, service_end: e.target.value })} />
          </Field>
        </Can>
      </div>
    </Modal>
  )
}
