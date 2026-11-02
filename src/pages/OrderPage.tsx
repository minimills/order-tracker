import { format, parseISO } from 'date-fns'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Section } from '../components/form'
import { formatMoney, friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { Customer } from '../lib/types'

type OrderSummary = {
  id: string
  order_code: string
  stage: string
  board_position: number | null
  order_date: string
  customer_id: string
  currency: string
  order_total: number
  expected_ship_date: string | null
  actual_ship_date: string | null
  delay_days: number | null
  voltage: string
  delivery_equipment: string
  freight_type: string | null
  notes: string | null
  machines_count: number
  machines_ready_count: number
  down_payment_percent: number | null
  total_paid: number
  amount_outstanding: number
  archived: boolean
}

type Machine = {
  id: string
  serial_number: string | null
  serial_manual: boolean
  ready: boolean
  machine_types: { name: string; code: string | null } | null
}

type Payment = {
  id: string
  payment_type: string
  amount: number
  due_date: string | null
  received_date: string | null
}

function showDate(d: string | null) {
  return d ? format(parseISO(d), 'MMM d, yyyy') : '—'
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/** Read-only view of one order. Editing comes in a later step. */
export default function OrderPage() {
  const { id } = useParams()
  const [order, setOrder] = useState<OrderSummary | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [machines, setMachines] = useState<Machine[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase || !id) return
    let cancelled = false
    ;(async () => {
      const { data, error: e } = await supabase!.from('order_summary').select('*').eq('id', id).maybeSingle()
      if (cancelled) return
      if (e || !data) {
        setError(e ? friendlyError(e) : 'This order could not be found.')
        setLoading(false)
        return
      }
      const o = data as OrderSummary
      const [c, m, p] = await Promise.all([
        supabase!.from('customers').select('*').eq('id', o.customer_id).maybeSingle(),
        supabase!
          .from('order_machines')
          .select('id, serial_number, serial_manual, ready, machine_types(name, code)')
          .eq('order_id', id)
          .eq('archived', false)
          .order('created_at'),
        supabase!
          .from('payments')
          .select('id, payment_type, amount, due_date, received_date')
          .eq('order_id', id)
          .order('created_at'),
      ])
      if (cancelled) return
      setOrder(o)
      setCustomer((c.data as Customer) ?? null)
      setMachines((m.data as unknown as Machine[]) ?? [])
      setPayments((p.data as Payment[]) ?? [])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  if (loading) return <div className="p-8 text-center text-slate-500">Loading…</div>
  if (error || !order) {
    return (
      <div className="mx-auto max-w-4xl">
        <p className="text-slate-700">{error}</p>
        <Link to="/orders" className="mt-4 inline-block text-sm underline">
          Back to orders
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Order {order.order_code}</h1>
          <p className="text-sm text-slate-600">
            {order.stage}
            {order.board_position !== null && <> · Board #{order.board_position}</>}
            {order.archived && <> · Archived</>} · Entered {showDate(order.order_date)}
          </p>
        </div>
        <Link to="/orders/new" className="text-sm underline">
          + New order
        </Link>
      </div>

      <Section title="Customer">
        {customer ? (
          <div className="text-sm">
            <div className="font-medium">{customer.name}</div>
            {customer.company && <div>{customer.company}</div>}
            <div className="text-slate-600">{[customer.state_province, customer.country].filter(Boolean).join(', ')}</div>
            {customer.emails.length > 0 && <div className="text-slate-600">{customer.emails.join(', ')}</div>}
          </div>
        ) : (
          <p className="text-sm text-slate-500">—</p>
        )}
      </Section>

      <Section title={`Machines (${order.machines_ready_count} of ${order.machines_count} built)`}>
        {machines.length === 0 ? (
          <p className="text-sm text-slate-500">No machines.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {machines.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{m.machine_types?.name}</span>
                <span className="font-mono">
                  {m.serial_number ?? <span className="font-sans text-slate-500">No serial yet</span>}
                  {m.serial_manual && <span className="ml-2 font-sans text-xs text-slate-500">(typed by hand)</span>}
                  {m.ready && <span className="ml-2 font-sans text-xs text-green-700">Built</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Shipping">
        <dl className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          <Item label="Expected ship date">{showDate(order.expected_ship_date)}</Item>
          <Item label="Actual ship date">{showDate(order.actual_ship_date)}</Item>
          <Item label="Delay">
            {order.delay_days === null
              ? '—'
              : order.delay_days === 0
                ? 'On time'
                : order.delay_days > 0
                  ? `${order.delay_days} days late`
                  : `${-order.delay_days} days early`}
          </Item>
          <Item label="Voltage">{order.voltage}</Item>
          <Item label="Delivery equipment">{order.delivery_equipment}</Item>
          <Item label="Freight type">{order.freight_type ?? '—'}</Item>
        </dl>
        {order.notes && <p className="mt-4 whitespace-pre-wrap text-sm">{order.notes}</p>}
      </Section>

      <Section title="Payments">
        <dl className="mb-4 grid gap-4 sm:grid-cols-3">
          <Item label="Order total">{formatMoney(order.order_total, order.currency)}</Item>
          <Item label="Paid">{formatMoney(order.total_paid, order.currency)}</Item>
          <Item label="Still to pay">{formatMoney(order.amount_outstanding, order.currency)}</Item>
        </dl>
        {payments.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 font-normal">Payment</th>
                <th className="py-1 font-normal">Amount</th>
                <th className="py-1 font-normal">Due</th>
                <th className="py-1 font-normal">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="py-2">
                    {p.payment_type}
                    {p.payment_type === 'Down payment' && order.down_payment_percent !== null && (
                      <span className="text-slate-500"> ({order.down_payment_percent}%)</span>
                    )}
                  </td>
                  <td className="py-2">{formatMoney(p.amount, order.currency)}</td>
                  <td className="py-2">{showDate(p.due_date)}</td>
                  <td className="py-2">{showDate(p.received_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  )
}
