import { currentLang, tr } from '../i18n'
import { addMonths, format, parseISO, startOfMonth } from 'date-fns'
import { todayISO } from './dates'
import { fetchAll } from './fetchAll'
import { STEP_LABEL, type StepKey } from './schedule'
import { supabase } from './supabase'

// Dashboard charts: what each chart shows and how it is worked out. Every chart
// gives a list of points (label + value) and one headline number for the gauges.

export const CHART_TYPES = [
  { key: 'column', get label() {
    return tr("Column")
  } },
  { key: 'bar', get label() {
    return tr("Bar")
  } },
  { key: 'line', get label() {
    return tr("Line")
  } },
  { key: 'pie', get label() {
    return tr("Pie")
  } },
  { key: 'gauge', get label() {
    return tr("Gauge")
  } },
  { key: 'gauge_targets', get label() {
    return tr("Gauge With Targets")
  } },
  { key: 'number', get label() {
    return tr("Number")
  } },
  { key: 'table', get label() {
    return tr("Table")
  } },
] as const
export type ChartType = (typeof CHART_TYPES)[number]['key']

export const RANGES = [
  { key: 'today', get label() {
    return tr("Today")
  } },
  { key: 'week', get label() {
    return tr("This week")
  } },
  { key: 'month', get label() {
    return tr("This month")
  } },
  { key: 'quarter', get label() {
    return tr("This quarter")
  } },
  { key: 'ytd', get label() {
    return tr("This year")
  } },
  { key: '12m', get label() {
    return tr("Last 12 months")
  } },
  { key: 'last_year', get label() {
    return tr("Last year")
  } },
  { key: '3y', get label() {
    return tr("Last 3 years")
  } },
  { key: 'all', get label() {
    return tr("All time")
  } },
  { key: 'custom', get label() {
    return tr("Custom dates")
  } },
] as const
export type RangeKey = (typeof RANGES)[number]['key']

/** One chart on a person's dashboard. */
export type ChartConfig = {
  id: string
  chart: string
  type: ChartType
  range: RangeKey
  from?: string
  to?: string
  /** "Open cards by stage": the boards to count. */
  boards?: string[]
  /** Widget filters (each chart uses the ones it lists in `filters`). */
  filters?: WidgetFilters
}

/** Filters a widget can have. Machine type and country are stored as the names people see. */
export type WidgetFilters = { department?: string; machineType?: string; country?: string; board?: string }
export type FilterKey = keyof WidgetFilters

export type ChartPoint = { label: string; value: number; long?: string }
export type ChartResult = {
  points: ChartPoint[]
  /** What the numbers are ("days", "orders", "hours", "%", "CAD"). */
  unit: string
  /** The one number a gauge shows. */
  headline: { value: number; label: string } | null
  note?: string
}

export type Target = { good: 'low' | 'high'; green: number; amber: number; max: number }
/** health: good / bad colours per widget key (see Health in widgets.ts; 0049). */
export type ChartSettings = { targets: Record<string, Target>; defaults: string[]; health: Record<string, { direction: 'low' | 'high' | 'none'; good: number; bad: number }> }
export const CHART_SETTINGS_DEFAULT: ChartSettings = { targets: {}, health: {}, defaults: ['delay_by_month', 'on_time', 'top_machines', 'by_country'] }

export function rangeDates(c: Pick<ChartConfig, 'range' | 'from' | 'to'>): { from: string; to: string } {
  const today = todayISO()
  const y = Number(today.slice(0, 4))
  const d = parseISO(today)
  switch (c.range) {
    case 'today':
      return { from: today, to: today }
    case 'week': {
      const back = (d.getDay() + 6) % 7
      return { from: format(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back), 'yyyy-MM-dd'), to: today }
    }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today }
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3) * 3
      return { from: format(new Date(d.getFullYear(), q, 1), 'yyyy-MM-dd'), to: today }
    }
    case 'ytd':
      return { from: `${y}-01-01`, to: today }
    case 'last_year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }
    case '3y':
      return { from: `${y - 2}-01-01`, to: today }
    case 'all':
      return { from: '2000-01-01', to: '2999-12-31' }
    case 'custom':
      return { from: c.from || `${y}-01-01`, to: c.to || today }
    default:
      return { from: format(startOfMonth(addMonths(parseISO(today), -11)), 'yyyy-MM-dd'), to: today }
  }
}

/** The same dates one year earlier ("compare with last year"). */
export function lastYear(r: { from: string; to: string }) {
  const back = (iso: string) => (iso < '2001-01-01' || iso > '2998-01-01' ? iso : `${Number(iso.slice(0, 4)) - 1}${iso.slice(4) === '-02-29' ? '-02-28' : iso.slice(4)}`)
  return { from: back(r.from), to: back(r.to) }
}

export function rangeText(c: Pick<ChartConfig, 'range' | 'from' | 'to'>) {
  if (c.range !== 'custom') return RANGES.find((r) => r.key === c.range)?.label ?? ''
  const { from, to } = rangeDates(c)
  return `${format(parseISO(from), 'MMM d, yyyy')} to ${format(parseISO(to), 'MMM d, yyyy')}`
}

// ---------------------------------------------------------------------------
// Data (each source is loaded once per page and shared by the charts)
// ---------------------------------------------------------------------------
type Order = {
  id: string
  stage: string
  order_date: string | null
  customer_country: string | null
  voltage: string | null
  actual_ship_date: string | null
  delay_days: number | null
  currency: string
}
type Payment = { stage: string; order_archived: boolean; currency: string; remaining: number; due_date: string | null; received_date: string | null; amount: number }
type Machine = { order_id: string; machine_type: string; ready: boolean }
type Crate = { crated_on: string; plywood_sheets: number | null; build_hours: number | null }
type TaskTime = { person: string; task: string; seconds: number }

export type ChartData = ReturnType<typeof chartData>

export function chartData() {
  const cache = new Map<string, Promise<unknown>>()
  const once = <T,>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load())
    return cache.get(key) as Promise<T>
  }
  const all = async <T,>(q: () => PromiseLike<{ data: unknown; error: unknown }>) => (await fetchAll<T>(q as never)).data
  return {
    orders: () =>
      once('orders', () =>
        all<Order>(() => supabase!.from('order_summary').select('id, stage, order_date, customer_country, voltage, actual_ship_date, delay_days, currency').eq('archived', false).order('id')),
      ),
    payments: () => once('payments', () => all<Payment>(() => supabase!.from('payment_overview').select('stage, order_archived, currency, remaining, due_date, received_date, amount').order('id'))),
    machines: () => once('machines', () => all<Machine>(() => supabase!.from('order_machine_status').select('order_id, machine_type, ready').order('id'))),
    crates: () => once('crates', () => all<Crate>(() => supabase!.from('crate_report').select('crated_on, plywood_sheets, build_hours').order('id'))),
    delays: () => once('delays', () => all<{ step: StepKey; done_on: string; days_late: number }>(() => supabase!.from('deadline_results').select('step, done_on, days_late').order('machine_id').order('step'))),
    serviceEntries: () => once('serviceEntries', () => all<{ kind: string; hours: number | null; entry_date: string }>(() => supabase!.from('service_entries').select('kind, hours, entry_date').eq('archived', false).order('id'))),
    serviceOrders: () => once('serviceOrders', () => all<{ travel_days: number | null; service_start: string | null }>(() => supabase!.from('order_service_info').select('travel_days, service_start').order('order_id'))),
    serviceCalls: () => once('serviceCalls', () => all<{ planned_start: string | null; planned_end: string | null }>(() => supabase!.from('service_call_info').select('planned_start, planned_end').eq('archived', false).order('card_id'))),
    taskTimes: (from: string, to: string) =>
      once(`tasks:${from}:${to}`, async () => {
        const { data } = await supabase!.rpc('chart_task_times', { p_from: from < '2000-01-01' ? '2000-01-01' : from, p_to: to > '2100-01-01' ? '2100-01-01' : to })
        return ((data as TaskTime[] | null) ?? []).map((t) => ({ ...t, seconds: Number(t.seconds) }))
      }),
    stageDepartments: () => once('stageDepartments', async () => ((await supabase!.from('production_stage_template').select('step, department_id').eq('archived', false)).data as { step: string; department_id: string | null }[] | null) ?? []),
    boards: () => once('boards', () => all<{ id: string; name: string; purpose: string | null }>(() => supabase!.from('boards').select('id, name, purpose').eq('archived', false).order('name'))),
    boardCards: (ids: string[]) =>
      once(`cards:${ids.join(',')}`, async () => {
        if (!ids.length) return { stages: [] as { id: string; board_id: string; name: string; sort_order: number }[], cards: [] as { board_id: string; stage_id: string }[] }
        const [s, c] = await Promise.all([
          supabase!.from('board_stages').select('id, board_id, name, sort_order').in('board_id', ids).eq('archived', false).order('sort_order'),
          all<{ board_id: string; stage_id: string }>(() => supabase!.from('board_cards').select('board_id, stage_id').in('board_id', ids).eq('archived', false).is('finished_at', null).order('id')),
        ])
        return { stages: (s.data as { id: string; board_id: string; name: string; sort_order: number }[] | null) ?? [], cards: c }
      }),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const inRange = (d: string | null | undefined, from: string, to: string) => !!d && d >= from && d <= to
const round1 = (n: number) => Math.round(n * 10) / 10
const REAL_ORDER = (o: Order) => o.stage !== 'Quote' && o.stage !== 'Cancelled'
/** The order passes the widget's customer country filter. */
const countryOk = (o: Order, c: ChartConfig) => !c.filters?.country || (o.customer_country ?? '') === c.filters.country
const typeOk = (m: Machine, c: ChartConfig) => !c.filters?.machineType || m.machine_type === c.filters.machineType
/** Orders (in the dates, real orders) that pass the country filter, and with machine type filter: have such a machine. */
async function filteredOrders(d: ChartData, c: ChartConfig, keep: (o: Order) => boolean) {
  let rows = (await d.orders()).filter((o) => keep(o) && countryOk(o, c))
  if (c.filters?.machineType) {
    const ids = new Set((await d.machines()).filter((m) => typeOk(m, c)).map((m) => m.order_id))
    rows = rows.filter((o) => ids.has(o.id))
  }
  return rows
}

/** The months from the first to the last date that has data (at most 36). */
function months(from: string, to: string, dates: string[]) {
  if (!dates.length) return []
  const lo = [...dates].sort()[0]
  const hi = [...dates].sort().at(-1)!
  let m = startOfMonth(parseISO(from > lo ? from : lo))
  const end = startOfMonth(parseISO(to < hi ? to : hi))
  const out: { key: string; label: string; long: string }[] = []
  for (let i = 0; m <= end && i < 36; i++, m = addMonths(m, 1)) out.push({ key: format(m, 'yyyy-MM'), label: format(m, 'MMM'), long: format(m, 'MMMM yyyy') })
  return out
}

function countBy<T>(rows: T[], key: (r: T) => string, top = 10): ChartPoint[] {
  const m = new Map<string, number>()
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
  const sorted = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const head = sorted.slice(0, top).map(([label, value]) => ({ label, value }))
  const rest = sorted.slice(top).reduce((s, [, v]) => s + v, 0)
  return rest ? [...head, { get label() {
    return tr("Other")
  }, value: rest }] : head
}

const share = (part: number, whole: number) => (whole ? round1((part / whole) * 100) : 0)

async function cratingByMonth(d: ChartData, from: string, to: string, value: (c: Crate) => number, unit: string): Promise<ChartResult> {
  const rows = (await d.crates()).filter((c) => inRange(c.crated_on, from, to))
  const ms = months(from, to, rows.map((c) => c.crated_on))
  const points = ms.map((m) => ({ label: m.label, long: m.long, value: round1(rows.filter((c) => c.crated_on.startsWith(m.key)).reduce((s, c) => s + value(c), 0)) }))
  const total = round1(rows.reduce((s, c) => s + value(c), 0))
  return { points, unit, headline: { value: total, label: `${unit} in total` } }
}

// ---------------------------------------------------------------------------
// The charts
// ---------------------------------------------------------------------------
export type ChartDef = {
  key: string
  title: string
  /** Menu group in "Add Chart". */
  group: string
  permission: string
  types: ChartType[]
  defaultType: ChartType
  /** Has no date filter (shows the situation now). */
  now?: boolean
  /** Needs boards chosen. */
  boards?: boolean
  /** The widget filters this chart uses. */
  filters?: FilterKey[]
  load: (d: ChartData, range: { from: string; to: string }, c: ChartConfig) => Promise<ChartResult>
}

const ALL: ChartType[] = ['column', 'bar', 'line', 'pie', 'gauge', 'gauge_targets', 'number', 'table']
const NO_PIE: ChartType[] = ['column', 'bar', 'line', 'gauge', 'gauge_targets', 'number', 'table']
const NO_GAUGE: ChartType[] = ['column', 'bar', 'line', 'pie', 'number', 'table']

export const CHARTS: ChartDef[] = [
  {
    key: 'delay_by_month', get title() {
    return tr("Average Delay by Month")
  }, group: 'Shipping', permission: 'dashboard.chart.delay_by_month', types: NO_PIE, defaultType: 'column', filters: ['country', 'machineType'],
    load: async (d, { from, to }, c) => {
      const rows = await filteredOrders(d, c, (o) => o.delay_days !== null && inRange(o.actual_ship_date, from, to))
      const ms = months(from, to, rows.map((o) => o.actual_ship_date!))
      const points = ms.map((m) => {
        const list = rows.filter((o) => o.actual_ship_date!.startsWith(m.key))
        return { label: m.label, long: m.long, value: list.length ? round1(list.reduce((s, o) => s + Number(o.delay_days), 0) / list.length) : 0 }
      })
      const avg = rows.length ? round1(rows.reduce((s, o) => s + Number(o.delay_days), 0) / rows.length) : 0
      return { points, unit: 'days', headline: { value: avg, get label() {
    return tr("days late on average (below zero = early)")
  } } }
    },
  },
  {
    key: 'delay_by_year', get title() {
    return tr("Average Delay by Year")
  }, group: 'Shipping', permission: 'dashboard.chart.delay_by_year', types: NO_PIE, defaultType: 'column', filters: ['country', 'machineType'],
    load: async (d, { from, to }, c) => {
      const rows = await filteredOrders(d, c, (o) => o.delay_days !== null && inRange(o.actual_ship_date, from, to))
      const years = [...new Set(rows.map((o) => o.actual_ship_date!.slice(0, 4)))].sort()
      const points = years.map((y) => {
        const list = rows.filter((o) => o.actual_ship_date!.startsWith(y))
        return { label: y, value: round1(list.reduce((s, o) => s + Number(o.delay_days), 0) / list.length) }
      })
      const avg = rows.length ? round1(rows.reduce((s, o) => s + Number(o.delay_days), 0) / rows.length) : 0
      return { points, unit: 'days', headline: { value: avg, get label() {
    return tr("days late on average (below zero = early)")
  } } }
    },
  },
  {
    key: 'on_time', get title() {
    return tr("On-time and Late Shipments")
  }, group: 'Shipping', permission: 'dashboard.chart.on_time', types: ALL, defaultType: 'pie', filters: ['country', 'machineType'],
    load: async (d, { from, to }, c) => {
      const rows = await filteredOrders(d, c, (o) => o.delay_days !== null && inRange(o.actual_ship_date, from, to))
      const ok = rows.filter((o) => Number(o.delay_days) <= 0).length
      return { points: [{ get label() {
    return tr("On time or early")
  }, value: ok }, { get label() {
    return tr("Late")
  }, value: rows.length - ok }], unit: 'shipments', headline: { value: share(ok, rows.length), get label() {
    return tr("% shipped on time")
  } } }
    },
  },
  {
    key: 'top_machines', get title() {
    return tr("Most Ordered Machines")
  }, group: 'Orders', permission: 'dashboard.chart.top_machines', types: NO_GAUGE, defaultType: 'bar', filters: ['country', 'machineType'],
    load: async (d, { from, to }, c) => {
      const orders = new Map((await filteredOrders(d, c, (o) => REAL_ORDER(o) && inRange(o.order_date, from, to))).map((o) => [o.id, o]))
      const rows = (await d.machines()).filter((m) => orders.has(m.order_id) && typeOk(m, c))
      return { points: countBy(rows, (m) => m.machine_type), unit: 'machines', headline: { value: rows.length, get label() {
    return tr("machines ordered")
  } } }
    },
  },
  {
    key: 'by_country', get title() {
    return tr("Orders by Country")
  }, group: 'Orders', permission: 'dashboard.chart.by_country', types: NO_GAUGE, defaultType: 'bar', filters: ['machineType'],
    load: async (d, { from, to }, c) => {
      const rows = await filteredOrders(d, c, (o) => REAL_ORDER(o) && inRange(o.order_date, from, to))
      return { points: countBy(rows, (o) => o.customer_country || 'Not set'), unit: 'orders', headline: { value: rows.length, get label() {
    return tr("orders")
  } } }
    },
  },
  {
    key: 'voltage', get title() {
    return tr("120V and 240V Machines Built")
  }, group: 'Orders', permission: 'dashboard.chart.voltage', types: NO_GAUGE, defaultType: 'pie', filters: ['country', 'machineType'],
    load: async (d, { from, to }, c) => {
      const orders = new Map((await filteredOrders(d, c, (o) => REAL_ORDER(o) && inRange(o.order_date, from, to))).map((o) => [o.id, o]))
      const rows = (await d.machines()).filter((m) => m.ready && orders.has(m.order_id) && typeOk(m, c))
      return { points: countBy(rows, (m) => orders.get(m.order_id)!.voltage || 'Unknown'), unit: 'machines', headline: { value: rows.length, get label() {
    return tr("machines built")
  } }, note: 'Built machines on orders placed in these dates.' }
    },
  },
  {
    key: 'speed_employee', get title() {
    return tr("Build Speed by Employee")
  }, group: 'Production', permission: 'dashboard.chart.speed_employee', types: NO_PIE, defaultType: 'bar',
    load: async (d, { from, to }) => {
      const rows = await d.taskTimes(from, to)
      const by = new Map<string, number[]>()
      for (const t of rows) by.set(t.person, [...(by.get(t.person) ?? []), t.seconds])
      const points = [...by].map(([label, v]) => ({ label, value: round1(v.reduce((a, b) => a + b, 0) / v.length / 3600), long: `${label} (${v.length} finished)` })).sort((a, b) => a.value - b.value).slice(0, 15)
      const avg = rows.length ? round1(rows.reduce((s, t) => s + t.seconds, 0) / rows.length / 3600) : 0
      return { points, unit: 'hours per task', headline: { value: avg, get label() {
    return tr("hours per finished task on average")
  } }, note: 'From the Start and Finish timers on the boards; pauses are left out.' }
    },
  },
  {
    key: 'speed_task', get title() {
    return tr("Build Speed by Task")
  }, group: 'Production', permission: 'dashboard.chart.speed_task', types: NO_PIE, defaultType: 'bar',
    load: async (d, { from, to }) => {
      const rows = await d.taskTimes(from, to)
      const by = new Map<string, number[]>()
      for (const t of rows) by.set(t.task, [...(by.get(t.task) ?? []), t.seconds])
      const points = [...by].sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([label, v]) => ({ label, value: round1(v.reduce((a, b) => a + b, 0) / v.length / 3600), long: `${label} (${v.length} times)` }))
      const avg = rows.length ? round1(rows.reduce((s, t) => s + t.seconds, 0) / rows.length / 3600) : 0
      return { points, unit: 'hours', headline: { value: avg, get label() {
    return tr("hours per finished task on average")
  } }, note: 'The 12 tasks done most often; average time each takes.' }
    },
  },
  {
    key: 'department_delays', get title() {
    return tr("Department Delays")
  }, group: 'Production', permission: 'dashboard.chart.department_delays', types: NO_PIE, defaultType: 'column', filters: ['department'],
    load: async (d, { from, to }, c) => {
      const dept = c.filters?.department
      const keep = dept ? new Set((await d.stageDepartments()).filter((s) => s.department_id === dept).map((s) => s.step)) : null
      const rows = (await d.delays()).filter((r) => inRange(r.done_on, from, to) && (!keep || keep.has(r.step)))
      const steps = [...new Set(rows.map((r) => r.step))]
      const points = steps.map((s) => {
        const list = rows.filter((r) => r.step === s)
        return { label: STEP_LABEL[s] ?? s, value: round1(list.reduce((a, r) => a + Number(r.days_late), 0) / list.length) }
      })
      const avg = rows.length ? round1(rows.reduce((a, r) => a + Number(r.days_late), 0) / rows.length) : 0
      return { points, unit: 'days', headline: { value: avg, get label() {
    return tr("days late on average, all departments")
  } } }
    },
  },
  {
    key: 'service_days', get title() {
    return tr("Planned Service and Travel Days")
  }, group: 'Service / Training', permission: 'dashboard.chart.service_days', types: NO_GAUGE, defaultType: 'column',
    load: async (d, { from, to }) => {
      const calls = (await d.serviceCalls()).filter((c) => inRange(c.planned_start, from, to))
      const callDays = calls.reduce((s, c) => s + (Math.round((parseISO(c.planned_end ?? c.planned_start!).getTime() - parseISO(c.planned_start!).getTime()) / 86400000) + 1), 0)
      const travel = (await d.serviceOrders()).filter((o) => inRange(o.service_start, from, to)).reduce((s, o) => s + Number(o.travel_days ?? 0), 0)
      return { points: [{ get label() {
    return tr("Planned service call days")
  }, value: callDays }, { get label() {
    return tr("Planned travel days")
  }, value: round1(travel) }], unit: 'days', headline: { value: round1(callDays + travel), get label() {
    return tr("planned days")
  } } }
    },
  },
  {
    key: 'service_hours', get title() {
    return tr("Travel and Service Hours")
  }, group: 'Service / Training', permission: 'dashboard.chart.service_hours', types: NO_GAUGE, defaultType: 'column',
    load: async (d, { from, to }) => {
      const rows = (await d.serviceEntries()).filter((e) => inRange(e.entry_date, from, to))
      const sum = (k: string) => round1(rows.filter((e) => e.kind === k).reduce((s, e) => s + Number(e.hours ?? 0), 0))
      return { points: [{ get label() {
    return tr("Travel hours")
  }, value: sum('travel') }, { get label() {
    return tr("Service hours on site")
  }, value: sum('onsite') }], unit: 'hours', headline: { value: round1(sum('travel') + sum('onsite')), get label() {
    return tr("hours logged")
  } } }
    },
  },
  {
    key: 'payments_on_time', get title() {
    return tr("On-time and Late Payments")
  }, group: 'Payments', permission: 'dashboard.chart.payments_on_time', types: ALL, defaultType: 'pie',
    load: async (d, { from, to }) => {
      const rows = (await d.payments()).filter((p) => Number(p.remaining) <= 0 && p.due_date && inRange(p.received_date, from, to))
      const ok = rows.filter((p) => p.received_date! <= p.due_date!).length
      return { points: [{ get label() {
    return tr("Received on time")
  }, value: ok }, { get label() {
    return tr("Received late")
  }, value: rows.length - ok }], unit: 'payments', headline: { value: share(ok, rows.length), get label() {
    return tr("% received on time")
  } }, note: 'Fully received payments with a due date.' }
    },
  },
  {
    key: 'outstanding', get title() {
    return tr("Money Outstanding by Currency")
  }, group: 'Payments', permission: 'dashboard.chart.outstanding', types: ['column', 'bar', 'pie', 'table'], defaultType: 'column', now: true,
    load: async (d) => {
      const rows = (await d.payments()).filter((p) => Number(p.remaining) > 0 && !p.order_archived && p.stage !== 'Quote' && p.stage !== 'Cancelled')
      const by = new Map<string, number>()
      for (const p of rows) by.set(p.currency, (by.get(p.currency) ?? 0) + Number(p.remaining))
      return { points: [...by].sort().map(([label, value]) => ({ label, value: Math.round(value) })), unit: 'in each currency', headline: null, note: 'Now. The currencies are not converted.' }
    },
  },
  {
    key: 'board_cards', get title() {
    return tr("Open Cards by Stage")
  }, group: 'Boards', permission: 'dashboard.chart.board_cards', types: NO_GAUGE, defaultType: 'bar', now: true, boards: true, filters: ['board'],
    load: async (d, _r, c) => {
      const ids = c.boards?.length ? c.boards : c.filters?.board ? [c.filters.board] : []
      if (!ids.length) return { points: [], unit: 'cards', headline: null, note: 'Choose the boards to count.' }
      const boards = new Map((await d.boards()).map((b) => [b.id, b.name]))
      const { stages, cards } = await d.boardCards([...ids].sort())
      const points = stages
        .filter((s) => ids.includes(s.board_id))
        .sort((a, b) => ids.indexOf(a.board_id) - ids.indexOf(b.board_id) || a.sort_order - b.sort_order)
        .map((s) => ({ label: ids.length > 1 ? `${boards.get(s.board_id) ?? ''}: ${s.name}` : s.name, value: cards.filter((x) => x.stage_id === s.id).length }))
      return { points, unit: 'open cards', headline: { value: cards.length, get label() {
    return tr("open cards")
  } }, note: `Now: ${ids.map((i) => boards.get(i) ?? 'a board you cannot open').join(', ')}.` }
    },
  },
  { key: 'crating_plywood', get title() {
    return tr("Plywood Sheets Used")
  }, group: 'Freight', permission: 'dashboard.chart.crating_plywood', types: NO_PIE, defaultType: 'column', load: (d, r) => cratingByMonth(d, r.from, r.to, (c) => Number(c.plywood_sheets ?? 0), 'sheets') },
  { key: 'crating_crates', get title() {
    return tr("Crates Made")
  }, group: 'Freight', permission: 'dashboard.chart.crating_crates', types: NO_PIE, defaultType: 'column', load: (d, r) => cratingByMonth(d, r.from, r.to, () => 1, 'crates') },
  { key: 'crating_hours', get title() {
    return tr("Crating Hours")
  }, group: 'Freight', permission: 'dashboard.chart.crating_hours', types: NO_PIE, defaultType: 'column', load: (d, r) => cratingByMonth(d, r.from, r.to, (c) => Number(c.build_hours ?? 0), 'hours') },
]

export const chartDef = (key: string) => CHARTS.find((c) => c.key === key)
export const newChartId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

export async function loadChartSettings(): Promise<ChartSettings> {
  if (!supabase) return CHART_SETTINGS_DEFAULT
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'dashboard_charts').maybeSingle()
  return { ...CHART_SETTINGS_DEFAULT, ...((data?.value as Partial<ChartSettings> | null) ?? {}) }
}

/** Green, amber or red for a value against an admin target. */
export function targetState(value: number, t: Target): 'good' | 'watch' | 'off' {
  if (t.good === 'high') return value >= t.green ? 'good' : value >= t.amber ? 'watch' : 'off'
  return value <= t.green ? 'good' : value <= t.amber ? 'watch' : 'off'
}

/** "1,234.5" */
export const showNumber = (n: number) => (Math.round(n * 10) / 10).toLocaleString(currentLang())
