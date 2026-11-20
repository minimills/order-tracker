import { CHARTS, type ChartType, type FilterKey, type RangeKey, type WidgetFilters } from './dashboardCharts'
import type { Layouts } from './gridLayout'

/**
 * THE widget library of the dashboard. Every widget has a permission key from
 * the catalog: the library only offers, and the dashboard only draws, widgets
 * the person is allowed to see (the data behind them is protected by the
 * database as well).
 */

export type WidgetKind = 'kpi' | 'chart' | 'list' | 'board' | 'calendar' | 'events' | 'holidays' | 'whos_off' | 'notices' | 'chats' | 'freight' | 'labour' | 'note' | 'schedule' | 'work'

export type WidgetDef = {
  key: string
  kind: WidgetKind
  title: string
  group: string
  /** Shown in the library under the title. */
  description: string
  permission: string
  /** Every one of these is needed too (data permissions). */
  needs?: string[]
  /** Starting size on a computer (12 columns). */
  w: number
  h: number
  /** Forms it can take (charts); the first is the default. */
  displays?: ChartType[]
  /** Has a date range (otherwise it shows the situation now). */
  range?: boolean
  filters?: FilterKey[]
  /** Lists: how many lines by default. */
  limit?: number
}

/** One widget on a dashboard. */
export type Widget = {
  id: string
  key: string
  title?: string
  display?: ChartType
  range?: RangeKey
  from?: string
  to?: string
  compare?: boolean
  filters?: WidgetFilters
  colour?: string
  limit?: number
  /** Personal note text. */
  text?: string
  /** Good / bad colours for this widget only (else the company setting, else the built-in default). */
  health?: Health
}

/**
 * Good and bad colours of a widget's number: whether a higher number is better
 * or worse, and the limits. Lower is better: green below `good`, red above
 * `bad`. Higher is better: green above `good`, red below `bad`. Between the two
 * (or direction none) the widget keeps its normal colour; when both apply, red wins.
 */
export type Health = { direction: 'low' | 'high' | 'none'; good: number; bad: number }
export type HealthState = 'good' | 'bad' | 'neutral'
export const HEALTH_DIRECTIONS: { value: Health['direction']; label: string }[] = [
  { value: 'high', label: 'Higher is better' },
  { value: 'low', label: 'Lower is better' },
  { value: 'none', label: 'Neutral (no colours)' },
]
const NONE: Health = { direction: 'none', good: 0, bad: 0 }
/** Built-in defaults (Admin → Dashboard Charts can change them for every dashboard). */
export const HEALTH_DEFAULTS: Record<string, Health> = {
  'kpi:payments_overdue': { direction: 'low', good: 1, bad: 0 },
  'kpi:average_delay': { direction: 'low', good: 0, bad: 0 },
  'list:overdue': { direction: 'low', good: 1, bad: 0 },
  'chart:delay_by_month': { direction: 'low', good: 0, bad: 0 },
  'chart:delay_by_year': { direction: 'low', good: 0, bad: 0 },
  'chart:department_delays': { direction: 'low', good: 0, bad: 0 },
  'chart:on_time': { direction: 'high', good: 89, bad: 75 },
  'chart:payments_on_time': { direction: 'high', good: 89, bad: 75 },
}
/** Widgets that show one number the colours can judge (for charts: the headline number). */
export const healthWidgets = () => WIDGETS.filter((w) => (w.kind === 'kpi' && w.key !== 'kpi:money_owed') || w.key === 'list:overdue' || (w.kind === 'chart' && w.key !== 'chart:outstanding'))
/** The number each widget's colours judge, in words. */
export const healthValueText = (key: string) =>
  key === 'list:overdue' ? 'number of overdue items' : key.startsWith('kpi:') ? (key === 'kpi:average_delay' ? 'average days late' : 'the number shown') : 'the headline number'
/** The colours in force for one widget. */
export function healthFor(w: Pick<Widget, 'key' | 'health'>, company?: Record<string, Health>): Health {
  return w.health ?? company?.[w.key] ?? HEALTH_DEFAULTS[w.key] ?? NONE
}
export function healthState(value: number | null | undefined, h: Health): HealthState {
  if (value == null || Number.isNaN(value) || h.direction === 'none') return 'neutral'
  if (h.direction === 'low') return value > h.bad ? 'bad' : value < h.good ? 'good' : 'neutral'
  return value < h.bad ? 'bad' : value > h.good ? 'good' : 'neutral'
}
/** "Green below 0, red above 0." */
export function healthWords(h: Health) {
  if (h.direction === 'none') return 'No colours.'
  return h.direction === 'low' ? `Green below ${h.good}, red above ${h.bad}.` : `Green above ${h.good}, red below ${h.bad}.`
}

export type Dashboard = {
  id: string
  name: string
  sort_order: number
  is_default: boolean
  widgets: Widget[]
  layouts: Layouts
  template_id: string | null
  locked: boolean
  shared_by_name: string | null
}

/** Widget colours (the chart palette, checked for colour blindness on light and dark cards). */
export const WIDGET_COLOURS = [
  { key: 'blue', label: 'Blue', hex: '#2a78d6' },
  { key: 'orange', label: 'Orange', hex: '#eb6834' },
  { key: 'green', label: 'Green', hex: '#1baf7a' },
  { key: 'amber', label: 'Amber', hex: '#c9772a' },
  { key: 'pink', label: 'Pink', hex: '#e87ba4' },
  { key: 'purple', label: 'Purple', hex: '#6250d6' },
  { key: 'slate', label: 'Grey', hex: '#64748b' },
] as const
export const colourHex = (key?: string) => WIDGET_COLOURS.find((c) => c.key === key)?.hex ?? WIDGET_COLOURS[0].hex

const kpi = (k: { metric: string; title: string; permission: string; description: string; needs?: string[] }): WidgetDef => ({
  key: `kpi:${k.metric}`, kind: 'kpi', title: k.title, group: 'Numbers', description: k.description, permission: k.permission, needs: k.needs, w: 3, h: 2,
})

export const WIDGETS: WidgetDef[] = [
  kpi({ metric: 'in_production', title: 'In Production', permission: 'dashboard.card.in_production', description: 'Number of orders in production.' }),
  kpi({ metric: 'ready', title: 'Ready', permission: 'dashboard.card.ready', description: 'Number of orders built and being tested.' }),
  kpi({ metric: 'ready_to_ship', title: 'Ready to Ship', permission: 'dashboard.card.ready_to_ship', description: 'Number of orders ready to ship.' }),
  kpi({ metric: 'payments_overdue', title: 'Payments Overdue', permission: 'dashboard.card.payments_overdue', description: 'Overdue payments and their amounts.', needs: ['payments'] }),
  kpi({ metric: 'money_owed', title: 'Amount Outstanding', permission: 'dashboard.card.money_owed', description: 'Money still owed, per currency.', needs: ['payments', 'order.field.order_total'] }),
  { ...kpi({ metric: 'average_delay', title: 'Average Delay', permission: 'dashboard.card.average_delay', description: 'Average days late of the orders shipped in the dates chosen.' }), range: true, filters: ['country', 'machineType'] },
  ...CHARTS.map((c): WidgetDef => ({
    key: `chart:${c.key}`,
    kind: 'chart',
    title: c.title,
    group: `Charts: ${c.group}`,
    description: c.now ? 'A chart of the situation now.' : 'A chart for the dates chosen.',
    permission: c.permission,
    needs: ['dashboard.charts'],
    w: 6,
    h: 5,
    displays: [c.defaultType, ...c.types.filter((t) => t !== c.defaultType)],
    range: !c.now,
    filters: c.filters,
  })),
  { key: 'work:mine', kind: 'work', title: 'My Work', group: 'Boards', description: 'Cards and tasks assigned to you, with Start, Pause and Finish right here. Updates live.', permission: 'dashboard.widget.my_work', w: 6, h: 6, filters: ['board'], limit: 8 },
  { key: 'list:my_tasks', kind: 'list', title: 'My Tasks', group: 'Lists', description: 'Open cards assigned to you, the soonest due first.', permission: 'dashboard.widget.my_tasks', w: 6, h: 5, filters: ['board'], limit: 8 },
  { key: 'list:overdue', kind: 'list', title: 'Overdue', group: 'Lists', description: 'Your overdue cards, overdue payments and passed ship dates.', permission: 'dashboard.widget.overdue', w: 6, h: 5, limit: 10 },
  { key: 'list:next_ship_dates', kind: 'list', title: 'Next Ship Dates', group: 'Lists', description: 'Orders in the queue by expected ship date.', permission: 'dashboard.list.next_ship_dates', w: 6, h: 6, filters: ['country', 'machineType'], limit: 10 },
  { key: 'list:payments_due', kind: 'list', title: 'Payments Due', group: 'Lists', description: 'The next payments due.', permission: 'dashboard.list.next_payments', needs: ['payments'], w: 6, h: 6, filters: ['country'], limit: 10 },
  { key: 'list:new_orders', kind: 'list', title: 'New Orders', group: 'Lists', description: 'Orders placed in the dates chosen.', permission: 'dashboard.widget.new_orders', w: 6, h: 5, range: true, filters: ['country', 'machineType'], limit: 10 },
  { key: 'list:latest_shipped', kind: 'list', title: 'Latest Shipped', group: 'Lists', description: 'The last orders shipped, early or late.', permission: 'dashboard.list.latest_shipped', w: 6, h: 5, filters: ['country', 'machineType'], limit: 5 },
  { key: 'schedule:changes', kind: 'schedule', title: 'Ship Dates at Risk', group: 'Lists', description: 'Orders whose suggested ship date is later than promised (Accept or Keep).', permission: 'dashboard.list.schedule_changes', needs: ['schedule'], w: 12, h: 4 },
  { key: 'board:snapshot', kind: 'board', title: 'Board Snapshot', group: 'Boards', description: 'Cards in each stage of a board you choose.', permission: 'dashboard.widget.board_snapshot', w: 6, h: 5, filters: ['board'] },
  { key: 'calendar:today', kind: 'calendar', title: 'Today’s Calendar', group: 'Calendar and People', description: 'Your technician calendar for today.', permission: 'dashboard.widget.calendar', w: 4, h: 4 },
  { key: 'events:upcoming', kind: 'events', title: 'Upcoming Events', group: 'Calendar and People', description: 'Company events meant for you.', permission: 'dashboard.widget.events', w: 4, h: 4, limit: 5 },
  { key: 'holidays:upcoming', kind: 'holidays', title: 'Upcoming Holidays', group: 'Calendar and People', description: 'Holidays and office closures still to come this year.', permission: 'dashboard.widget.holidays', w: 4, h: 4, limit: 6 },
  { key: 'people:whos_off', kind: 'whos_off', title: 'Who’s Off Today', group: 'Calendar and People', description: 'People on approved time off today.', permission: 'dashboard.whos_off', w: 4, h: 4 },
  { key: 'notices:latest', kind: 'notices', title: 'Latest Notices', group: 'Messages', description: 'The newest notices meant for you.', permission: 'dashboard.widget.notices', w: 4, h: 5, limit: 5 },
  { key: 'chats:unread', kind: 'chats', title: 'Unread Chats', group: 'Messages', description: 'Conversations with messages you have not read.', permission: 'dashboard.widget.chats', w: 4, h: 4, limit: 6 },
  { key: 'freight:totals', kind: 'freight', title: 'Freight and Crating', group: 'Freight and Money', description: 'Plywood sheets, crates made and crating hours in the dates chosen.', permission: 'dashboard.widget.freight_totals', w: 4, h: 3, range: true },
  { key: 'labour:cost', kind: 'labour', title: 'Labour Cost', group: 'Freight and Money', description: 'Labour cost, overtime and cost per hour in the dates chosen.', permission: 'dashboard.widget.labour_cost', needs: ['timesheets.labour_cost'], w: 4, h: 3, range: true, filters: ['department'] },
  { key: 'note:personal', kind: 'note', title: 'My Note', group: 'Personal', description: 'A note only you can see.', permission: 'dashboard.widget.note', w: 4, h: 3 },
]

export const widgetDef = (key: string) => WIDGETS.find((w) => w.key === key)

export const newWidgetId = () => `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

/** Can this person see this widget? */
export function widgetAllowed(def: WidgetDef | undefined, can: (key: string) => boolean) {
  return !!def && can(def.permission) && (def.needs ?? []).every((k) => can(k))
}

export const widgetTitle = (w: Widget) => w.title?.trim() || widgetDef(w.key)?.title || 'Widget'

/**
 * A first dashboard for someone without a saved one or a template: the parts
 * of the old fixed dashboard they may see, plus their old "My Charts".
 */
export function starterDashboard(
  can: (key: string) => boolean,
  oldCharts: { chart: string; type?: ChartType; range?: RangeKey; from?: string; to?: string; boards?: string[] }[] | null,
  defaultCharts: string[] = ['delay_by_month', 'on_time'],
): { widgets: Widget[]; layouts: Layouts } {
  const keys = ['kpi:in_production', 'kpi:ready', 'kpi:ready_to_ship', 'kpi:payments_overdue', 'kpi:money_owed', 'kpi:average_delay', 'people:whos_off', 'schedule:changes']
  const charts: NonNullable<typeof oldCharts> = oldCharts?.length ? oldCharts : defaultCharts.map((chart) => ({ chart }))
  const widgets: Widget[] = []
  let n = 0
  const id = () => `w${(n++).toString(36)}start`
  for (const k of keys) if (widgetAllowed(widgetDef(k), can)) widgets.push({ id: id(), key: k, ...(k === 'kpi:average_delay' ? { range: 'ytd' as RangeKey } : {}) })
  for (const c of charts) {
    const def = widgetDef(`chart:${c.chart}`)
    if (widgetAllowed(def, can)) widgets.push({ id: id(), key: def!.key, display: c.type, range: c.range, from: c.from, to: c.to, filters: c.boards?.[0] ? { board: c.boards[0] } : undefined })
  }
  for (const k of ['list:latest_shipped', 'list:next_ship_dates', 'list:payments_due', 'list:my_tasks']) if (widgetAllowed(widgetDef(k), can)) widgets.push({ id: id(), key: k })
  return { widgets, layouts: {} }
}
