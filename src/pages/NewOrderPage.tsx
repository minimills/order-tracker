import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import RichTextEditor from '../components/RichTextEditor'
import { buttonClass, Field, inputClass, Section } from '../components/form'
import CustomerPicker from '../components/order/CustomerPicker'
import { emailPattern, parseEmails, type CustomerChoice } from '../components/order/customer'
import MachinesSection from '../components/order/MachinesSection'
import { cleanSerial, parseQuantity, previewSerials, type MachineRow } from '../components/order/machines'
import { formatMoney, friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { useStageLabels } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { BOARD_STAGES, CURRENCIES, type Currency, type Customer, type MachineType, type Stage } from '../lib/types'
import { useOptionList } from '../lib/useOptionList'
import Timeline from '../components/schedule/Timeline'
import { showDate } from '../lib/dates'
import {
  balanceDue as balanceDueFor,
  currencyFor,
  deadlinesOf,
  downPaymentDue,
  STEP_LABEL,
  suggestBalanceDue,
  workingText,
  type SchedOrder,
} from '../lib/schedule'
import { useSchedule } from '../lib/useSchedule'

/** Stages a brand-new order can start in. */
const NEW_ORDER_STAGES: Stage[] = ['Quote', ...BOARD_STAGES]

/** "10,000.50" or "$10000" -> 10000.5; empty -> null; nonsense -> NaN */
function parseMoney(text: string) {
  const cleaned = text.replace(/[\s,$]/g, '')
  if (cleaned === '') return null
  return /^\d+(\.\d{0,2})?$/.test(cleaned) ? Number(cleaned) : NaN
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

type SplitInfo = { codes: string[]; customer: Customer | null } | 'not-found' | null

export default function NewOrderPage() {
  const navigate = useNavigate()
  // "Split shipment" on an order page opens /orders/new?split=76
  const [searchParams] = useSearchParams()
  const { can } = usePermissions()
  const label = useStageLabels()
  // What this person may fill in; everything else keeps its default.
  const may = {
    number: can('orders.new.field.order_number', 'edit'),
    split: can('orders.new.split', 'edit'),
    stage: can('orders.new.field.stage', 'edit'),
    voltage: can('order.field.voltage', 'edit'),
    delivery: can('order.field.delivery_equipment', 'edit'),
    freight: can('order.field.freight_type', 'edit'),
    shipDate: can('order.field.expected_ship_date', 'edit'),
    notes: can('order.field.notes', 'edit'),
    total: can('order.field.order_total', 'edit'),
    currency: can('order.field.currency', 'edit'),
    payments: can('payments', 'edit'),
  }
  const splitParam = /^\d+$/.test(searchParams.get('split') ?? '') ? searchParams.get('split')! : ''

  // --- Form state ---------------------------------------------------------
  const [customer, setCustomer] = useState<CustomerChoice>({ mode: 'existing', customer: null })
  const [orderNumber, setOrderNumber] = useState('')
  const [nextNumber, setNextNumber] = useState<number | null>(null)
  const [isSplit, setIsSplit] = useState(Boolean(splitParam) && may.split)
  const [splitOf, setSplitOf] = useState(splitParam)
  const [stage, setStage] = useState<Stage>('Confirmed')
  // Machines are added with the search box (empty to start).
  const [rows, setRows] = useState<MachineRow[]>([])
  // Defaults (Admin → Order defaults) and calculated dates fill these until
  // they are changed by hand (null = use the default / calculated value).
  const schedule = useSchedule()
  const { defaults } = schedule
  const [voltageHand, setVoltage] = useState<string | null>(null)
  const [deliveryEquipment, setDeliveryEquipment] = useState('Unknown')
  const [freightType, setFreightType] = useState('')
  const [shipHand, setExpectedShipDate] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [currencyHand, setCurrency] = useState<Currency | null>(null)
  const [total, setTotal] = useState('')
  const [downMode, setDownMode] = useState<'amount' | 'percent'>('percent')
  const [downValue, setDownValue] = useState('')
  const [downDueHand, setDownDue] = useState<string | null>(null)
  const [balanceDueHand, setBalanceDue] = useState<string | null>(null)

  // After the first Save attempt, the form re-checks itself as you type.
  const [triedToSave, setTriedToSave] = useState(false)
  const [saving, setSaving] = useState(false)

  // --- Data from the database --------------------------------------------
  const [machineTypes, setMachineTypes] = useState<MachineType[]>([])
  const [takenNumbers, setTakenNumbers] = useState<Record<string, boolean>>({})
  const [takenSerials, setTakenSerials] = useState<Record<string, string>>({}) // serial -> order code
  const [splitInfo, setSplitInfo] = useState<SplitInfo>(null)
  const voltageOptions = useOptionList('voltage')
  const deliveryOptions = useOptionList('delivery_equipment')
  const freightOptions = useOptionList('freight_type')

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('machine_types')
      .select('id, name, code, next_serial_number, archived')
      .order('name')
      .then(({ data }) => setMachineTypes((data as MachineType[]) ?? []))
    supabase.rpc('next_order_number').then(({ data }) => {
      if (typeof data === 'number') {
        setNextNumber(data)
        setOrderNumber((current) => current || String(data))
      }
    })
  }, [])

  // Is the typed order number already used?
  const orderNumberInt = /^\d+$/.test(orderNumber.trim()) ? Number(orderNumber.trim()) : null
  useEffect(() => {
    if (!supabase || isSplit || orderNumberInt === null || orderNumberInt in takenNumbers) return
    const timer = setTimeout(async () => {
      const { count } = await supabase!
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('order_number', orderNumberInt)
      setTakenNumbers((t) => ({ ...t, [orderNumberInt]: (count ?? 0) > 0 }))
    }, 300)
    return () => clearTimeout(timer)
  }, [orderNumberInt, isSplit, takenNumbers])

  // Split shipment: look up the original order and suggest its customer.
  const splitOfInt = /^\d+$/.test(splitOf.trim()) ? Number(splitOf.trim()) : null
  useEffect(() => {
    if (!supabase || !isSplit || splitOfInt === null) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const { data } = await supabase!
        .from('orders')
        // Emails and phone are not readable from the customers table (see customer_list).
        .select('order_code, split_number, customers(id, name, company, country, state_province, notes, archived)')
        .eq('order_number', splitOfInt)
        .order('split_number', { nullsFirst: true })
      if (cancelled) return
      if (!data || data.length === 0) {
        setSplitInfo('not-found')
        return
      }
      const raw = data[0] as unknown as { customers: Omit<Customer, 'emails' | 'phone'> | null }
      const first = { customers: raw.customers ? { ...raw.customers, emails: [], phone: null } : null }
      setSplitInfo({ codes: data.map((d) => d.order_code as string), customer: first.customers })
      setCustomer((c) =>
        c.mode === 'existing' && !c.customer && first.customers ? { mode: 'existing', customer: first.customers } : c,
      )
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isSplit, splitOfInt])
  const activeSplitInfo = isSplit && splitOfInt !== null ? splitInfo : null

  // Are any hand-typed serials already used by other orders?
  const manualSerials = useMemo(
    () => [
      ...new Set(
        rows.flatMap((r) => r.manual.filter((m): m is string => m !== null && m.trim() !== '').map(cleanSerial)),
      ),
    ],
    [rows],
  )
  const uncheckedKey = manualSerials.filter((s) => !(s in takenSerials)).join('|')
  useEffect(() => {
    if (!supabase || !uncheckedKey) return
    const toCheck = uncheckedKey.split('|')
    const timer = setTimeout(async () => {
      const { data } = await supabase!
        .from('order_machines')
        .select('serial_number, orders(order_code)')
        .in('serial_number', toCheck)
      const found: Record<string, string> = Object.fromEntries(toCheck.map((s) => [s, '']))
      for (const row of (data ?? []) as unknown as { serial_number: string; orders: { order_code: string } | null }[]) {
        found[row.serial_number] = row.orders?.order_code ?? '?'
      }
      setTakenSerials((t) => ({ ...t, ...found }))
    }, 400)
    return () => clearTimeout(timer)
  }, [uncheckedKey])

  // --- Calculations -------------------------------------------------------
  const getsSerials = BOARD_STAGES.includes(stage)
  const takenSerialSet = useMemo(
    () => new Set(Object.entries(takenSerials).filter(([, code]) => code).map(([s]) => s)),
    [takenSerials],
  )
  const preview = useMemo(
    () => previewSerials(rows, machineTypes, getsSerials, takenSerialSet),
    [rows, machineTypes, getsSerials, takenSerialSet],
  )

  // Defaults and the schedule
  const country = customer.customer?.country ?? ''
  const currency = (currencyHand ?? currencyFor(country, defaults)) as Currency
  const voltage = voltageHand ?? defaults.voltage
  const schedOrder: SchedOrder = useMemo(
    () => ({
      id: 'new',
      machines: rows.flatMap((r, i) =>
        r.manual.map((_, j) => ({ id: `new-${i}-${j}`, machine_type_id: r.machineTypeId, needs_crate: r.needsCrate, done: {} })),
      ),
    }),
    [rows],
  )
  const plan = getsSerials && rows.length && !schedule.loading ? schedule.planFor(schedOrder) : null
  const expectedShipDate = shipHand ?? plan?.ship_date ?? ''
  const downDue = downDueHand ?? downPaymentDue(schedule.today, defaults)
  const balanceDue = balanceDueHand ?? (expectedShipDate ? balanceDueFor(expectedShipDate, defaults) : '')
  const balanceSuggestion = downDue && expectedShipDate && balanceDue && balanceDue < downDue ? suggestBalanceDue(downDue, expectedShipDate) : null

  const totalNum = parseMoney(total)
  const downNum = parseMoney(downValue)
  const downAmount =
    downNum === null || Number.isNaN(downNum)
      ? null
      : downMode === 'amount'
        ? downNum
        : totalNum !== null && !Number.isNaN(totalNum)
          ? round2((totalNum * downNum) / 100)
          : null
  const downPercent =
    downMode === 'percent'
      ? downNum
      : downAmount !== null && totalNum
        ? Math.round((downAmount / totalNum) * 1000) / 10
        : null
  const balance =
    totalNum !== null && !Number.isNaN(totalNum) ? round2(totalNum - (downAmount ?? 0)) : null

  const splitPreview =
    activeSplitInfo && activeSplitInfo !== 'not-found'
      ? (() => {
          const codes = activeSplitInfo.codes
          const hasPlain = codes.includes(String(splitOfInt))
          const suffixes = codes.map((c) => Number(c.split('-')[1] ?? 0))
          const next = hasPlain && !codes.includes(`${splitOfInt}-1`) ? 2 : Math.max(0, ...suffixes) + 1
          return hasPlain && !codes.includes(`${splitOfInt}-1`)
            ? `Order ${splitOfInt} will become ${splitOfInt}-1, and this order will be ${splitOfInt}-${next}.`
            : `This order will be ${splitOfInt}-${next}.`
        })()
      : null

  // --- Validation ---------------------------------------------------------
  function validate() {
    const e: Record<string, string> = {}

    if (customer.mode === 'existing' && !customer.customer) e.customer = 'Select a customer, or create a new one.'
    if (customer.mode === 'new') {
      if (!customer.customer.name.trim()) e.name = 'Enter the customer’s name.'
      const bad = parseEmails(customer.customer.emails).filter((m) => !emailPattern.test(m))
      if (bad.length) e.emails = `This doesn’t look like an email address: ${bad.join(', ')}`
    }

    if (isSplit) {
      if (splitOfInt === null) e.splitOf = 'Enter the number of the original order, for example 76.'
      else if (activeSplitInfo === 'not-found') e.splitOf = `There is no order ${splitOfInt}.`
    } else if (!may.number) {
      // the next free number is picked automatically
    } else if (orderNumberInt === null || orderNumberInt < 1) {
      e.orderNumber = 'Enter a whole number, for example 77.'
    } else if (takenNumbers[orderNumberInt]) {
      e.orderNumber = `Order ${orderNumberInt} already exists.${nextNumber ? ` The next free number is ${nextNumber}.` : ''}`
    }

    const typeById = new Map(machineTypes.map((t) => [t.id, t]))
    const seen = new Map<string, string>()
    rows.forEach((row, i) => {
      if (!row.machineTypeId) e[`row-${i}-type`] = 'Choose a machine type.'
      if (parseQuantity(row.quantity) === null) e[`row-${i}-qty`] = 'Enter 1 to 50.'
      const type = typeById.get(row.machineTypeId)
      row.manual.forEach((m, j) => {
        if (m === null) return
        const s = cleanSerial(m)
        const key = `row-${i}-unit-${j}`
        if (!s) e[key] = 'Enter the serial number, or switch back to automatic numbering.'
        else if (seen.has(s)) e[key] = `${s} is entered twice on this order.`
        else if (takenSerials[s]) e[key] = `${s} is already in use on order ${takenSerials[s]}.`
        else if (type?.code && !s.startsWith(`${type.code}-`))
          e[key] = `Serial numbers for ${type.name} start with ${type.code}-`
        seen.set(s, key)
      })
    })
    if (rows.length === 0) e.machines = 'Add at least one machine.'

    if (!may.total) {
      // no order total for this person
    } else if (totalNum === null) e.total = 'Enter the order total (enter 0 if it is not known yet).'
    else if (Number.isNaN(totalNum)) e.total = 'Enter a number, for example 12500 or 12,500.00'
    if (downNum !== null && Number.isNaN(downNum)) e.down = 'Enter a number.'
    else if (downMode === 'percent' && downNum !== null && downNum > 100) e.down = 'The percentage cannot be more than 100.'
    else if (downAmount !== null && totalNum !== null && downAmount > totalNum)
      e.down = 'The down payment cannot be more than the order total.'
    if (downDue && balanceDue && balanceDue < downDue) e.balanceDue = 'The balance would be due before the down payment.'

    return e
  }

  // --- Save ---------------------------------------------------------------
  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!supabase || saving) return
    const e = validate()
    // The balance-date note is only a warning; everything else blocks saving.
    const blocking = Object.keys(e).filter((k) => k !== 'balanceDue')
    setTriedToSave(true)
    if (blocking.length) {
      toast.error('Correct the fields marked in red, then save again.')
      setTimeout(() => document.querySelector('.text-red-600')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
      return
    }

    const payload = {
      customer_id: customer.mode === 'existing' ? customer.customer?.id : undefined,
      new_customer:
        customer.mode === 'new'
          ? {
              name: customer.customer.name.trim(),
              company: customer.customer.company.trim(),
              emails: parseEmails(customer.customer.emails),
              country: customer.customer.country.trim(),
              state_province: customer.customer.state_province.trim(),
            }
          : undefined,
      order_number: isSplit || !may.number ? undefined : orderNumberInt,
      split_of: isSplit ? splitOfInt : undefined,
      stage: may.stage ? stage : undefined,
      currency: may.currency ? currency : undefined,
      order_total: may.total ? (totalNum ?? 0) : 0,
      expected_ship_date: may.shipDate ? expectedShipDate || undefined : undefined,
      voltage: may.voltage ? voltage : undefined,
      delivery_equipment: may.delivery ? deliveryEquipment : undefined,
      freight_type: may.freight ? freightType || undefined : undefined,
      notes: may.notes ? notes || undefined : undefined,
      machines: rows.flatMap((row) =>
        row.manual.map((m) => ({
          machine_type_id: row.machineTypeId,
          serial_number: m !== null && m.trim() ? cleanSerial(m) : undefined,
          needs_crate: row.needsCrate,
        })),
      ),
      down_payment_amount: may.payments ? (downAmount ?? undefined) : undefined,
      down_payment_due_date: may.payments ? downDue || undefined : undefined,
      balance_due_date: may.payments ? balanceDue || undefined : undefined,
    }

    setSaving(true)
    const { data, error } = await supabase.rpc('create_order', { p_order: payload })
    setSaving(false)
    if (error) {
      toast.error(friendlyError(error))
      // Refresh what we know, in case someone else just used the number.
      setTakenNumbers({})
      supabase.rpc('next_order_number').then(({ data: n }) => typeof n === 'number' && setNextNumber(n))
      return
    }
    const result = data as { id: string; order_code: string }
    if (plan) await saveFirstSchedule(result.id)
    toast.success(`Order ${result.order_code} saved.`)
    navigate(`/orders/${result.id}`)
  }

  /**
   * Saves the promised dates of the new order: the ship date on the form and
   * the department deadlines worked out for its machines (now with real ids).
   */
  async function saveFirstSchedule(orderId: string) {
    if (!supabase) return
    const { data } = await supabase
      .from('order_machine_status')
      .select('id, machine_type_id, needs_crate, serial_number, created_at')
      .eq('order_id', orderId)
    const machines = ((data ?? []) as { id: string; machine_type_id: string; needs_crate: boolean | null; serial_number: string | null; created_at: string }[])
      .sort((a, b) => (a.serial_number ?? '').localeCompare(b.serial_number ?? '') || a.created_at.localeCompare(b.created_at))
      .map((m) => ({ id: m.id, machine_type_id: m.machine_type_id, needs_crate: m.needs_crate !== false, done: {} }))
    const p = schedule.planFor({ id: orderId, machines })
    const { error } = await supabase.rpc('accept_schedule', {
      p_order_id: orderId,
      p_ship_date: expectedShipDate || p.ship_date,
      p_deadlines: deadlinesOf(p),
      p_initial: true,
    })
    if (error) toast.error(`The order was saved, but its department deadlines were not: ${friendlyError(error)}`)
  }

  const errors: Record<string, string> = triedToSave ? validate() : {}
  const err = (key: string): string | undefined => errors[key]

  return (
    <Can permission="orders.new" level="edit">
      <form onSubmit={onSubmit} className="mx-auto max-w-4xl space-y-6 pb-24" noValidate>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">New Order</h1>
          <Can permission="orders.list" fallback={<Link to="/" className="text-sm text-slate-600 underline">Cancel</Link>}>
            <Link to="/orders" className="text-sm text-slate-600 underline">
              Cancel
            </Link>
          </Can>
        </div>

        <Section title="Customer">
          <CustomerPicker
            value={customer}
            onChange={setCustomer}
            errors={{ customer: err('customer'), name: err('name'), emails: err('emails') }}
          />
        </Section>

        <Section title="Order">
          <div className="grid gap-4 md:grid-cols-2">
            {!isSplit ? (
              <Can
                permission="orders.new.field.order_number"
                level="edit"
                fallback={
                  <Field label="Order number">
                    <p className="py-2 text-sm text-slate-700">{nextNumber ? `${nextNumber} (the next number)` : 'The next number'}</p>
                  </Field>
                }
              >
                <Field
                  label="Order number"
                  htmlFor="order-number"
                  error={
                    err('orderNumber') ??
                    (orderNumberInt !== null && takenNumbers[orderNumberInt]
                      ? `Order ${orderNumberInt} already exists.${nextNumber ? ` The next free number is ${nextNumber}.` : ''}`
                      : undefined)
                  }
                  hint={nextNumber ? `The next number is ${nextNumber}.` : undefined}
                >
                  <input
                    id="order-number"
                    inputMode="numeric"
                    className={inputClass}
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                  />
                </Field>
              </Can>
            ) : (
              <Can permission="orders.new.split" level="edit">
                <Field
                  label="Split shipment of order #"
                  htmlFor="split-of"
                  error={err('splitOf') ?? (activeSplitInfo === 'not-found' ? `There is no order ${splitOfInt}.` : undefined)}
                  hint={splitPreview ?? 'The new order receives the next suffix, for example 76-2.'}
                >
                  <input
                    id="split-of"
                    inputMode="numeric"
                    className={inputClass}
                    value={splitOf}
                    placeholder="For example 76"
                    onChange={(e) => setSplitOf(e.target.value)}
                  />
                </Field>
              </Can>
            )}
            <Can
              permission="orders.new.field.stage"
              level="edit"
              fallback={
                <Field label="Stage">
                  <p className="py-2 text-sm text-slate-700">{label(stage)}</p>
                </Field>
              }
            >
              <Field label="Stage" htmlFor="stage" hint={getsSerials ? 'Added at the end of the shop queue.' : undefined}>
                <select id="stage" className={inputClass} value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
                  {NEW_ORDER_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </select>
              </Field>
            </Can>
            <Can permission="orders.new.split" level="edit">
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <input type="checkbox" checked={isSplit} onChange={(e) => setIsSplit(e.target.checked)} className="h-4 w-4" />
                This is a split shipment of another order
              </label>
            </Can>
          </div>
        </Section>

        <Section title="Machines">
          <MachinesSection
            rows={rows}
            onChange={setRows}
            machineTypes={machineTypes}
            preview={preview}
            getsSerials={getsSerials}
            errors={errors}
            crateDefault={defaults.crate}
          />
        </Section>

        <Can
          anyOf={[
            'order.field.voltage',
            'order.field.delivery_equipment',
            'order.field.freight_type',
            'order.field.expected_ship_date',
            'order.field.notes',
          ]}
          level="edit"
        >
          <Section title="Shipping">
            <div className="grid gap-4 md:grid-cols-2">
              <Can permission="order.field.voltage" level="edit">
                <Field label="Voltage" htmlFor="voltage">
                  <select id="voltage" className={inputClass} value={voltage} onChange={(e) => setVoltage(e.target.value)}>
                    {voltageOptions.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
              </Can>
              <Can permission="order.field.delivery_equipment" level="edit">
                <Field label="Delivery equipment" htmlFor="delivery">
                  <select
                    id="delivery"
                    className={inputClass}
                    value={deliveryEquipment}
                    onChange={(e) => setDeliveryEquipment(e.target.value)}
                  >
                    {deliveryOptions.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
              </Can>
              <Can permission="order.field.freight_type" level="edit">
                <Field label="Freight type" htmlFor="freight">
                  <select id="freight" className={inputClass} value={freightType} onChange={(e) => setFreightType(e.target.value)}>
                    <option value="">Not decided yet</option>
                    {freightOptions.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
              </Can>
              <Can permission="order.field.expected_ship_date" level="edit">
                <Field
                  label="Expected ship date"
                  htmlFor="ship-date"
                  hint={
                    shipHand !== null && plan
                      ? `Entered manually. Calculated date: ${showDate(plan.ship_date)}.`
                      : plan
                        ? 'Calculated from the shop queue (see Schedule below).'
                        : getsSerials
                          ? 'Calculated once machines are added.'
                          : undefined
                  }
                >
                  <div className="flex gap-2">
                    <input
                      id="ship-date"
                      type="date"
                      className={inputClass}
                      value={expectedShipDate}
                      onChange={(e) => setExpectedShipDate(e.target.value)}
                    />
                    {shipHand !== null && plan && (
                      <button type="button" className="shrink-0 text-xs text-slate-600 underline" onClick={() => setExpectedShipDate(null)}>
                        Use Calculated Date
                      </button>
                    )}
                  </div>
                </Field>
              </Can>
              <Can permission="order.field.notes" level="edit">
                <Field label="Notes" htmlFor="notes" className="md:col-span-2">
                  <RichTextEditor label="Notes" value="" onChange={setNotes} placeholder="Anything worth recording about this order" />
                </Field>
              </Can>
            </div>
          </Section>
        </Can>

        {plan && (
          <Can permission="orders.new.schedule">
            <Section title="Schedule">
              <p className="text-sm">
                Expected ship date <strong>{showDate(plan.ship_date, 'EEE, MMM d, yyyy')}</strong>
                <span className="text-slate-600"> · {workingText(plan)} · starts {showDate(plan.start)}</span>
              </p>
              {plan.averages.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">Uses the average of recent builds for: {plan.averages.join(', ')}.</p>
              )}
              <div className="mt-3">
                <Timeline items={plan.steps} />
              </div>
              {shipHand !== null && shipHand !== plan.ship_date && (
                <p className="mt-2 text-xs text-amber-800">
                  You typed {showDate(shipHand)} as the ship date; the department deadlines above still follow the shop
                  queue. {STEP_LABEL.shipping} will be promised for {showDate(shipHand)}.
                </p>
              )}
            </Section>
          </Can>
        )}

        <Can anyOf={['order.field.order_total', 'payments']} level="edit">
          <Section title="Payments">
            <div className="grid gap-4 md:grid-cols-2">
              <Can permission="order.field.order_total" level="edit">
                <Field label="Order total" htmlFor="total" error={err('total')}>
                  <div className="flex gap-2">
                    <input
                      id="total"
                      inputMode="decimal"
                      className={inputClass}
                      value={total}
                      placeholder="0.00"
                      onChange={(e) => setTotal(e.target.value)}
                    />
                    <Can permission="order.field.currency" level="edit">
                      <select
                        aria-label="Currency"
                        className={`${inputClass} w-24`}
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value as Currency)}
                      >
                        {CURRENCIES.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </Can>
                  </div>
                </Field>
              </Can>
              <Can permission="payments" level="edit">
                <Field
                  label="Down payment"
                  htmlFor="down"
                  error={err('down')}
                  hint={
                    downMode === 'percent'
                      ? downAmount !== null
                        ? `= ${formatMoney(downAmount, currency)}`
                        : undefined
                      : downPercent !== null
                        ? `= ${downPercent}% of the total`
                        : undefined
                  }
                >
                  <div className="flex gap-2">
                    <input
                      id="down"
                      inputMode="decimal"
                      className={inputClass}
                      value={downValue}
                      placeholder={downMode === 'percent' ? 'For example 30' : '0.00'}
                      onChange={(e) => setDownValue(e.target.value)}
                    />
                    <select
                      aria-label="Down payment as"
                      className={`${inputClass} w-24`}
                      value={downMode}
                      onChange={(e) => {
                        // Convert what's typed so switching doesn't lose the number.
                        const mode = e.target.value as 'amount' | 'percent'
                        if (mode === 'amount' && downAmount !== null) setDownValue(String(downAmount))
                        if (mode === 'percent' && downPercent !== null) setDownValue(String(downPercent))
                        setDownMode(mode)
                      }}
                    >
                      <option value="percent">%</option>
                      <option value="amount">{currency}</option>
                    </select>
                  </div>
                </Field>
                <Field
                  label="Down payment due"
                  htmlFor="down-due"
                  hint={downDueHand === null ? `${defaults.down_payment_days} days from today.` : undefined}
                >
                  <input id="down-due" type="date" className={inputClass} value={downDue} onChange={(e) => setDownDue(e.target.value)} />
                </Field>
                <Field
                  label="Balance due"
                  htmlFor="balance-due"
                  error={err('balanceDue') ?? (balanceSuggestion ? 'The balance would be due before the down payment.' : undefined)}
                  hint={
                    balanceDueHand === null && expectedShipDate
                      ? `${defaults.balance_days_before_ship} days before the expected ship date.`
                      : !expectedShipDate
                        ? 'Filled in once the order has an expected ship date.'
                        : undefined
                  }
                >
                  <input
                    id="balance-due"
                    type="date"
                    className={inputClass}
                    value={balanceDue}
                    onChange={(e) => setBalanceDue(e.target.value)}
                  />
                  {balanceSuggestion && (
                    <button
                      type="button"
                      className="mt-1 text-xs font-medium text-blue-700 underline"
                      onClick={() => setBalanceDue(balanceSuggestion)}
                    >
                      Use {showDate(balanceSuggestion)} instead (halfway to the ship date)
                    </button>
                  )}
                </Field>
              </Can>
            </div>
            <Can permission="payments" level="edit">
              <Can permission="order.field.order_total" level="edit">
                <div className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-sm">
                  Balance: <strong>{formatMoney(balance, currency)}</strong>
                  <span className="text-slate-500"> (order total − down payment, calculated automatically)</span>
                </div>
              </Can>
            </Can>
          </Section>
        </Can>

        <div className="sticky bottom-0 -mx-4 flex justify-end gap-3 border-t border-slate-200 bg-slate-50/95 px-4 py-3 md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
          <button type="submit" className={buttonClass} disabled={saving}>
            {saving ? 'Saving…' : 'Save Order'}
          </button>
        </div>
      </form>
    </Can>
  )
}
