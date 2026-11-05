import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { badgeClass, orderBadges } from '../components/board/badges'
import MoveDialog, { type MoveRequest } from '../components/board/MoveDialog'
import Can from '../components/Can'
import { buttonClass, inputClass, secondaryButtonClass, Section } from '../components/form'
import ActivityList from '../components/order/ActivityList'
import CratingSummary from '../components/crating/CratingSummary'
import MachineCrating from '../components/crating/MachineCrating'
import ChangeMachinesDialog from '../components/order/ChangeMachinesDialog'
import EditOrderDialog from '../components/order/EditOrderDialog'
import PaymentDialog from '../components/order/PaymentDialog'
import PaymentStatus from '../components/payments/PaymentStatus'
import ReceivePaymentDialog from '../components/payments/ReceivePaymentDialog'
import { useAlerts } from '../lib/alerts'
import { countryFlag } from '../lib/country'
import { checklistStatusText, type ChecklistStatusRow } from '../lib/checklists'
import { CRATING_STAGES, loadCrates, type CrateMachine, type NumberedCrate } from '../lib/crates'
import { showDate } from '../lib/dates'
import { formatMoney, friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { useStageLabels } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { STAGES, type Customer, type OrderSummaryRow, type PaymentRow, type Stage } from '../lib/types'

type Machine = {
  id: string
  serial_number: string | null
  serial_manual: boolean
  needs_serial: boolean
  ready: boolean
  checklist_done: boolean
  machine_types: { name: string; code: string | null } | null
}

/** Tabs; Details holds sections that each have their own permission. */
const TABS = [
  { key: 'details', label: 'Details', permission: 'order.page' },
  { key: 'activity', label: 'Activity', permission: 'order.tab.activity' },
  { key: 'emails', label: 'Emails', permission: 'order.tab.emails' },
  { key: 'ai', label: 'AI notes', permission: 'order.tab.ai_notes' },
] as const
type TabKey = (typeof TABS)[number]['key']

const stageTone: Record<Stage, string> = {
  Quote: 'bg-slate-100 text-slate-700',
  Confirmed: 'bg-blue-100 text-blue-800',
  'In production': 'bg-indigo-100 text-indigo-800',
  Ready: 'bg-cyan-100 text-cyan-800',
  'Ready to ship': 'bg-teal-100 text-teal-800',
  Shipped: 'bg-green-100 text-green-800',
  Cancelled: 'bg-slate-200 text-slate-500',
}

/* @layout-helper */
function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/* @layout-helper */
function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
      <div className="font-medium">{title}</div>
      <p className="mt-1 text-sm text-slate-500">{text}</p>
    </div>
  )
}

export default function OrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { refresh: refreshAlerts } = useAlerts()
  const [params, setParams] = useSearchParams()
  const { can } = usePermissions()
  const label = useStageLabels()
  const tabs = TABS.filter((t) => can(t.permission))
  const tab = (tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'details') as TabKey
  const seesPayments = can('payments')
  const seesCrating = can('crating')
  const seesChecks = can('checklist')

  const [order, setOrder] = useState<OrderSummaryRow | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [machines, setMachines] = useState<Machine[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [crates, setCrates] = useState<NumberedCrate[]>([])
  const [checks, setChecks] = useState<Map<string, ChecklistStatusRow>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  // Pop-ups
  const [move, setMove] = useState<MoveRequest | null>(null)
  const [editing, setEditing] = useState(false)
  const [machineChange, setMachineChange] = useState<
    { kind: 'add' } | { kind: 'remove'; machineId: string; label: string; built: boolean } | null
  >(null)
  const [paymentDialog, setPaymentDialog] = useState<{ payment: PaymentRow | null } | null>(null)
  const [receiving, setReceiving] = useState<PaymentRow | null>(null)

  // Notes are edited in place.
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  const load = useCallback(async () => {
    if (!supabase || !id) return
    const { data, error: e } = await supabase.from('order_summary').select('*').eq('id', id).maybeSingle()
    if (e || !data) {
      setError(e ? friendlyError(e) : 'This order could not be found.')
      setLoading(false)
      return
    }
    const o = data as OrderSummaryRow
    const [c, m, p, cr, ck] = await Promise.all([
      supabase.from('customer_list').select('*').eq('id', o.customer_id).maybeSingle(),
      supabase
        .from('order_machines')
        .select('id, serial_number, serial_manual, needs_serial, ready, checklist_done, machine_types(name, code)')
        .eq('order_id', id)
        .eq('archived', false)
        .order('created_at'),
      seesPayments
        ? supabase.from('payment_overview').select('*').eq('order_id', id).order('due_date', { nullsFirst: false })
        : Promise.resolve({ data: [] as PaymentRow[], error: null }),
      loadCrates(seesCrating ? [id] : []),
      seesChecks
        ? supabase.from('machine_checklist_status').select('*').eq('order_id', id)
        : Promise.resolve({ data: [] as ChecklistStatusRow[], error: null }),
    ])
    const firstError = c.error ?? m.error ?? p.error ?? cr.error
    if (firstError) toast.error(friendlyError(firstError))
    setOrder(o)
    setNotes(o.notes ?? '')
    setCustomer((c.data as Customer) ?? null)
    setMachines(
      ((m.data as unknown as Machine[]) ?? []).sort(
        (a, b) =>
          (a.machine_types?.name ?? '').localeCompare(b.machine_types?.name ?? '') ||
          (a.serial_number ?? '').localeCompare(b.serial_number ?? ''),
      ),
    )
    setPayments((p.data as PaymentRow[]) ?? [])
    setCrates(cr.byOrder.get(id) ?? [])
    setChecks(new Map(((ck.data as ChecklistStatusRow[] | null) ?? []).map((r) => [r.machine_id, r])))
    setError(null)
    setLoading(false)
    setReloadKey((k) => k + 1)
  }, [id, seesPayments, seesCrating, seesChecks])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (loading)
    return (
      <Can permission="order.page">
        <div className="p-8 text-center text-slate-500">Loading…</div>
      </Can>
    )
  if (error || !order) {
    return (
      <Can permission="order.page">
        <div className="mx-auto max-w-4xl">
          <p className="text-slate-700">{error}</p>
          <Link to="/" className="mt-4 inline-block text-sm underline">
            Back
          </Link>
        </div>
      </Can>
    )
  }

  const askMove = (stage: Stage) => setMove({ order, stage, anchor: null, place: 'after', description: `move to ${label(stage)}` })

  async function toggleReady(m: Machine) {
    if (!supabase || !canTickBuilt) return
    if (m.ready) {
      const ok = window.confirm(
        `Mark ${m.serial_number ?? 'this machine'} as NOT built? Its serial may then change to keep the board order.`,
      )
      if (!ok) return
    }
    const { error: e } = await supabase.from('order_machines').update({ ready: !m.ready }).eq('id', m.id)
    if (e) return toast.error(friendlyError(e))
    load()
  }

  async function undoReceived(p: PaymentRow) {
    if (!supabase) return
    if (!window.confirm(`Clear the received amount and date for this ${p.payment_type}?`)) return
    const { error: e } = await supabase.from('payments').update({ received_date: null, received_amount: null }).eq('id', p.id)
    if (e) return toast.error(friendlyError(e))
    toast.success('Received amount cleared.')
    refreshAlerts()
    load()
  }

  async function saveNotes() {
    if (!supabase || !order) return
    setSavingNotes(true)
    const { error: e } = await supabase.from('orders').update({ notes: notes.trim() || null }).eq('id', order.id)
    setSavingNotes(false)
    if (e) return toast.error(friendlyError(e))
    toast.success('Notes saved.')
    load()
  }

  const badges = orderBadges(order)
  const delay = order.delay_days
  const canShip = order.stage !== 'Shipped' && order.stage !== 'Cancelled'
  const canEditNotes = can('order.field.notes', 'edit')
  const canTickBuilt = can('order.machines.built', 'edit')

  // Crating: shown on Ready to ship and Shipped orders (and on any order that already has crates).
  const showCrating = seesCrating && (CRATING_STAGES.includes(order.stage) || crates.length > 0)
  const crateMachines: CrateMachine[] = machines.map((m) => ({
    id: m.id,
    label: `${m.machine_types?.name ?? 'Machine'}${m.serial_number ? ` ${m.serial_number}` : ''}`,
  }))
  const notCrated = crateMachines.filter((m) => !crates.some((c) => c.machine_ids.includes(m.id))).map((m) => m.label)

  return (
    <Can permission="order.page">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* ---------- Header ---------- */}
        <div className="space-y-3">
          <Can permission="orders.list">
            <Link to="/orders" className="text-sm text-slate-600 underline">
              ← Orders list
            </Link>
          </Can>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold">Order {order.order_code}</h1>
                <span className={`rounded px-2 py-0.5 text-sm font-medium ${stageTone[order.stage]}`}>{label(order.stage)}</span>
                {order.archived && <span className="rounded bg-slate-200 px-2 py-0.5 text-sm">Archived</span>}
              </div>
              <Can permission="order.header.customer">
                <div className="mt-1 text-slate-700">
                  {order.customer_name}
                  {order.customer_company && <span className="text-slate-500"> · {order.customer_company}</span>}
                  {order.customer_country && (
                    <span className="text-slate-500">
                      {' '}
                      · {countryFlag(order.customer_country)} {order.customer_country}
                    </span>
                  )}
                </div>
              </Can>
              <Can permission="customer.contact">
                {customer && (customer.emails.length > 0 || customer.phone) && (
                  <div className="text-sm">
                    {customer.emails.map((e, i) => (
                      <span key={e}>
                        {i > 0 && ', '}
                        <a href={`mailto:${e}`} className="text-blue-700 underline">
                          {e}
                        </a>
                      </span>
                    ))}
                    {customer.phone && (
                      <span className="text-slate-600">
                        {customer.emails.length > 0 && ' · '}
                        <a href={`tel:${customer.phone}`} className="underline">
                          {customer.phone}
                        </a>
                      </span>
                    )}
                  </div>
                )}
              </Can>
              <Can permission="order.header.badges">
                {badges.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {badges.map((b) => (
                      <span key={b.label} className={`rounded px-1.5 py-0.5 text-xs font-medium ring-1 ${badgeClass[b.tone]}`}>
                        {b.label}
                      </span>
                    ))}
                  </div>
                )}
              </Can>
            </div>

            <div className="flex flex-wrap items-center gap-2 lg:max-w-md lg:justify-end">
              <Can permission="order.action.edit" level="edit">
                <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)}>
                  ✏️ Edit
                </button>
              </Can>
              <Can permission="order.action.change_stage" level="edit">
                <select
                  aria-label="Change stage"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  value=""
                  onChange={(e) => e.target.value && askMove(e.target.value as Stage)}
                >
                  <option value="">Change stage…</option>
                  {STAGES.filter((s) => s !== order.stage).map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </select>
              </Can>
              <Can permission="order.action.mark_shipped" level="edit">
                {canShip && (
                  <button type="button" className={buttonClass} onClick={() => askMove('Shipped')}>
                    🚚 Mark shipped
                  </button>
                )}
              </Can>
              <Can permission="orders.new.split" level="edit">
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() => navigate(`/orders/new?split=${order.order_number}`)}
                >
                  ✂️ Split shipment
                </button>
              </Can>
            </div>
          </div>
        </div>

        {/* ---------- Tabs ---------- */}
        {tabs.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
            {tabs.map((t) => (
              <Can key={t.key} permission={t.permission}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setParams(t.key === 'details' ? {} : { tab: t.key }, { replace: true })}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap ${
                    tab === t.key ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {t.label}
                </button>
              </Can>
            ))}
          </div>
        )}

        <Can permission="order.tab.activity">
          {tab === 'activity' && <ActivityList orderId={order.id} reloadKey={reloadKey} />}
        </Can>
        <Can permission="order.tab.emails">
          {tab === 'emails' && (
            <Placeholder title="Emails" text="Coming in Phase 2: emails with this customer will show here automatically." />
          )}
        </Can>
        <Can permission="order.tab.ai_notes">
          {tab === 'ai' && <Placeholder title="AI notes" text="Coming in Phase 3: a short AI summary of this order and its emails." />}
        </Can>

        {tab === 'details' && (
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
              {/* ---------- Machines ---------- */}
              <Can permission="order.section.machines">
                <Section
                  title={`Machines${can('order.machines.built') ? ` · ${order.machines_ready_count} of ${order.machines_count} built` : ''}${
                    showCrating ? ` · ${machines.length - notCrated.length} of ${machines.length} crated` : ''
                  }`}
                  aside={
                    <Can permission="order.machines.add" level="edit">
                      <button type="button" className={secondaryButtonClass} onClick={() => setMachineChange({ kind: 'add' })}>
                        + Add machines
                      </button>
                    </Can>
                  }
                >
                  {machines.length === 0 ? (
                    <p className="text-sm text-slate-500">No machines on this order.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {machines.map((m) => (
                        <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                          <Can permission="order.machines.built">
                            <label className={`flex items-center gap-2 ${canTickBuilt ? 'cursor-pointer' : ''}`}>
                              <input
                                type="checkbox"
                                className="h-5 w-5 accent-green-700"
                                checked={m.ready}
                                disabled={!canTickBuilt}
                                onChange={() => toggleReady(m)}
                              />
                              <span className={m.ready ? 'font-medium text-green-700' : 'text-slate-500'}>
                                {m.ready ? 'Built' : 'Not built'}
                              </span>
                            </label>
                          </Can>
                          <span className="font-mono font-semibold sm:min-w-36">
                            {m.serial_number ??
                              (m.needs_serial ? (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 font-sans text-xs font-medium text-amber-900">
                                  Needs serial
                                </span>
                              ) : (
                                <span className="font-sans font-normal text-slate-400">No serial yet</span>
                              ))}
                          </span>
                          <span className="flex-1">{m.machine_types?.name}</span>
                          {m.serial_manual && m.serial_number && <span className="text-xs text-slate-500">serial typed by hand</span>}
                          <Can permission="order.machines.checklist">
                            {(m.ready || checks.get(m.id)?.checklist_id) && (
                              <div className="order-last basis-full border-l-2 border-blue-200 pl-2 text-sm sm:ml-8">
                                <span
                                  className={
                                    checks.get(m.id)?.status === 'signed'
                                      ? 'font-medium text-green-700'
                                      : checks.get(m.id)?.status === 'in_progress'
                                        ? 'text-blue-800'
                                        : 'text-slate-500'
                                  }
                                >
                                  Final check:{' '}
                                  {checks.get(m.id) ? checklistStatusText(checks.get(m.id)!) : 'Not started'}
                                </span>{' '}
                                <Can permission="checklist">
                                  <Link to={`/checklists/${m.id}`} className="ml-1 inline-block rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:bg-slate-50">
                                    {checks.get(m.id)?.status === 'signed'
                                      ? 'View final check'
                                      : checks.get(m.id)?.status === 'in_progress'
                                        ? 'Continue final check'
                                        : 'Final check'}
                                  </Link>
                                </Can>
                              </div>
                            )}
                          </Can>
                          {showCrating && (
                            <Can permission="crating">
                              <div className="order-last basis-full border-l-2 border-teal-200 pl-2 sm:ml-8">
                                <MachineCrating
                                  orderId={order.id}
                                  orderCode={order.order_code}
                                  machine={crateMachines.find((x) => x.id === m.id)!}
                                  orderMachines={crateMachines}
                                  crates={crates}
                                  onChanged={load}
                                />
                              </div>
                            </Can>
                          )}
                          <Can permission="order.machines.remove" level="edit">
                            <button
                              type="button"
                              className="text-xs text-red-700 underline"
                              onClick={() =>
                                setMachineChange({
                                  kind: 'remove',
                                  machineId: m.id,
                                  label: `${m.machine_types?.name ?? 'machine'}${m.serial_number ? ` ${m.serial_number}` : ''}`,
                                  built: m.ready,
                                })
                              }
                            >
                              Remove
                            </button>
                          </Can>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Can permission="order.machines.built" level="edit">
                    <p className="mt-3 text-xs text-slate-500">
                      Tick a machine when it is built: its serial is then fixed for good. Serials of machines not yet built
                      can change when the order of the shop queue changes, or when machines are added or removed.
                    </p>
                  </Can>
                </Section>
              </Can>

              {showCrating && (
                <Can permission="crating.summary">
                  <CratingSummary order={order} crates={crates} notCrated={notCrated} />
                </Can>
              )}

              {/* ---------- Payments ---------- */}
              <Can permission="order.section.payments">
                <Section
                  title="Payments"
                  aside={
                    <Can permission="payments.action.add" level="edit">
                      <button type="button" className={secondaryButtonClass} onClick={() => setPaymentDialog({ payment: null })}>
                        + Add payment
                      </button>
                    </Can>
                  }
                >
                  <dl className="mb-4 grid grid-cols-2 gap-4 rounded-md bg-slate-50 p-3 sm:grid-cols-4">
                    <Can permission="order.field.order_total">
                      <Item label="Order total">{formatMoney(order.order_total, order.currency)}</Item>
                    </Can>
                    <Item label="Down payment">
                      {order.down_payment_amount === null ? (
                        '—'
                      ) : (
                        <>
                          {formatMoney(order.down_payment_amount, order.currency)}
                          {order.down_payment_percent !== null && (
                            <span className="text-slate-500"> ({order.down_payment_percent}%)</span>
                          )}
                        </>
                      )}
                    </Item>
                    <Item label="Received">{formatMoney(order.total_paid, order.currency)}</Item>
                    <Can permission="order.field.order_total">
                      <Item label="Still to pay">
                        <span className={(order.amount_outstanding ?? 0) > 0 ? 'font-semibold' : 'text-green-700'}>
                          {formatMoney(order.amount_outstanding, order.currency)}
                        </span>
                      </Item>
                    </Can>
                  </dl>

                  {payments.length === 0 ? (
                    <p className="text-sm text-slate-500">No payments yet.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {payments.map((p) => (
                        <li key={p.id} className="grid gap-2 py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_8rem_1fr]">
                            <div>
                              <div className="font-medium">{p.payment_type}</div>
                              {p.notes && <div className="text-xs text-slate-500">{p.notes}</div>}
                            </div>
                            <div className="tabular-nums">{formatMoney(p.amount, p.currency)}</div>
                            <div className="space-y-0.5">
                              <div>
                                <span className="text-slate-500">Due:</span> {showDate(p.due_date)} <PaymentStatus payment={p} />
                              </div>
                              {p.received_amount > 0 && (
                                <div className="text-xs text-slate-600">
                                  Received {formatMoney(p.received_amount, p.currency)} on {showDate(p.received_date)}
                                  {p.remaining > 0 && <> · {formatMoney(p.remaining, p.currency)} still owed</>}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2 sm:justify-end">
                            <Can permission="payments.action.mark_received" level="edit">
                              {p.remaining > 0 && (
                                <button type="button" className={buttonClass} onClick={() => setReceiving(p)}>
                                  Mark received
                                </button>
                              )}
                            </Can>
                            <Can permission="payments.action.edit" level="edit">
                              <button type="button" className={secondaryButtonClass} onClick={() => setPaymentDialog({ payment: p })}>
                                Edit
                              </button>
                            </Can>
                            <Can permission="payments.action.undo_received" level="edit">
                              {p.received_amount > 0 && (
                                <button type="button" className="text-xs text-slate-600 underline" onClick={() => undoReceived(p)}>
                                  Undo received
                                </button>
                              )}
                            </Can>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </Can>
            </div>

            <div className="space-y-5">
              {/* ---------- Shipping ---------- */}
              <Can permission="order.section.shipping">
                <Section title="Shipping">
                  <dl className="grid grid-cols-2 gap-4">
                    <Can permission="order.field.expected_ship_date">
                      <Item label="Expected ship date">{showDate(order.expected_ship_date)}</Item>
                    </Can>
                    <Can permission="order.field.actual_ship_date">
                      <Item label="Actual ship date">{showDate(order.actual_ship_date)}</Item>
                    </Can>
                    <Can permission="order.field.delay">
                      <Item label="Delay">
                        {delay === null ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <span className={`font-semibold ${delay > 0 ? 'text-red-700' : 'text-green-700'}`}>
                            {delay === 0
                              ? 'On time'
                              : delay > 0
                                ? `${delay} day${delay === 1 ? '' : 's'} late`
                                : `${-delay} day${delay === -1 ? '' : 's'} early`}
                          </span>
                        )}
                      </Item>
                    </Can>
                    <Can permission="order.field.voltage">
                      <Item label="Voltage">
                        <span className={order.voltage === 'Unknown' ? 'text-amber-700' : ''}>{order.voltage}</span>
                      </Item>
                    </Can>
                    <Can permission="order.field.delivery_equipment">
                      <Item label="Delivery equipment">{order.delivery_equipment}</Item>
                    </Can>
                    <Can permission="order.field.freight_type">
                      <Item label="Freight type">{order.freight_type ?? '—'}</Item>
                    </Can>
                    <Can permission="order.field.order_date">
                      <Item label="Order date">{showDate(order.order_date)}</Item>
                    </Can>
                    <Can permission="order.field.currency">
                      <Item label="Currency">{order.currency}</Item>
                    </Can>
                  </dl>
                </Section>
              </Can>

              {/* ---------- Notes ---------- */}
              <Can permission="order.field.notes">
                <Section title="Notes">
                  <Can
                    permission="order.field.notes"
                    level="edit"
                    fallback={<p className="text-sm whitespace-pre-wrap text-slate-700">{order.notes || '—'}</p>}
                  >
                    <textarea
                      aria-label="Notes"
                      rows={5}
                      className={inputClass}
                      value={notes}
                      readOnly={!canEditNotes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Anything worth remembering about this order"
                    />
                    {notes !== (order.notes ?? '') && (
                      <div className="mt-2 flex justify-end gap-2">
                        <button type="button" className="text-sm underline" onClick={() => setNotes(order.notes ?? '')}>
                          Undo
                        </button>
                        <button type="button" className={buttonClass} onClick={saveNotes} disabled={savingNotes}>
                          {savingNotes ? 'Saving…' : 'Save notes'}
                        </button>
                      </div>
                    )}
                  </Can>
                </Section>
              </Can>
            </div>
          </div>
        )}

        {/* ---------- Pop-ups ---------- */}
        {move && (
          <MoveDialog
            request={move}
            onClose={() => setMove(null)}
            onDone={(n) => {
              toast.success(`Order ${order.order_code} moved.${n ? ` ${n} serial number${n === 1 ? '' : 's'} changed.` : ''}`)
              setMove(null)
              load()
            }}
          />
        )}
        {machineChange && (
          <ChangeMachinesDialog
            orderId={order.id}
            orderCode={order.order_code}
            stage={order.stage}
            mode={machineChange}
            onClose={() => setMachineChange(null)}
            onDone={(message) => {
              toast.success(message)
              setMachineChange(null)
              load()
            }}
          />
        )}
        {editing && (
          <EditOrderDialog
            order={order}
            onClose={() => setEditing(false)}
            onDone={() => {
              toast.success('Order saved.')
              setEditing(false)
              load()
            }}
          />
        )}
        {paymentDialog && (
          <PaymentDialog
            order={order}
            payment={paymentDialog.payment}
            existingTypes={payments.map((p) => p.payment_type)}
            onClose={() => setPaymentDialog(null)}
            onDone={() => {
              toast.success('Payment saved.')
              setPaymentDialog(null)
              load()
            }}
          />
        )}
        {receiving && (
          <ReceivePaymentDialog
            payment={receiving}
            onClose={() => setReceiving(null)}
            onDone={() => {
              toast.success(`${receiving.payment_type} marked received.`)
              setReceiving(null)
              load()
            }}
          />
        )}
      </div>
    </Can>
  )
}
