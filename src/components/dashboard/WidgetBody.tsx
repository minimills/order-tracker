// @permission-scope dashboard
/* Drawn only inside a widget frame, which checks the widget's own permission (widgetAllowed). */
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { countryFlag } from '../../lib/country'
import { chartDef, lastYear, loadChartSettings, rangeDates, rangeText, showNumber, type ChartResult, type ChartSettings, type ChartType } from '../../lib/dashboardCharts'
import type { DashData } from '../../lib/dashboardData'
import { showDate, todayISO } from '../../lib/dates'
import { formatMoney } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { useStageLabels } from '../../lib/stages'
import { BOARD_STAGES, type OrderSummaryRow } from '../../lib/types'
import { colourHex, widgetDef, type Widget } from '../../lib/widgets'
import { dueText } from '../payments/dueText'
import ScheduleChanges from '../schedule/ScheduleChanges'
import WhosOff from '../timesheets/WhosOff'
import CompareChart from '../freight/CompareChart'
import ChartView from './ChartView'
import MyWorkWidget from './MyWorkWidget'
import { HealthColour } from '../../lib/healthColour'

/** Tells the frame the number its good / bad colours judge (null = none). */
type OnValue = (v: number | null) => void
function useReport(onValue: OnValue | undefined, v: number | null | undefined) {
  useEffect(() => {
    if (v !== undefined) onValue?.(v)
  }, [onValue, v])
}

/** Loads something once per refresh (the data object changes on every refresh). */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: boolean }>({ data: null, error: false })
  useEffect(() => {
    let off = false
    load()
      .then((data) => !off && setState({ data, error: false }))
      .catch(() => !off && setState({ data: null, error: true }))
    return () => {
      off = true
    }
    // deps hold everything the load depends on.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

const Empty = ({ children }: { children: ReactNode }) => <p className="py-3 text-sm text-slate-500">{children}</p>
const Loading = () => <p className="py-3 text-sm text-slate-500">Loading…</p>
const Failed = () => <p className="py-3 text-sm text-slate-500">This could not be loaded. It will try again at the next refresh.</p>

/** A line that opens a page when the person may open it. */
function Row({ to, children }: { to?: string | null; children: ReactNode }) {
  const cls = 'flex items-center justify-between gap-3 py-1.5'
  return to ? (
    <Link to={to} className={`${cls} rounded hover:bg-slate-50`}>
      {children}
    </Link>
  ) : (
    <div className={cls}>{children}</div>
  )
}

const OWED = ['Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped']
function sums<T>(rows: T[], cur: (r: T) => string, amount: (r: T) => number) {
  const m: Record<string, number> = {}
  for (const r of rows) m[cur(r)] = (m[cur(r)] ?? 0) + Number(amount(r))
  return Object.entries(m).filter(([, n]) => Math.abs(n) >= 0.005).sort(([a], [b]) => a.localeCompare(b))
}

/** The orders a widget's country / machine type filters keep. */
async function ordersFor(data: DashData, w: Widget) {
  let rows = await data.summary()
  const f = w.filters
  if (f?.country) rows = rows.filter((o) => (o.customer_country ?? '') === f.country)
  if (f?.machineType) {
    const ids = new Set((await data.orderMachines()).filter((m) => m.machine_type === f.machineType).map((m) => m.order_id))
    rows = rows.filter((o) => ids.has(o.id))
  }
  return rows
}

export default function WidgetBody({
  widget,
  data,
  print,
  onNote,
  canEditNote,
  onValue,
}: {
  widget: Widget
  data: DashData
  print?: boolean
  onNote?: (text: string) => void
  canEditNote?: boolean
  onValue?: OnValue
}) {
  const def = widgetDef(widget.key)
  if (!def) return <Empty>This widget is no longer available.</Empty>
  switch (def.kind) {
    case 'kpi':
      return <Kpi widget={widget} data={data} onValue={onValue} />
    case 'chart':
      return <ChartWidget widget={widget} data={data} print={print} onValue={onValue} />
    case 'list':
      return <ListWidget widget={widget} data={data} onValue={onValue} />
    case 'schedule':
      return <ScheduleWidget data={data} />
    case 'board':
      return <BoardSnapshot widget={widget} data={data} />
    case 'calendar':
      return <CalendarToday data={data} />
    case 'events':
      return <Events widget={widget} data={data} />
    case 'holidays':
      return <Holidays widget={widget} data={data} />
    case 'whos_off':
      return <WhosOff bare key={String(data.loadedAt.getTime())} />
    case 'notices':
      return <Notices widget={widget} data={data} />
    case 'chats':
      return <Chats widget={widget} data={data} />
    case 'freight':
      return <Freight widget={widget} data={data} />
    case 'labour':
      return <Labour widget={widget} data={data} />
    case 'work':
      return <MyWorkWidget widget={widget} data={data} print={print} />
    case 'note':
      return <Note widget={widget} onNote={onNote} canEdit={!!canEditNote && !print} />
  }
}

// ---------------------------------------------------------------------------
const STAGE_OF: Record<string, string> = { in_production: 'In production', ready: 'Ready', ready_to_ship: 'Ready to ship' }
/** The one number of a number widget (what its good / bad colours judge). */
function kpiValue(metric: string, orders: OrderSummaryRow[], pays: Awaited<ReturnType<DashData['payDue']>>, widget: Widget): number | null {
  if (STAGE_OF[metric]) return orders.filter((o) => o.stage === STAGE_OF[metric]).length
  if (metric === 'payments_overdue') return pays.filter((p) => p.status === 'Overdue').length
  if (metric === 'average_delay') {
    const r = rangeDates({ range: widget.range ?? 'ytd', from: widget.from, to: widget.to })
    const l = orders.filter((o) => o.delay_days !== null && o.actual_ship_date && o.actual_ship_date >= r.from && o.actual_ship_date <= r.to)
    return l.length ? Math.round((l.reduce((a, o) => a + o.delay_days!, 0) / l.length) * 10) / 10 : null
  }
  return null
}

function Kpi({ widget, data, onValue }: { widget: Widget; data: DashData; onValue?: OnValue }) {
  const label = useStageLabels()
  const { can } = usePermissions()
  const metric = widget.key.slice(4)
  const colour = useContext(HealthColour) ?? colourHex(widget.colour)
  const s = useLoad(async () => {
    const orders = await ordersFor(data, widget)
    const pays = metric === 'payments_overdue' ? await data.payDue() : []
    return { orders, pays }
  }, [data, metric, JSON.stringify(widget.filters)])
  const value = s.data ? kpiValue(metric, s.data.orders, s.data.pays, widget) : undefined
  useReport(onValue, value)
  if (s.error) return <Failed />
  if (!s.data) return <Loading />
  const { orders, pays } = s.data
  const big = (v: ReactNode, sub?: ReactNode, to?: string) => (
    <div className="flex h-full flex-col justify-center">
      {to ? (
        <Link to={to} className="text-4xl font-semibold tabular-nums hover:underline" style={{ color: colour }}>
          {v}
        </Link>
      ) : (
        <p className="text-4xl font-semibold tabular-nums" style={{ color: colour }}>
          {v}
        </p>
      )}
      {sub && <div className="mt-1 text-sm text-slate-600">{sub}</div>}
    </div>
  )
  const board = can('orders.board') ? '/board' : undefined
  if (metric === 'in_production' || metric === 'ready' || metric === 'ready_to_ship') {
    const stage = metric === 'in_production' ? 'In production' : metric === 'ready' ? 'Ready' : 'Ready to ship'
    return big(orders.filter((o) => o.stage === stage).length, `orders · ${label(stage)}`, board)
  }
  if (metric === 'payments_overdue') {
    const over = pays.filter((p) => p.status === 'Overdue')
    return big(
      over.length,
      sums(over, (p) => p.currency, (p) => p.remaining).map(([c, n]) => (
        <div key={c} className="text-red-800 tabular-nums">
          {formatMoney(n, c)}
        </div>
      )),
      can('payments.page') ? '/payments' : undefined,
    )
  }
  if (metric === 'money_owed') {
    const list = sums(orders.filter((o) => OWED.includes(o.stage) && (o.amount_outstanding ?? 0) > 0), (o) => o.currency, (o) => o.amount_outstanding ?? 0)
    return (
      <div className="flex h-full flex-col justify-center">
        {list.length === 0 ? (
          <p className="text-3xl font-semibold">—</p>
        ) : (
          list.map(([c, n]) => (
            <p key={c} className="text-xl font-semibold tabular-nums [overflow-wrap:anywhere]" style={{ color: colour }}>
              {formatMoney(n, c)}
            </p>
          ))
        )}
        <p className="text-sm text-slate-600">still owed</p>
      </div>
    )
  }
  // average delay in the dates chosen (and the same dates last year)
  const r = rangeDates({ range: widget.range ?? 'ytd', from: widget.from, to: widget.to })
  const avg = (from: string, to: string) => {
    const l = orders.filter((o) => o.delay_days !== null && o.actual_ship_date && o.actual_ship_date >= from && o.actual_ship_date <= to)
    return l.length ? { v: Math.round((l.reduce((a, o) => a + o.delay_days!, 0) / l.length) * 10) / 10, n: l.length } : null
  }
  const now = avg(r.from, r.to)
  const prev = widget.compare ? avg(lastYear(r).from, lastYear(r).to) : null
  return big(
    now ? `${now.v > 0 ? '+' : ''}${now.v}` : '—',
    <>
      <span>days late on average · {now?.n ?? 0} shipped · {rangeText({ range: widget.range ?? 'ytd', from: widget.from, to: widget.to })}</span>
      {widget.compare && <span className="block">Same dates last year: {prev ? `${prev.v > 0 ? '+' : ''}${prev.v} days` : 'nothing shipped'}</span>}
    </>,
  )
}

// ---------------------------------------------------------------------------
function ChartWidget({ widget, data, print, onValue }: { widget: Widget; data: DashData; print?: boolean; onValue?: OnValue }) {
  const def = chartDef(widget.key.slice(6))
  const [settings, setSettings] = useState<ChartSettings | null>(null)
  useEffect(() => {
    loadChartSettings().then(setSettings)
  }, [])
  const display: ChartType = widget.display && def?.types.includes(widget.display) ? widget.display : def?.defaultType ?? 'column'
  const cfg = { id: widget.id, chart: def?.key ?? '', type: display, range: widget.range ?? '12m', from: widget.from, to: widget.to, filters: widget.filters }
  const s = useLoad(async () => {
    if (!def) return null
    const r = rangeDates(cfg)
    const now = await def.load(data, r, cfg)
    const before = widget.compare && !def.now ? await def.load(data, lastYear(r), cfg) : null
    return { now, before }
  }, [data, JSON.stringify(cfg), widget.compare])
  useReport(onValue, s.data ? (s.data.now?.headline?.value ?? null) : undefined)
  if (!def) return <Empty>This chart is no longer available.</Empty>
  if (s.error) return <Failed />
  if (!s.data) return <Loading />
  const { now, before } = s.data as { now: ChartResult; before: ChartResult | null }
  const colour = colourHex(widget.colour)
  const sub = def.now ? 'Now' : `${rangeText(cfg)}${before ? ', compared with the same dates last year' : ''}`
  if (before && (display === 'column' || display === 'line' || display === 'bar')) {
    const labels = [...new Set([...before.points.map((p) => p.label), ...now.points.map((p) => p.label)])]
    const points = labels.map((l) => ({ key: l, label: l, long: now.points.find((p) => p.label === l)?.long ?? l, a: now.points.find((p) => p.label === l)?.value ?? 0, b: before.points.find((p) => p.label === l)?.value ?? 0 }))
    return (
      <div>
        <p className="mb-1 text-xs text-slate-500">{sub}</p>
        <CompareChart title={def.title} points={points} nameA="These dates" nameB="Last year" unit={now.unit} />
      </div>
    )
  }
  return (
    <div>
      <p className="mb-1 text-xs text-slate-500">{sub}</p>
      <ChartView title={def.title} type={display} result={now} target={settings?.targets[def.key]} print={print} color={colour} />
      {before && (
        <p className="mt-1 text-xs text-slate-600">
          Same dates last year: {before.headline ? `${showNumber(before.headline.value)} ${before.headline.label}` : `${showNumber(before.points.reduce((a, p) => a + p.value, 0))} ${before.unit}`}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
function delayWords(d: number) {
  const r = Math.round(d * 10) / 10
  if (r === 0) return 'On time'
  return r > 0 ? `${r} day${r === 1 ? '' : 's'} late` : `${-r} day${r === -1 ? '' : 's'} early`
}

function ListWidget({ widget, data, onValue }: { widget: Widget; data: DashData; onValue?: OnValue }) {
  const { session } = useAuth()
  const { can } = usePermissions()
  const label = useStageLabels()
  const me = session?.user.email?.toLowerCase() ?? ''
  const kind = widget.key.slice(5)
  const limit = widget.limit ?? widgetDef(widget.key)?.limit ?? 8
  const today = todayISO()
  const orderLink = (id: string) => (can('order.page') ? `/orders/${id}` : null)
  const s = useLoad(async () => {
    if (kind === 'my_tasks') return { tasks: (await data.myTasks(me)).filter((t) => !widget.filters?.board || t.board_id === widget.filters.board) }
    if (kind === 'overdue') {
      const tasks = can('boards') ? (await data.myTasks(me)).filter((t) => t.due_date && t.due_date < today) : []
      const pays = can('payments') ? (await data.payDue()).filter((p) => p.status === 'Overdue') : []
      const ships = (await data.summary()).filter((o) => BOARD_STAGES.includes(o.stage) && o.expected_ship_date && o.expected_ship_date < today)
      return { tasks, pays, ships }
    }
    if (kind === 'payments_due') {
      const pays = (await data.payDue()).filter((p) => p.due_date && p.due_date >= today && (!widget.filters?.country || (p as { customer_country?: string | null }).customer_country === widget.filters.country))
      return { pays }
    }
    return { orders: await ordersFor(data, widget) }
  }, [data, kind, me, JSON.stringify(widget.filters)])
  const counts = s.data as { tasks?: unknown[]; pays?: unknown[]; ships?: unknown[] } | null
  useReport(onValue, kind === 'overdue' ? (counts ? (counts.tasks?.length ?? 0) + (counts.pays?.length ?? 0) + (counts.ships?.length ?? 0) : undefined) : null)
  if (s.error) return <Failed />
  if (!s.data) return <Loading />
  const d = s.data as { tasks?: Awaited<ReturnType<DashData['myTasks']>>; pays?: Awaited<ReturnType<DashData['payDue']>>; ships?: OrderSummaryRow[]; orders?: OrderSummaryRow[] }
  const taskRow = (t: NonNullable<typeof d.tasks>[number]) => (
    <li key={t.id}>
      <Row to={can('boards.card.open') ? `/boards/${t.board_id}?card=${t.id}` : null}>
        <span className="min-w-0">
          <span className="block truncate font-medium">{t.title}</span>
          <span className="block truncate text-xs text-slate-500">{t.board_name}</span>
        </span>
        <span className={`shrink-0 text-xs ${t.due_date && t.due_date < today ? 'font-semibold text-red-700' : 'text-slate-600'}`}>{t.due_date ? showDate(t.due_date, 'MMM d') : 'No due date'}</span>
      </Row>
    </li>
  )
  const ul = (items: ReactNode[], empty: string) => (items.length ? <ul className="divide-y divide-slate-100 text-sm">{items.slice(0, limit)}</ul> : <Empty>{empty}</Empty>)

  if (kind === 'my_tasks') return ul(d.tasks!.map(taskRow), 'No open cards are assigned to you.')
  if (kind === 'overdue') {
    const items = [
      ...d.tasks!.map(taskRow),
      ...(d.pays ?? []).map((p) => (
        <li key={`p${p.id}`}>
          <Row to={orderLink(p.order_id)}>
            <span className="min-w-0 truncate">
              Payment · Order {p.order_code} · {p.customer_name}
            </span>
            <span className="shrink-0 text-xs font-semibold text-red-700">{formatMoney(p.remaining, p.currency)}</span>
          </Row>
        </li>
      )),
      ...(d.ships ?? []).map((o) => (
        <li key={`o${o.id}`}>
          <Row to={orderLink(o.id)}>
            <span className="min-w-0 truncate">
              Ship date passed · Order {o.order_code} · {o.customer_name}
            </span>
            <span className="shrink-0 text-xs font-semibold text-red-700">{showDate(o.expected_ship_date, 'MMM d')}</span>
          </Row>
        </li>
      )),
    ]
    return ul(items, 'Nothing is overdue.')
  }
  if (kind === 'payments_due') {
    return ul(
      d.pays!.map((p) => (
        <li key={p.id}>
          <Row to={orderLink(p.order_id)}>
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
          </Row>
        </li>
      )),
      'No payments are due.',
    )
  }
  const orders = d.orders!
  if (kind === 'next_ship_dates') {
    const list = orders.filter((o) => BOARD_STAGES.includes(o.stage) && o.expected_ship_date).sort((a, b) => a.expected_ship_date!.localeCompare(b.expected_ship_date!))
    return ul(
      list.map((o) => {
        const days = o.days_until_ship ?? 0
        return (
          <li key={o.id}>
            <Row to={orderLink(o.id)}>
              <span className="min-w-0">
                <span className="font-medium">Order {o.order_code}</span>
                <span className="block truncate text-slate-600">
                  {o.customer_name} · {o.machines_ready_count}/{o.machines_count} built · {label(o.stage)}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block">{showDate(o.expected_ship_date)}</span>
                <span className={`block text-xs ${days < 0 ? 'font-medium text-red-700' : days <= 14 ? 'text-amber-700' : 'text-slate-500'}`}>
                  {days < 0 ? `${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'Today' : `in ${days} day${days === 1 ? '' : 's'}`}
                </span>
              </span>
            </Row>
          </li>
        )
      }),
      'No orders have an expected ship date yet.',
    )
  }
  if (kind === 'latest_shipped') {
    const list = orders.filter((o) => o.stage === 'Shipped' && o.actual_ship_date).sort((a, b) => b.actual_ship_date!.localeCompare(a.actual_ship_date!))
    return ul(
      list.map((o) => (
        <li key={o.id}>
          <Row to={orderLink(o.id)}>
            <span className="min-w-0">
              <span className="font-medium">Order {o.order_code}</span>
              <span className="block truncate text-slate-600">
                {o.customer_name} {countryFlag(o.customer_country)}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-slate-600">{showDate(o.actual_ship_date)}</span>
              <span className={`block text-xs font-medium ${o.delay_days === null ? 'text-slate-400' : o.delay_days > 0 ? 'text-red-700' : 'text-green-700'}`}>
                {o.delay_days === null ? 'No expected date' : delayWords(o.delay_days)}
              </span>
            </span>
          </Row>
        </li>
      )),
      'No orders have shipped yet.',
    )
  }
  // new orders in the dates chosen
  const r = rangeDates({ range: widget.range ?? 'month', from: widget.from, to: widget.to })
  const list = orders.filter((o) => o.order_date && o.order_date >= r.from && o.order_date <= r.to && o.stage !== 'Quote').sort((a, b) => b.order_date!.localeCompare(a.order_date!))
  return (
    <div>
      <p className="text-xs text-slate-500">
        {list.length} order{list.length === 1 ? '' : 's'} · {rangeText({ range: widget.range ?? 'month', from: widget.from, to: widget.to })}
      </p>
      {ul(
        list.map((o) => (
          <li key={o.id}>
            <Row to={orderLink(o.id)}>
              <span className="min-w-0">
                <span className="font-medium">Order {o.order_code}</span>
                <span className="block truncate text-slate-600">
                  {o.customer_name} {countryFlag(o.customer_country)} · {o.machines_list}
                </span>
              </span>
              <span className="shrink-0 text-xs text-slate-600">{showDate(o.order_date, 'MMM d')}</span>
            </Row>
          </li>
        )),
        'No new orders in these dates.',
      )}
    </div>
  )
}

function ScheduleWidget({ data }: { data: DashData }) {
  const s = useLoad(() => data.summary(), [data])
  const [version, setVersion] = useState(0)
  if (!s.data) return <Loading />
  return (
    <div>
      <div className="peer">
        <ScheduleChanges key={version} orders={s.data} onChanged={() => setVersion((v) => v + 1)} />
      </div>
      <p className="hidden text-sm text-slate-500 peer-empty:block">No ship dates are at risk.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
function BoardSnapshot({ widget, data }: { widget: Widget; data: DashData }) {
  const { can } = usePermissions()
  const board = widget.filters?.board
  const s = useLoad(async () => {
    const boards = await data.boards()
    if (!board) return { boards, stages: [], cards: [] }
    const { stages, cards } = await data.boardCards([board])
    return { boards, stages, cards }
  }, [data, board])
  if (!board) return <Empty>Choose a board in this widget’s settings.</Empty>
  if (s.error) return <Failed />
  if (!s.data) return <Loading />
  const name = s.data.boards.find((b) => b.id === board)?.name
  if (!name) return <Empty>You cannot open this board any more.</Empty>
  const max = Math.max(1, ...s.data.stages.map((st) => s.data!.cards.filter((c) => c.stage_id === st.id).length))
  const colour = colourHex(widget.colour)
  return (
    <div className="text-sm">
      <p className="mb-2 flex justify-between gap-2 text-xs text-slate-600">
        <span className="truncate">{name}</span>
        <span>{s.data.cards.length} open cards</span>
      </p>
      <ul className="space-y-1.5">
        {s.data.stages.map((st) => {
          const n = s.data!.cards.filter((c) => c.stage_id === st.id).length
          return (
            <li key={st.id} className="grid grid-cols-[minmax(0,9rem)_1fr_2rem] items-center gap-2 text-xs">
              <span className="truncate">{st.name}</span>
              <span className="h-3 rounded-sm bg-slate-100">
                <span className="block h-3 rounded-sm" style={{ width: `${(n / max) * 100}%`, background: colour }} />
              </span>
              <span className="text-right tabular-nums">{n}</span>
            </li>
          )
        })}
      </ul>
      {can('boards') && (
        <Link to={`/boards/${board}`} className="mt-2 inline-block text-xs underline">
          Open the Board
        </Link>
      )}
    </div>
  )
}

function CalendarToday({ data }: { data: DashData }) {
  const s = useLoad(() => data.calendarToday(), [data])
  if (s.error) return <Failed />
  if (!s.data) return <Loading />
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax' }) : 'All day')
  const list = [...s.data].sort((a, b) => (a.start_at ?? '').localeCompare(b.start_at ?? ''))
  return list.length ? (
    <ul className="divide-y divide-slate-100 text-sm">
      {list.map((e, i) => (
        <li key={i}>
          <Row to={e.link}>
            <span className="min-w-0">
              <span className="block truncate font-medium">{e.title}</span>
              {e.customer && <span className="block truncate text-xs text-slate-500">{e.customer}</span>}
            </span>
            <span className="shrink-0 text-xs text-slate-600">{time(e.start_at)}</span>
          </Row>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>Nothing on your calendar today.</Empty>
  )
}

function Events({ widget, data }: { widget: Widget; data: DashData }) {
  const { can } = usePermissions()
  const s = useLoad(() => data.events(), [data])
  if (!s.data) return s.error ? <Failed /> : <Loading />
  const list = [...s.data].sort((a, b) => a.start_date.localeCompare(b.start_date)).slice(0, widget.limit ?? 5)
  return list.length ? (
    <ul className="divide-y divide-slate-100 text-sm">
      {list.map((e) => (
        <li key={e.id}>
          <Row to={can('notices') ? `/notices?event=${e.id}` : null}>
            <span className="min-w-0 truncate font-medium">{e.title}</span>
            <span className="shrink-0 text-xs text-slate-600">{showDate(e.start_date, 'EEE MMM d')}</span>
          </Row>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>No upcoming events.</Empty>
  )
}

function Holidays({ widget, data }: { widget: Widget; data: DashData }) {
  const s = useLoad(() => data.holidays(), [data])
  if (!s.data) return s.error ? <Failed /> : <Loading />
  const list = s.data.slice(0, widget.limit ?? 6)
  return list.length ? (
    <ul className="divide-y divide-slate-100 text-sm">
      {list.map((h) => (
        <li key={h.id} className="flex justify-between gap-3 py-1.5">
          <span className="min-w-0 truncate">{h.name}</span>
          <span className="shrink-0 text-xs text-slate-600">{h.start_date === h.end_date ? showDate(h.start_date, 'EEE MMM d') : `${showDate(h.start_date, 'MMM d')} to ${showDate(h.end_date, 'MMM d')}`}</span>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>No more holidays or closures this year.</Empty>
  )
}

function Notices({ widget, data }: { widget: Widget; data: DashData }) {
  const s = useLoad(() => data.notices(), [data])
  if (!s.data) return s.error ? <Failed /> : <Loading />
  const list = s.data.slice(0, widget.limit ?? 5)
  return list.length ? (
    <ul className="divide-y divide-slate-100 text-sm">
      {list.map((n) => (
        <li key={n.id}>
          <Row to={`/notices?notice=${n.id}`}>
            <span className="min-w-0 truncate font-medium">
              {n.priority === 'urgent' && <span className="mr-1 rounded bg-red-100 px-1 text-xs text-red-800">Urgent</span>}
              {n.priority === 'important' && <span className="mr-1 rounded bg-amber-100 px-1 text-xs text-amber-900">Important</span>}
              {n.title}
            </span>
            <span className="shrink-0 text-xs text-slate-600">{showDate(n.created_at.slice(0, 10), 'MMM d')}</span>
          </Row>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>No notices are on the board.</Empty>
  )
}

function Chats({ widget, data }: { widget: Widget; data: DashData }) {
  const s = useLoad(() => data.chats(), [data])
  if (!s.data) return s.error ? <Failed /> : <Loading />
  const list = s.data.filter((c) => c.unread > 0 && !c.my_archived && !c.hidden).slice(0, widget.limit ?? 6)
  return list.length ? (
    <ul className="divide-y divide-slate-100 text-sm">
      {list.map((c) => (
        <li key={c.id}>
          <Row to={`/chat/${c.id}`}>
            <span className="min-w-0">
              <span className="block truncate font-medium">{c.name}</span>
              <span className="block truncate text-xs text-slate-500">{c.last_text}</span>
            </span>
            <span className="shrink-0 rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white">{c.unread}</span>
          </Row>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>No unread messages.</Empty>
  )
}

function Freight({ widget, data }: { widget: Widget; data: DashData }) {
  const r = rangeDates({ range: widget.range ?? 'month', from: widget.from, to: widget.to })
  const s = useLoad(() => data.cratesFull(), [data])
  if (!s.data) return s.error ? <Failed /> : <Loading />
  const tot = (from: string, to: string) => {
    const l = s.data!.filter((c) => c.crated_on >= from && c.crated_on <= to)
    return { sheets: l.reduce((a, c) => a + Number(c.plywood_sheets ?? 0), 0), crates: l.length, hours: Math.round(l.reduce((a, c) => a + Number(c.build_hours ?? 0), 0) * 10) / 10 }
  }
  const now = tot(r.from, r.to)
  const prev = widget.compare ? tot(lastYear(r).from, lastYear(r).to) : null
  const colour = colourHex(widget.colour)
  return (
    <div>
      <p className="text-xs text-slate-500">{rangeText({ range: widget.range ?? 'month', from: widget.from, to: widget.to })}</p>
      <dl className="mt-1 grid grid-cols-3 gap-2 text-center">
        {(
          [
            ['Plywood sheets', now.sheets, prev?.sheets],
            ['Crates made', now.crates, prev?.crates],
            ['Crating hours', now.hours, prev?.hours],
          ] as const
        ).map(([l, v, p]) => (
          <div key={l}>
            <dd className="text-2xl font-semibold tabular-nums" style={{ color: colour }}>
              {showNumber(v)}
            </dd>
            <dt className="text-xs text-slate-600">{l}</dt>
            {p !== undefined && <dd className="text-xs text-slate-500">Last year {showNumber(p)}</dd>}
          </div>
        ))}
      </dl>
    </div>
  )
}

function Labour({ widget, data }: { widget: Widget; data: DashData }) {
  const r = rangeDates({ range: widget.range ?? 'month', from: widget.from, to: widget.to })
  const prevR = lastYear(r)
  const s = useLoad(async () => {
    const now = await data.labour(r.from, r.to)
    const before = widget.compare ? await data.labour(prevR.from, prevR.to) : null
    return { now, before }
  }, [data, r.from, r.to, widget.compare])
  if (s.error) return <Failed />
  if (!s.data) return <Loading />
  const dept = widget.filters?.department
  const total = (rows: Awaited<ReturnType<DashData['labour']>>) => {
    const l = rows.filter((x) => !dept || x.department_id === dept)
    const cost = l.reduce((a, x) => a + x.cost_total, 0)
    const hours = l.reduce((a, x) => a + x.paid_hours, 0)
    return { cost, ot: l.reduce((a, x) => a + x.cost_overtime, 0), perHour: hours ? cost / hours : 0 }
  }
  const now = total(s.data.now)
  const before = s.data.before ? total(s.data.before) : null
  return (
    <div className="text-sm">
      <p className="text-xs text-slate-500">{rangeText({ range: widget.range ?? 'month', from: widget.from, to: widget.to })}</p>
      <p className="text-2xl font-semibold tabular-nums" style={{ color: colourHex(widget.colour) }}>
        {formatMoney(now.cost, 'CAD')}
      </p>
      <p className="text-xs text-slate-600">
        Overtime {formatMoney(now.ot, 'CAD')} · {formatMoney(now.perHour, 'CAD')} per paid hour
      </p>
      {before && <p className="text-xs text-slate-500">Same dates last year: {formatMoney(before.cost, 'CAD')}</p>}
      <Link to="/timesheets?tab=labour" className="mt-1 inline-block text-xs underline">
        Open Labour Cost
      </Link>
    </div>
  )
}

function Note({ widget, onNote, canEdit }: { widget: Widget; onNote?: (text: string) => void; canEdit: boolean }) {
  const [text, setText] = useState(widget.text ?? '')
  useEffect(() => {
    if (!canEdit || text === (widget.text ?? '')) return
    const t = window.setTimeout(() => onNote?.(text), 1200)
    return () => window.clearTimeout(t)
  }, [text, canEdit, widget.text, onNote])
  if (!canEdit) return <p className="text-sm whitespace-pre-wrap">{widget.text || <span className="text-slate-500">No note yet.</span>}</p>
  return (
    <textarea
      aria-label="My note"
      className="keep-light h-full min-h-20 w-full resize-none rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-slate-900"
      placeholder="Write a note for yourself. It saves by itself."
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  )
}
