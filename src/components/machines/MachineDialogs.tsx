// @permission-scope machines.add_existing, machines.transfer, machines.buyback, machines.stock, refurb
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { CHANGE_OWNER_CHOICES, STOCK_LABEL, type StockStatus } from '../../lib/machines'
import { supabase } from '../../lib/supabase'
import { useOptionList } from '../../lib/useOptionList'
import { ACTION } from '../../lib/wording'

type CustomerRow = { id: string; name: string; company: string | null; country: string | null }
const custName = (c: CustomerRow) => `${c.company || c.name}${c.company ? ` (${c.name})` : ''}${c.country ? ` · ${c.country}` : ''}`

function useCustomers() {
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  useEffect(() => {
    supabase
      ?.from('customer_list')
      .select('id, name, company, country')
      .eq('archived', false)
      .order('name')
      .limit(2000)
      .then(({ data }) => setCustomers((data as CustomerRow[]) ?? []))
  }, [])
  return customers
}

/** A customer chooser: type to narrow the list. */
/* @layout-helper */
function CustomerSelect({ id, label, value, onChange, exclude, extra }: { id: string; label: string; value: string; onChange: (v: string) => void; exclude?: string | null; extra?: { value: string; label: string }[] }) {
  const customers = useCustomers()
  const [find, setFind] = useState('')
  const shown = customers.filter((c) => custName(c).toLowerCase().includes(find.toLowerCase())).slice(0, 60)
  return (
    <div className="space-y-1">
      <input aria-label={`${label}: find`} className={inputClass} placeholder="Find a customer…" value={find} onChange={(e) => setFind(e.target.value)} />
      <select id={id} aria-label={label} size={5} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {extra?.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label}
          </option>
        ))}
        {shown.map((c) => (
          <option key={c.id} value={c.id} disabled={c.id === exclude}>
            {custName(c)}
          </option>
        ))}
      </select>
    </div>
  )
}

type MachineType = { id: string; name: string; code: string | null }

/** Add an older machine (built before the app), or edit a machine's details. */
export function AddMachineDialog({
  edit,
  onClose,
  onDone,
}: {
  edit?: { id: string; year_built: number | null; year_approx: boolean; voltage: string | null; location: string | null; condition: string | null; warranty_months: number | null; warranty_start: string | null }
  onClose: () => void
  onDone: (id: string) => void
}) {
  const [types, setTypes] = useState<MachineType[]>([])
  const [f, setF] = useState({
    machine_type_id: '',
    serial_number: '',
    year_built: edit?.year_built ? String(edit.year_built) : '',
    year_approx: edit?.year_approx ?? false,
    voltage: edit?.voltage ?? '',
    original_customer_id: '',
    current: 'same',
    current_since: '',
    location: edit?.location ?? '',
    condition: edit?.condition ?? '',
    notes: '',
    warranty_months: edit?.warranty_months != null ? String(edit.warranty_months) : '',
    warranty_start: edit?.warranty_start ?? '',
  })
  const voltages = useOptionList('voltage', f.voltage).options
  const conditions = useOptionList('machine_condition', f.condition).options
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    supabase
      ?.from('machine_types')
      .select('id, name, code')
      .eq('archived', false)
      .order('name')
      .then(({ data }) => setTypes((data as MachineType[]) ?? []))
  }, [])
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }))

  async function save() {
    if (!supabase) return
    setError(null)
    if (!edit && !f.machine_type_id) return setError('Choose the machine type.')
    if (!edit && !f.serial_number.trim()) return setError('Enter the serial number.')
    if (f.year_built && !/^\d{4}$/.test(f.year_built)) return setError('Enter the year as four digits, for example 2011.')
    setBusy(true)
    const common = {
      year_built: f.year_built,
      year_approx: f.year_approx,
      voltage: f.voltage,
      location: f.location,
      condition: f.condition,
      warranty_months: f.warranty_months,
      warranty_start: f.warranty_start,
    }
    const res = edit
      ? await supabase.rpc('save_machine_details', { p_machine: edit.id, p: common })
      : await supabase.rpc('add_existing_machine', {
          p: { ...common, machine_type_id: f.machine_type_id, serial_number: f.serial_number, original_customer_id: f.original_customer_id || null, current: f.current, current_since: f.current_since, notes: f.notes },
        })
    setBusy(false)
    if (res.error) return setError(friendlyError(res.error))
    toast.success(edit ? 'Machine details saved.' : `Machine ${f.serial_number.trim().toUpperCase()} added.`)
    onDone(edit ? edit.id : (res.data as string))
  }

  return (
    <Can permission="machines.add_existing" level="edit">
      <Modal
        title={edit ? 'Edit Machine Details' : 'Add Existing Machine'}
        onClose={onClose}
        busy={busy}
        wide
        footer={
          <>
            <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
              {ACTION.cancel}
            </button>
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              {busy ? ACTION.saving : edit ? ACTION.save : 'Add Machine'}
            </button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          {!edit && (
            <p className="text-slate-600">
              For machines built before the app. The serial number is typed as it is on the machine (older formats are fine); it is checked against every serial in the app, old and new, and never taken from the
              automatic numbering.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {!edit && (
              <>
                <Field label="Machine type / model" htmlFor="am-type">
                  <select id="am-type" className={inputClass} value={f.machine_type_id} onChange={(e) => set('machine_type_id', e.target.value)}>
                    <option value="">Choose…</option>
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.code ? ` (${t.code})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Serial number" htmlFor="am-serial">
                  <input id="am-serial" className={`${inputClass} font-mono`} value={f.serial_number} onChange={(e) => set('serial_number', e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Year built" htmlFor="am-year">
              <div className="flex items-center gap-3">
                <input id="am-year" inputMode="numeric" className={`${inputClass} w-28`} placeholder="2011" value={f.year_built} onChange={(e) => set('year_built', e.target.value)} />
                <label className="flex items-center gap-1.5 whitespace-nowrap">
                  <input type="checkbox" checked={f.year_approx} onChange={(e) => set('year_approx', e.target.checked)} /> Approximate
                </label>
              </div>
            </Field>
            <Field label="Voltage" htmlFor="am-volt">
              <select id="am-volt" className={inputClass} value={f.voltage} onChange={(e) => set('voltage', e.target.value)}>
                <option value="">Not known</option>
                {voltages.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Condition" htmlFor="am-cond">
              <select id="am-cond" className={inputClass} value={f.condition} onChange={(e) => set('condition', e.target.value)}>
                <option value="">Not known</option>
                {conditions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Where it is" htmlFor="am-loc" hint="For example: at the customer, Belfast warehouse.">
              <input id="am-loc" className={inputClass} value={f.location} onChange={(e) => set('location', e.target.value)} />
            </Field>
            <Field label="Warranty months (empty = the default for its kind)" htmlFor="am-wm">
              <input id="am-wm" inputMode="numeric" className={`${inputClass} w-28`} value={f.warranty_months} onChange={(e) => set('warranty_months', e.target.value)} />
            </Field>
            <Field label="Warranty starts (empty = the ship date)" htmlFor="am-ws">
              <input id="am-ws" type="date" className={inputClass} value={f.warranty_start} onChange={(e) => set('warranty_start', e.target.value)} />
            </Field>
          </div>
          {!edit && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Original customer" htmlFor="am-orig">
                <CustomerSelect id="am-orig" label="Original customer" value={f.original_customer_id} onChange={(v) => set('original_customer_id', v)} extra={[{ value: '', label: 'Not known' }]} />
              </Field>
              <Field label="Current owner" htmlFor="am-cur">
                <CustomerSelect
                  id="am-cur"
                  label="Current owner"
                  value={f.current}
                  onChange={(v) => set('current', v)}
                  extra={[
                    { value: 'same', label: 'The original customer' },
                    { value: 'company', label: 'The company (in stock)' },
                  ]}
                />
                {f.current !== 'same' && (
                  <label className="mt-1 flex items-center gap-2 text-xs">
                    Since
                    <input type="date" className={`${inputClass} w-40`} value={f.current_since} onChange={(e) => set('current_since', e.target.value)} />
                  </label>
                )}
              </Field>
            </div>
          )}
          {!edit && (
            <Field label="Notes (optional)" htmlFor="am-notes">
              <textarea id="am-notes" rows={2} className={inputClass} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          )}
          <p className="text-xs text-slate-500">Photos and documents can be added to a machine in a future update.</p>
          {error && <p className="font-medium text-red-600">{error}</p>}
        </div>
      </Modal>
    </Can>
  )
}

/** Change the owner: private sale, sold through us, gift, inheritance, company change. */
export function ChangeOwnerDialog({ machine, onClose, onDone }: { machine: { id: string; serial: string | null; machine_type: string; current_owner: { id: string; name: string; company: string | null } | null }; onClose: () => void; onDone: () => void }) {
  const [how, setHow] = useState<string>('private_sale')
  const [customerId, setCustomerId] = useState('')
  const [isNew, setIsNew] = useState(false)
  const [nw, setNw] = useState({ name: '', company: '', country: '', email: '' })
  const [date, setDate] = useState(todayISO())
  const [approx, setApprox] = useState(false)
  const [foundOut, setFoundOut] = useState('')
  const [notes, setNotes] = useState('')
  const [orderCode, setOrderCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!supabase) return
    setError(null)
    if (!isNew && !customerId) return setError('Choose the new owner.')
    if (isNew && !nw.name.trim()) return setError('Enter the new owner’s name.')
    let orderId: string | null = null
    if (how === 'sold_through_us' || orderCode.trim()) {
      if (!orderCode.trim()) return setError('Enter the order the machine was sold on.')
      const { data } = await supabase.from('order_summary').select('id').eq('order_code', orderCode.trim()).maybeSingle()
      if (!data) return setError(`There is no order ${orderCode.trim()}.`)
      orderId = (data as { id: string }).id
    }
    setBusy(true)
    const { error: e } = await supabase.rpc('change_machine_owner', {
      p: {
        machine_id: machine.id,
        how,
        customer_id: isNew ? null : customerId,
        new_customer: isNew ? { name: nw.name, company: nw.company, country: nw.country, emails: nw.email ? [nw.email] : [] } : null,
        date,
        date_approx: approx,
        found_out: foundOut,
        notes,
        order_id: orderId,
      },
    })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success('New owner saved. The machine now shows under their contact, service calls and warranty.')
    onDone()
  }

  return (
    <Can permission="machines.transfer" level="edit">
      <Modal
        title={`Change Owner: ${machine.serial ?? machine.machine_type}`}
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
              {ACTION.cancel}
            </button>
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              {busy ? ACTION.saving : 'Save New Owner'}
            </button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-slate-600">Current owner: {machine.current_owner ? machine.current_owner.company || machine.current_owner.name : 'the company'}. The previous owner stays in the history.</p>
          <fieldset className="space-y-1">
            <legend className="mb-1 font-medium text-slate-700">How did the owner change?</legend>
            {CHANGE_OWNER_CHOICES.map((c) => (
              <label key={c.value} className="flex items-center gap-2">
                <input type="radio" name="co-how" className="h-4 w-4" checked={how === c.value} onChange={() => setHow(c.value)} /> {c.label}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-4">
            <label className="flex items-center gap-2">
              <input type="radio" name="co-who" className="h-4 w-4" checked={!isNew} onChange={() => setIsNew(false)} /> An existing customer
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="co-who" className="h-4 w-4" checked={isNew} onChange={() => setIsNew(true)} /> A new customer
            </label>
          </div>
          {isNew ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="co-name">
                <input id="co-name" className={inputClass} value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
              </Field>
              <Field label="Company (optional)" htmlFor="co-company">
                <input id="co-company" className={inputClass} value={nw.company} onChange={(e) => setNw({ ...nw, company: e.target.value })} />
              </Field>
              <Field label="Country" htmlFor="co-country">
                <input id="co-country" className={inputClass} value={nw.country} onChange={(e) => setNw({ ...nw, country: e.target.value })} />
              </Field>
              <Field label="Email (optional)" htmlFor="co-email">
                <input id="co-email" type="email" className={inputClass} value={nw.email} onChange={(e) => setNw({ ...nw, email: e.target.value })} />
              </Field>
            </div>
          ) : (
            <CustomerSelect id="co-cust" label="New owner" value={customerId} onChange={setCustomerId} exclude={machine.current_owner?.id} />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date" htmlFor="co-date">
              <input id="co-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
              <label className="mt-1 flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} /> The date is approximate
              </label>
            </Field>
            {how === 'sold_through_us' ? (
              <Field label="Order #" htmlFor="co-order" hint="The order the machine was sold on.">
                <input id="co-order" className={inputClass} value={orderCode} onChange={(e) => setOrderCode(e.target.value)} />
              </Field>
            ) : (
              how === 'private_sale' && (
                <Field label="How we found out" htmlFor="co-found" hint="For example: a service call, the new owner phoned.">
                  <input id="co-found" className={inputClass} maxLength={300} value={foundOut} onChange={(e) => setFoundOut(e.target.value)} />
                </Field>
              )
            )}
          </div>
          <Field label="Notes (optional)" htmlFor="co-notes">
            <textarea id="co-notes" rows={3} className={inputClass} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {error && <p className="font-medium text-red-600">{error}</p>}
        </div>
      </Modal>
    </Can>
  )
}

type Shipment = { id: string; supplier: string | null; description: string | null; received_on: string | null; total_cad: number | null }
type Person = { email: string; name: string }

/** The company buys the machine back: it moves to Company stock with status "Bought back". */
export function BuyBackDialog({ machine, onClose, onDone }: { machine: { id: string; serial: string | null; machine_type: string }; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ date: todayISO(), price: '', currency: 'CAD', exchange_rate: '', condition: '', reason: '', arranged_by: '', incoming_shipment_id: '', location: 'Company stock', notes: '' })
  const conditions = useOptionList('machine_condition', f.condition).options
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  useEffect(() => {
    supabase
      ?.from('incoming_shipments')
      .select('id, supplier, description, received_on, total_cad')
      .eq('archived', false)
      .order('received_on', { ascending: false })
      .limit(100)
      .then(({ data }) => setShipments((data as Shipment[]) ?? []))
    supabase?.rpc('people_choices').then(({ data }) => setPeople(((data as Person[]) ?? []).map((p) => ({ email: p.email, name: p.name }))))
  }, [])

  async function save() {
    if (!supabase) return
    setError(null)
    if (f.price && Number.isNaN(Number(f.price))) return setError('Enter the price as a number.')
    setBusy(true)
    const { error: e } = await supabase.rpc('record_buyback', { p: { ...f, machine_id: machine.id } })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success('Buy-back saved. The machine is now in Company stock (Bought back).')
    onDone()
  }

  return (
    <Can permission="machines.buyback" level="edit">
      <Modal
        title={`Buy Back: ${machine.serial ?? machine.machine_type}`}
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
              {ACTION.cancel}
            </button>
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              {busy ? ACTION.saving : 'Save Buy-back'}
            </button>
          </>
        }
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="Date" htmlFor="bb-date">
            <input id="bb-date" type="date" className={inputClass} value={f.date} onChange={(e) => set('date', e.target.value)} />
          </Field>
          <Field label="Price paid" htmlFor="bb-price">
            <div className="flex gap-2">
              <input id="bb-price" inputMode="decimal" className={inputClass} value={f.price} onChange={(e) => set('price', e.target.value)} />
              <select aria-label="Currency" className={`${inputClass} w-24`} value={f.currency} onChange={(e) => set('currency', e.target.value)}>
                <option>CAD</option>
                <option>USD</option>
              </select>
            </div>
          </Field>
          {f.currency === 'USD' && (
            <Field label="Exchange rate (USD to CAD; empty = the freight setting)" htmlFor="bb-rate">
              <input id="bb-rate" inputMode="decimal" className={`${inputClass} w-28`} value={f.exchange_rate} onChange={(e) => set('exchange_rate', e.target.value)} />
            </Field>
          )}
          <Field label="Condition on arrival" htmlFor="bb-cond">
            <select id="bb-cond" className={inputClass} value={f.condition} onChange={(e) => set('condition', e.target.value)}>
              <option value="">Not known yet</option>
              {conditions.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Who arranged it" htmlFor="bb-who">
            <select id="bb-who" className={inputClass} value={f.arranged_by} onChange={(e) => set('arranged_by', e.target.value)}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Freight in (incoming shipment)" htmlFor="bb-ship" hint="Add it first under Freight → Incoming.">
            <select id="bb-ship" className={inputClass} value={f.incoming_shipment_id} onChange={(e) => set('incoming_shipment_id', e.target.value)}>
              <option value="">None</option>
              {shipments.map((s) => (
                <option key={s.id} value={s.id}>
                  {[s.received_on, s.supplier, s.description].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Where it is now" htmlFor="bb-loc">
            <input id="bb-loc" className={inputClass} value={f.location} onChange={(e) => set('location', e.target.value)} />
          </Field>
          <Field label="Reason" htmlFor="bb-reason" className="sm:col-span-2">
            <input id="bb-reason" className={inputClass} maxLength={1000} value={f.reason} onChange={(e) => set('reason', e.target.value)} />
          </Field>
          <Field label="Notes (optional)" htmlFor="bb-notes" className="sm:col-span-2">
            <textarea id="bb-notes" rows={2} className={inputClass} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          {error && <p className="font-medium text-red-600 sm:col-span-2">{error}</p>}
        </div>
      </Modal>
    </Can>
  )
}

/** Stock settings: status, location, condition and the asking price. */
export function StockDialog({
  machine,
  onClose,
  onDone,
}: {
  machine: { id: string; stock_status: StockStatus | null; location: string | null; condition: string | null; sale_price: number | null; sale_currency: string | null }
  onClose: () => void
  onDone: () => void
}) {
  const auto = machine.stock_status === 'reserved' || machine.stock_status === 'in_refurbishment' || machine.stock_status === 'sold'
  const [f, setF] = useState({
    status: machine.stock_status ?? 'ready_to_sell',
    location: machine.location ?? '',
    condition: machine.condition ?? '',
    sale_price: machine.sale_price != null ? String(machine.sale_price) : '',
    sale_currency: machine.sale_currency ?? 'CAD',
  })
  const conditions = useOptionList('machine_condition', f.condition).options
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  async function save(withPrice: boolean) {
    if (!supabase) return
    setBusy(true)
    const p: Record<string, string> = { location: f.location, condition: f.condition }
    if (!auto) p.status = f.status
    if (withPrice) Object.assign(p, { sale_price: f.sale_price, sale_currency: f.sale_currency })
    const { error: e } = await supabase.rpc('set_machine_stock', { p_machine: machine.id, p })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success('Stock details saved.')
    onDone()
  }

  return (
    <Can permission="machines.stock" level="edit">
      <Can
        permission="refurb.costs"
        fallback={
          <StockForm f={f} set={set} auto={auto} conditions={conditions} error={error} busy={busy} onClose={onClose} onSave={() => save(false)} withPrice={false} />
        }
      >
        <StockForm f={f} set={set} auto={auto} conditions={conditions} error={error} busy={busy} onClose={onClose} onSave={() => save(true)} withPrice />
      </Can>
    </Can>
  )
}

/* @layout-helper */
function StockForm({
  f,
  set,
  auto,
  conditions,
  error,
  busy,
  onClose,
  onSave,
  withPrice,
}: {
  f: { status: string; location: string; condition: string; sale_price: string; sale_currency: string }
  set: (k: 'status' | 'location' | 'condition' | 'sale_price' | 'sale_currency', v: string) => void
  auto: boolean
  conditions: string[]
  error: string | null
  busy: boolean
  onClose: () => void
  onSave: () => void
  withPrice: boolean
}) {
  return (
    <Modal
      title="Stock Details"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={onSave} disabled={busy}>
            {busy ? ACTION.saving : ACTION.save}
          </button>
        </>
      }
    >
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Status" htmlFor="st-status" hint={auto ? 'Reserved, In refurbishment and Sold change by themselves.' : undefined}>
          <select id="st-status" className={inputClass} value={f.status} disabled={auto} onChange={(e) => set('status', e.target.value)}>
            {(auto ? [f.status] : ['bought_back', 'ready_to_sell']).map((s) => (
              <option key={s} value={s}>
                {STOCK_LABEL[s as StockStatus]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Condition" htmlFor="st-cond">
          <select id="st-cond" className={inputClass} value={f.condition} onChange={(e) => set('condition', e.target.value)}>
            <option value="">Not known</option>
            {conditions.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="Where it is" htmlFor="st-loc">
          <input id="st-loc" className={inputClass} value={f.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
        {withPrice && (
          <Field label="Asking / sale price" htmlFor="st-price" hint="Used for profit and margin.">
            <div className="flex gap-2">
              <input id="st-price" inputMode="decimal" className={inputClass} value={f.sale_price} onChange={(e) => set('sale_price', e.target.value)} />
              <select aria-label="Currency" className={`${inputClass} w-24`} value={f.sale_currency} onChange={(e) => set('sale_currency', e.target.value)}>
                <option>CAD</option>
                <option>USD</option>
              </select>
            </div>
          </Field>
        )}
        {error && <p className="font-medium text-red-600 sm:col-span-2">{error}</p>}
      </div>
    </Modal>
  )
}

/** Start a refurbishment job: makes its board with the refurbishment stages and checklists. */
export function StartRefurbDialog({ machine, onClose, onDone }: { machine: { id: string; serial: string | null; machine_type: string; condition: string | null }; onClose: () => void; onDone: (job: string) => void }) {
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function go() {
    if (!supabase) return
    setBusy(true)
    const { data, error: e } = await supabase.rpc('open_refurb_job', { p_machine: machine.id, p: { before_notes: notes } })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success('Refurbishment started. Its board has the refurbishment stages and checklists.')
    onDone(data as string)
  }
  return (
    <Can permission="refurb" level="edit">
      <Modal
        title={`Start Refurbishment: ${machine.serial ?? machine.machine_type}`}
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
              {ACTION.cancel}
            </button>
            <button type="button" className={buttonClass} onClick={go} disabled={busy}>
              {busy ? ACTION.saving : 'Start Refurbishment'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">
            A board is made with the refurbishment stages (Admin → Machine Lifecycle). The machine’s earlier final check stays in its history; a new final check is signed in the last stage. When the job is
            completed the machine gets a new serial ending in -R.
          </p>
          <p>Condition now: {machine.condition ?? 'not known'}</p>
          <Field label="Condition notes before the work (optional)" htmlFor="sr-notes">
            <textarea id="sr-notes" rows={3} className={inputClass} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {error && <p className="font-medium text-red-600">{error}</p>}
        </div>
      </Modal>
    </Can>
  )
}
