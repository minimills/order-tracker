import { format, parseISO } from 'date-fns'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import DelayChart, { type MonthDelay } from '../components/dashboard/DelayChart'
import { dueText } from '../components/payments/dueText'
import { countryFlag } from '../lib/country'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { formatMoney, friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { OrderSummaryRow, PaymentRow } from '../lib/types'

/** Stages where the money is really owed (not quotes, not cancelled). */
const OWED_STAGES = ['Confirmed', 'In production', 'Ready to ship', 'Shipped']

function sumByCurrency<T>(rows: T[], currency: (r: T) => string, amount: (r: T) => number) {
  const sums: Record<string, number> = {}
  for (const r of rows) sums[currency(r)] = (sums[currency(r)] ?? 0) + Number(amount(r))
  return Object.entries(sums)
    .filter(([, n]) => Math.abs(n) >= 0.005)
    .sort(([a], [b]) => a.localeCompare(b))
}

function delayWords(d: number) {
  const r = Math.round(d * 10) / 10
  if (r === 0) return 'On time'
  return r > 0 ? `${r} day${r === 1 ? '' : 's'} late` : `${-r} day${r === -1 ? '' : 's'} early`
}

function Card({
  title,
  to,
  children,
  tone = '',
  className = '',
}: {
  title: string
  to: string
  children: ReactNode
  tone?: string
  className?: string
}) {
  return (
    <Link to={to} className={`block rounded-lg border bg-white p-4 hover:border-slate-400 hover:shadow-sm ${tone || 'border-slate-200'} ${className}`}>
      <div className="text-sm text-slate-600">{title}</div>
      <div className="mt-1">{children}</div>
    </Link>
  )
}

function Big({ children }: { children: ReactNode }) {
  return <div className="text-3xl font-semibold tabular-nums">{children}</div>
}

function Box({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

export default function DashboardPage() {
  const [orders, setOrders] = useState<OrderSummaryRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const today = todayISO()

  const load = useCallback(async () => {
    if (!supabase) return
    const [o, p] = await Promise.all([
      fetchAll<OrderSummaryRow>(() => supabase!.from('order_summary').select('*').eq('archived', false).order('id')),
      fetchAll<PaymentRow>(() =>
        supabase!
          .from('payment_overview')
          .select('*')
          .gt('remaining', 0)
          .eq('order_archived', false)
          .neq('stage', 'Cancelled')
          .order('due_date', { nullsFirst: false })
          .order('id'),
      ),
    ])
    const error = o.error ?? p.error
    if (error) toast.error(friendlyError(error))
    setOrders(o.data)
    setPayments(p.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const stats = useMemo(() => {
    const year = today.slice(0, 4)
    const inProduction = orders.filter((o) => o.stage === 'In production').length
    const readyToShip = orders.filter((o) => o.stage === 'Ready to ship').length
    const outstanding = sumByCurrency(
      orders.filter((o) => OWED_STAGES.includes(o.stage) && o.amount_outstanding > 0),
      (o) => o.currency,
      (o) => o.amount_outstanding,
    )
    const overdue = payments.filter((p) => p.status === 'Overdue')
    const overdueSums = sumByCurrency(overdue, (p) => p.currency, (p) => p.remaining)

    const shipped = orders.filter((o) => o.stage === 'Shipped' && o.actual_ship_date)
    const withDelay = shipped.filter((o) => o.delay_days !== null)
    const thisYear = withDelay.filter((o) => o.actual_ship_date!.startsWith(year))
    const avgDelay = thisYear.length ? thisYear.reduce((s, o) => s + o.delay_days!, 0) / thisYear.length : null

    // Last 12 months, oldest first.
    const months: MonthDelay[] = []
    const start = parseISO(`${today.slice(0, 7)}-01`)
    for (let i = 11; i >= 0; i--) {
      const d = new Date(start.getFullYear(), start.getMonth() - i, 1)
      const key = format(d, 'yyyy-MM')
      const list = withDelay.filter((o) => o.actual_ship_date!.startsWith(key))
      months.push({
        month: key,
        label: format(d, 'MMM'),
        longLabel: format(d, 'MMMM yyyy'),
        average: list.length ? list.reduce((s, o) => s + o.delay_days!, 0) / list.length : null,
        orders: list.length,
      })
    }

    const latestShipped = [...shipped]
      .sort((a, b) => b.actual_ship_date!.localeCompare(a.actual_ship_date!) || b.order_number - a.order_number)
      .slice(0, 5)

    const upcomingShips = orders
      .filter((o) => ['Confirmed', 'In production', 'Ready to ship'].includes(o.stage) && o.expected_ship_date)
      .sort((a, b) => a.expected_ship_date!.localeCompare(b.expected_ship_date!))
      .slice(0, 10)

    const upcomingPayments = payments.filter((p) => p.due_date && p.due_date >= today).slice(0, 10)

    return {
      year,
      inProduction,
      readyToShip,
      outstanding,
      overdue,
      overdueSums,
      avgDelay,
      shippedThisYear: thisYear.length,
      months,
      latestShipped,
      upcomingShips,
      upcomingPayments,
    }
  }, [orders, payments, today])

  if (loading) return <div className="p-8 text-center text-slate-500">Loading…</div>

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-slate-600">{showDate(today, 'EEEE, MMMM d, yyyy')}</p>
      </div>

      {/* ---------- Cards ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card title="In production" to="/board">
          <Big>{stats.inProduction}</Big>
        </Card>
        <Card title="Ready to ship" to="/board">
          <Big>{stats.readyToShip}</Big>
        </Card>
        <Card
          title="Payments overdue"
          to="/payments"
          tone={stats.overdue.length ? 'border-red-300 bg-red-50' : ''}
        >
          <Big>
            <span className={stats.overdue.length ? 'text-red-800' : ''}>{stats.overdue.length}</span>
          </Big>
          {stats.overdueSums.map(([cur, n]) => (
            <div key={cur} className="text-sm text-red-800 tabular-nums">
              {formatMoney(n, cur)}
            </div>
          ))}
        </Card>
        <Card title="Money still owed" to="/payments">
          {stats.outstanding.length === 0 ? (
            <Big>—</Big>
          ) : (
            stats.outstanding.map(([cur, n]) => (
              <div key={cur} className="text-xl font-semibold tabular-nums">
                {formatMoney(n, cur)}
              </div>
            ))
          )}
        </Card>
        <Card
          title={`Average delay (${stats.year})`}
          to="/orders?stage=Shipped&sort=actual&dir=desc"
          className="col-span-2 lg:col-span-1"
        >
          {stats.avgDelay === null ? (
            <Big>—</Big>
          ) : (
            <Big>
              <span className={stats.avgDelay > 0 ? 'text-red-700' : 'text-green-700'}>
                {Math.round(stats.avgDelay * 10) / 10 > 0 ? '+' : ''}
                {Math.round(stats.avgDelay * 10) / 10}
              </span>
              <span className="ml-1 text-base font-normal text-slate-500">days</span>
            </Big>
          )}
          <div className="text-xs text-slate-500">
            {stats.shippedThisYear} order{stats.shippedThisYear === 1 ? '' : 's'} shipped this year
          </div>
        </Card>
      </div>

      {/* ---------- Delay chart + latest shipped ---------- */}
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Box title="Average delay by month" aside={<span className="text-xs text-slate-500">last 12 months</span>}>
          <DelayChart months={stats.months} />
        </Box>
        <Box title="Latest shipped">
          {stats.latestShipped.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing shipped yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {stats.latestShipped.map((o) => (
                <li key={o.id}>
                  <Link to={`/orders/${o.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-slate-50">
                    <span className="min-w-0">
                      <span className="font-medium">Order {o.order_code}</span>
                      <span className="block truncate text-slate-600">
                        {o.customer_name} {countryFlag(o.customer_country)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-slate-600">{showDate(o.actual_ship_date)}</span>
                      <span
                        className={`block font-medium ${
                          o.delay_days === null ? 'text-slate-400' : o.delay_days > 0 ? 'text-red-700' : 'text-green-700'
                        }`}
                      >
                        {o.delay_days === null ? 'No expected date' : delayWords(o.delay_days)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Box>
      </div>

      {/* ---------- Upcoming ---------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Box title="Next ship dates" aside={<Link to="/board" className="text-xs text-slate-600 underline">Board</Link>}>
          {stats.upcomingShips.length === 0 ? (
            <p className="text-sm text-slate-500">No expected ship dates set.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {stats.upcomingShips.map((o) => {
                const d = o.days_until_ship ?? 0
                return (
                  <li key={o.id}>
                    <Link to={`/orders/${o.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-slate-50">
                      <span className="min-w-0">
                        <span className="font-medium">
                          Order {o.order_code}
                        </span>
                        <span className="block truncate text-slate-600">
                          {o.customer_name} · {o.machines_ready_count}/{o.machines_count} built · {o.stage}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block">{showDate(o.expected_ship_date)}</span>
                        <span className={`block text-xs ${d < 0 ? 'font-medium text-red-700' : d <= 14 ? 'text-amber-700' : 'text-slate-500'}`}>
                          {d < 0 ? `${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'Today' : `in ${d} day${d === 1 ? '' : 's'}`}
                        </span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Box>

        <Box
          title="Next payments due"
          aside={<Link to="/payments" className="text-xs text-slate-600 underline">All payments</Link>}
        >
          {stats.upcomingPayments.length === 0 ? (
            <p className="text-sm text-slate-500">No upcoming due dates.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {stats.upcomingPayments.map((p) => (
                <li key={p.id}>
                  <Link to={`/orders/${p.order_id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-slate-50">
                    <span className="min-w-0">
                      <span className="font-medium">Order {p.order_code}</span>
                      <span className="text-slate-500"> · {p.payment_type}</span>
                      <span className="block truncate text-slate-600">{p.customer_name}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-medium tabular-nums">{formatMoney(p.remaining, p.currency)}</span>
                      <span className={`block text-xs ${p.status === 'Due soon' ? 'text-amber-700' : 'text-slate-500'}`}>
                        {showDate(p.due_date)} · {dueText(p) || 'Upcoming'}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {stats.overdue.length > 0 && (
            <Link to="/payments" className="mt-3 block rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 hover:bg-red-100">
              Plus {stats.overdue.length} overdue payment{stats.overdue.length === 1 ? '' : 's'} →
            </Link>
          )}
        </Box>
      </div>
    </div>
  )
}
