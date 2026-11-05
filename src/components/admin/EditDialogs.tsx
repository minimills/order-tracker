// @permission-scope admin.records, admin.archive
import { useEffect, useState } from 'react'
import { useAlerts } from '../../lib/alerts'
import { friendlyError } from '../../lib/format'
import { parseMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase'
import { CURRENCIES, STAGES, type Currency, type Customer, type MachineType, type Stage } from '../../lib/types'
import { stageLabel } from '../../lib/stages'
import { useOptionList } from '../../lib/useOptionList'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import { emailPattern, parseEmails } from '../order/customer'

type DialogProps = { onClose: () => void; onDone: (message: string) => void }

function Footer({ onClose, onSave, saving }: { onClose: () => void; onSave: () => void; saving: boolean }) {
  return (
    <>
      <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button type="button" className={buttonClass} onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------
export type AdminOrder = {
  id: string
  order_number: number
  split_number: number | null
  order_code: string
  customer_id: string
  stage: Stage
  order_date: string
  currency: Currency
  order_total: number | null
  expected_ship_date: string | null
  actual_ship_date: string | null
  voltage: string
  delivery_equipment: string
  freight_type: string | null
  notes: string | null
}

export function AdminOrderDialog({ order, onClose, onDone }: DialogProps & { order: AdminOrder }) {
  const { refresh } = useAlerts()
  const [f, setF] = useState({
    order_number: String(order.order_number),
    split_number: order.split_number === null ? '' : String(order.split_number),
    customer_id: order.customer_id,
    stage: order.stage,
    order_date: order.order_date,
    currency: order.currency,
    order_total: order.order_total === null ? '' : String(order.order_total),
    expected_ship_date: order.expected_ship_date ?? '',
    actual_ship_date: order.actual_ship_date ?? '',
    voltage: order.voltage,
    delivery_equipment: order.delivery_equipment,
    freight_type: order.freight_type ?? '',
    notes: order.notes ?? '',
  })
  const [customers, setCustomers] = useState<Pick<Customer, 'id' | 'name' | 'company' | 'archived'>[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const voltage = useOptionList('voltage', order.voltage)
  const delivery = useOptionList('delivery_equipment', order.delivery_equipment)
  const freight = useOptionList('freight_type', order.freight_type)

  useEffect(() => {
    supabase
      ?.from('customers')
      .select('id, name, company, archived')
      .order('name')
      .limit(5000)
      .then(({ data }) => setCustomers((data as typeof customers) ?? []))
  }, [])

  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value })

  async function save() {
    if (!supabase) return
    if (!/^\d+$/.test(f.order_number) || Number(f.order_number) < 1) return setError('The order number must be a whole number.')
    if (f.split_number && (!/^\d+$/.test(f.split_number) || Number(f.split_number) < 1))
      return setError('The split number must be a whole number, or empty.')
    // People without "order.field.order_total" don't see the total; it is then left as it is.
    const keepTotal = order.order_total === null && f.order_total.trim() === ''
    const total = keepTotal ? null : parseMoney(f.order_total)
    if (!keepTotal && (total === null || Number.isNaN(total))) return setError('Enter the order total as a number.')
    if (!f.order_date) return setError('Enter the order date.')
    setSaving(true)
    const { error: e } = await supabase
      .from('orders')
      .update({
        order_number: Number(f.order_number),
        split_number: f.split_number ? Number(f.split_number) : null,
        customer_id: f.customer_id,
        stage: f.stage,
        order_date: f.order_date,
        currency: f.currency,
        ...(keepTotal ? {} : { order_total: total }),
        expected_ship_date: f.expected_ship_date || null,
        actual_ship_date: f.actual_ship_date || null,
        voltage: f.voltage,
        delivery_equipment: f.delivery_equipment,
        freight_type: f.freight_type || null,
        notes: f.notes.trim() || null,
      })
      .eq('id', order.id)
    setSaving(false)
    if (e) {
      return setError(
        e.code === '23505' ? 'That order number (with that split number) is already used.' : friendlyError(e),
      )
    }
    refresh()
    onDone(`Order ${f.order_number}${f.split_number ? `-${f.split_number}` : ''} saved.`)
  }

  return (
    <Modal title={`Edit order ${order.order_code}`} onClose={onClose} busy={saving} footer={<Footer onClose={onClose} onSave={save} saving={saving} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Order number" htmlFor="ao-number">
          <input id="ao-number" inputMode="numeric" className={inputClass} value={f.order_number} onChange={set('order_number')} />
        </Field>
        <Field label="Split number" htmlFor="ao-split" hint="Empty for a normal order; 1, 2… for 76-1, 76-2.">
          <input id="ao-split" inputMode="numeric" className={inputClass} value={f.split_number} onChange={set('split_number')} />
        </Field>
        <Field label="Customer" htmlFor="ao-customer" className="sm:col-span-2">
          <select id="ao-customer" className={inputClass} value={f.customer_id} onChange={set('customer_id')}>
            {customers
              .filter((c) => !c.archived || c.id === order.customer_id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` · ${c.company}` : ''}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Stage" htmlFor="ao-stage" hint="Changing it here skips the serial preview; the board shows it first.">
          <select id="ao-stage" className={inputClass} value={f.stage} onChange={set('stage')}>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Order date" htmlFor="ao-date">
          <input id="ao-date" type="date" className={inputClass} value={f.order_date} onChange={set('order_date')} />
        </Field>
        <Field label="Order total" htmlFor="ao-total">
          <div className="flex gap-2">
            <input id="ao-total" inputMode="decimal" className={inputClass} value={f.order_total} onChange={set('order_total')} />
            <select aria-label="Currency" className={`${inputClass} w-24`} value={f.currency} onChange={set('currency')}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </Field>
        <Field label="Voltage" htmlFor="ao-voltage">
          <select id="ao-voltage" className={inputClass} value={f.voltage} onChange={set('voltage')}>
            {voltage.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <Field label="Expected ship date" htmlFor="ao-exp">
          <input id="ao-exp" type="date" className={inputClass} value={f.expected_ship_date} onChange={set('expected_ship_date')} />
        </Field>
        <Field label="Actual ship date" htmlFor="ao-act">
          <input id="ao-act" type="date" className={inputClass} value={f.actual_ship_date} onChange={set('actual_ship_date')} />
        </Field>
        <Field label="Delivery equipment" htmlFor="ao-del">
          <select id="ao-del" className={inputClass} value={f.delivery_equipment} onChange={set('delivery_equipment')}>
            {delivery.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <Field label="Freight type" htmlFor="ao-freight">
          <select id="ao-freight" className={inputClass} value={f.freight_type} onChange={set('freight_type')}>
            <option value="">Not decided yet</option>
            {freight.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <Field label="Notes" htmlFor="ao-notes" className="sm:col-span-2">
          <textarea id="ao-notes" rows={3} className={inputClass} value={f.notes} onChange={set('notes')} />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------
export function AdminCustomerDialog({ customer, onClose, onDone }: DialogProps & { customer: Customer }) {
  const [f, setF] = useState({
    name: customer.name,
    company: customer.company ?? '',
    emails: customer.emails.join(', '),
    phone: customer.phone ?? '',
    country: customer.country ?? '',
    state_province: customer.state_province ?? '',
    notes: customer.notes ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value })

  async function save() {
    if (!supabase) return
    if (!f.name.trim()) return setError('Enter the customer’s name.')
    const emails = parseEmails(f.emails)
    const bad = emails.filter((m) => !emailPattern.test(m))
    if (bad.length) return setError(`This doesn’t look like an email address: ${bad.join(', ')}`)
    setSaving(true)
    const { error: e } = await supabase
      .from('customers')
      .update({
        name: f.name.trim(),
        company: f.company.trim() || null,
        emails,
        phone: f.phone.trim() || null,
        country: f.country.trim() || null,
        state_province: f.state_province.trim() || null,
        notes: f.notes.trim() || null,
      })
      .eq('id', customer.id)
    setSaving(false)
    if (e) return setError(friendlyError(e))
    onDone(`${f.name.trim()} saved.`)
  }

  return (
    <Modal title={`Edit customer ${customer.name}`} onClose={onClose} busy={saving} footer={<Footer onClose={onClose} onSave={save} saving={saving} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="ac-name">
          <input id="ac-name" className={inputClass} value={f.name} onChange={set('name')} />
        </Field>
        <Field label="Company" htmlFor="ac-company">
          <input id="ac-company" className={inputClass} value={f.company} onChange={set('company')} />
        </Field>
        <Field label="Email addresses" htmlFor="ac-emails" hint="Separate several with commas." className="sm:col-span-2">
          <input id="ac-emails" className={inputClass} value={f.emails} onChange={set('emails')} />
        </Field>
        <Field label="Phone" htmlFor="ac-phone">
          <input id="ac-phone" className={inputClass} value={f.phone} onChange={set('phone')} />
        </Field>
        <Field label="Country" htmlFor="ac-country">
          <input id="ac-country" className={inputClass} value={f.country} onChange={set('country')} />
        </Field>
        <Field label="State / province" htmlFor="ac-state">
          <input id="ac-state" className={inputClass} value={f.state_province} onChange={set('state_province')} />
        </Field>
        <Field label="Notes" htmlFor="ac-notes" className="sm:col-span-2">
          <textarea id="ac-notes" rows={3} className={inputClass} value={f.notes} onChange={set('notes')} />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------
export type AdminMachine = {
  id: string
  order_id: string
  machine_type_id: string
  serial_number: string | null
  serial_manual: boolean
  ready: boolean
  notes: string | null
  orders: { order_code: string } | null
}

export function AdminMachineDialog({ machine, onClose, onDone }: DialogProps & { machine: AdminMachine }) {
  const { refresh } = useAlerts()
  const [types, setTypes] = useState<MachineType[]>([])
  const [f, setF] = useState({
    machine_type_id: machine.machine_type_id,
    order_code: machine.orders?.order_code ?? '',
    ready: machine.ready,
    notes: machine.notes ?? '',
    serial: machine.serial_number ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase
      ?.from('machine_types')
      .select('id, name, code, next_serial_number, archived')
      .order('name')
      .then(({ data }) => setTypes((data as MachineType[]) ?? []))
  }, [])

  async function save() {
    if (!supabase) return
    setSaving(true)
    let orderId = machine.order_id
    if (f.order_code.trim() !== (machine.orders?.order_code ?? '')) {
      const { data } = await supabase.from('orders').select('id').eq('order_code', f.order_code.trim()).maybeSingle()
      if (!data) {
        setSaving(false)
        return setError(`There is no order ${f.order_code.trim()}.`)
      }
      orderId = (data as { id: string }).id
    }
    const { error: e } = await supabase
      .from('order_machines')
      .update({ machine_type_id: f.machine_type_id, order_id: orderId, ready: f.ready, notes: f.notes.trim() || null })
      .eq('id', machine.id)
    if (e) {
      setSaving(false)
      return setError(friendlyError(e))
    }
    // A changed serial goes through the admin serial check (duplicates etc.).
    const typeChanged = f.machine_type_id !== machine.machine_type_id
    const serial = f.serial.trim().toUpperCase()
    if (!typeChanged && serial !== (machine.serial_number ?? '')) {
      const { error: e2 } = await supabase.rpc('admin_set_serial', { p_machine_id: machine.id, p_serial: serial })
      if (e2) {
        setSaving(false)
        return setError(friendlyError(e2))
      }
    }
    setSaving(false)
    refresh()
    onDone('Machine saved.')
  }

  return (
    <Modal title="Edit machine" onClose={onClose} busy={saving} footer={<Footer onClose={onClose} onSave={save} saving={saving} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Machine type" htmlFor="am-type" hint="Changing the type gives the machine a new automatic serial.">
          <select
            id="am-type"
            className={inputClass}
            value={f.machine_type_id}
            onChange={(e) => setF({ ...f, machine_type_id: e.target.value })}
          >
            {types
              .filter((t) => !t.archived || t.id === machine.machine_type_id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.code ? ` (${t.code})` : ''}
                </option>
              ))}
          </select>
        </Field>
        <Field label="On order #" htmlFor="am-order" hint="Type another order number to move it, e.g. 76 or 76-2.">
          <input id="am-order" className={inputClass} value={f.order_code} onChange={(e) => setF({ ...f, order_code: e.target.value })} />
        </Field>
        <Field
          label="Serial number"
          htmlFor="am-serial"
          hint={
            f.machine_type_id !== machine.machine_type_id
              ? 'Save the new type first, then set a serial.'
              : 'Typed serials stay fixed. Leave empty to go back to an automatic serial.'
          }
        >
          <input
            id="am-serial"
            className={`${inputClass} font-mono uppercase`}
            value={f.serial}
            disabled={f.machine_type_id !== machine.machine_type_id}
            onChange={(e) => setF({ ...f, serial: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 pt-6 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={f.ready} onChange={(e) => setF({ ...f, ready: e.target.checked })} />
          Built (keeps its serial for good)
        </label>
        <Field label="Notes" htmlFor="am-notes" className="sm:col-span-2">
          <textarea id="am-notes" rows={2} className={inputClass} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Archive confirm
// ---------------------------------------------------------------------------
export function ArchiveDialog({
  what,
  explain,
  onClose,
  onConfirm,
}: {
  what: string
  explain: string
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={`Archive ${what}?`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await onConfirm()
              setBusy(false)
            }}
          >
            {busy ? 'Archiving…' : 'Archive'}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-700">{explain}</p>
      <p className="mt-2 text-sm text-slate-600">You can bring it back any time from Admin → Archive.</p>
    </Modal>
  )
}
