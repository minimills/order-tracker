import { CHARTS, type ChartType, type FilterKey, type RangeKey, type WidgetFilters } from './dashboardCharts'
import type { Layouts } from './gridLayout'
import { tr } from '../i18n'

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
  { value: 'high', get label() {
    return tr("Higher is better")
  } },
  { value: 'low', get label() {
    return tr("Lower is better")
  } },
  { value: 'none', get label() {
    return tr("Neutral (no colours)")
  } },
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
  key === 'list:overdue' ? tr("number of overdue items") : key.startsWith('kpi:') ? (key === 'kpi:average_delay' ? tr("average days late") : tr("the number shown")) : tr("the headline number")
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
  if (h.direction === 'none') return tr("No colours.")
  return h.direction === 'low' ? tr("Green below {{good}}, red above {{bad}}.", { good: h.good, bad: h.bad }) : tr("Green above {{good}}, red below {{bad}}.", { good: h.good, bad: h.bad })
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
  { key: 'blue', get label() {
    return tr("Blue")
  }, hex: '#2a78d6' },
  { key: 'orange', get label() {
    return tr("Orange")
  }, hex: '#eb6834' },
  { key: 'green', get label() {
    return tr("Green")
  }, hex: '#1baf7a' },
  { key: 'amber', get label() {
    return tr("Amber")
  }, hex: '#c9772a' },
  { key: 'pink', get label() {
    return tr("Pink")
  }, hex: '#e87ba4' },
  { key: 'purple', get label() {
    return tr("Purple")
  }, hex: '#6250d6' },
  { key: 'slate', get label() {
    return tr("Grey")
  }, hex: '#64748b' },
] as const
export const colourHex = (key?: string) => WIDGET_COLOURS.find((c) => c.key === key)?.hex ?? WIDGET_COLOURS[0].hex

const kpi = (k: { metric: string; title: string; permission: string; description: string; needs?: string[] }): WidgetDef => ({
  key: `kpi:${k.metric}`, kind: 'kpi', title: k.title, group: 'Numbers', description: k.description, permission: k.permission, needs: k.needs, w: 3, h: 2,
})

export const WIDGETS: WidgetDef[] = [
  kpi({ metric: 'in_production', get title() {
    return tr("In Production")
  }, permission: 'dashboard.card.in_production', get description() {
    return tr("Number of orders in production.")
  } }),
  kpi({ metric: 'ready', get title() {
    return tr("Ready")
  }, permission: 'dashboard.card.ready', get description() {
    return tr("Number of orders built and being tested.")
  } }),
  kpi({ metric: 'ready_to_ship', get title() {
    return tr("Ready to Ship")
  }, permission: 'dashboard.card.ready_to_ship', get description() {
    return tr("Number of orders ready to ship.")
  } }),
  kpi({ metric: 'payments_overdue', get title() {
    return tr("Payments Overdue")
  }, permission: 'dashboard.card.payments_overdue', get description() {
    return tr("Overdue payments and their amounts.")
  }, needs: ['payments'] }),
  kpi({ metric: 'money_owed', get title() {
    return tr("Amount Outstanding")
  }, permission: 'dashboard.card.money_owed', get description() {
    return tr("Money still owed, per currency.")
  }, needs: ['payments', 'order.field.order_total'] }),
  { ...kpi({ metric: 'average_delay', get title() {
    return tr("Average Delay")
  }, permission: 'dashboard.card.average_delay', get description() {
    return tr("Average days late of the orders shipped in the dates chosen.")
  } }), range: true, filters: ['country', 'machineType'] },
  ...CHARTS.map((c): WidgetDef => ({
    key: `chart:${c.key}`,
    kind: 'chart',
    title: c.title,
    group: `Charts: ${c.group}`,
    description: c.now ? tr("A chart of the situation now.") : tr("A chart for the dates chosen."),
    permission: c.permission,
    needs: ['dashboard.charts'],
    w: 6,
    h: 5,
    displays: [c.defaultType, ...c.types.filter((t) => t !== c.defaultType)],
    range: !c.now,
    filters: c.filters,
  })),
  { key: 'work:mine', kind: 'work', get title() {
    return tr("My Work")
  }, group: 'Boards', get description() {
    return tr("Cards and tasks assigned to you, with Start, Pause and Finish right here. Updates live.")
  }, permission: 'dashboard.widget.my_work', w: 6, h: 6, filters: ['board'], limit: 8 },
  { key: 'list:my_tasks', kind: 'list', get title() {
    return tr("My Tasks")
  }, group: 'Lists', get description() {
    return tr("Open cards assigned to you, the soonest due first.")
  }, permission: 'dashboard.widget.my_tasks', w: 6, h: 5, filters: ['board'], limit: 8 },
  { key: 'list:overdue', kind: 'list', get title() {
    return tr("Overdue")
  }, group: 'Lists', get description() {
    return tr("Your overdue cards, overdue payments and passed ship dates.")
  }, permission: 'dashboard.widget.overdue', w: 6, h: 5, limit: 10 },
  { key: 'list:next_ship_dates', kind: 'list', get title() {
    return tr("Next Ship Dates")
  }, group: 'Lists', get description() {
    return tr("Orders in the queue by expected ship date.")
  }, permission: 'dashboard.list.next_ship_dates', w: 6, h: 6, filters: ['country', 'machineType'], limit: 10 },
  { key: 'list:payments_due', kind: 'list', get title() {
    return tr("Payments Due")
  }, group: 'Lists', get description() {
    return tr("The next payments due.")
  }, permission: 'dashboard.list.next_payments', needs: ['payments'], w: 6, h: 6, filters: ['country'], limit: 10 },
  { key: 'list:new_orders', kind: 'list', get title() {
    return tr("New Orders")
  }, group: 'Lists', get description() {
    return tr("Orders placed in the dates chosen.")
  }, permission: 'dashboard.widget.new_orders', w: 6, h: 5, range: true, filters: ['country', 'machineType'], limit: 10 },
  { key: 'list:latest_shipped', kind: 'list', get title() {
    return tr("Latest Shipped")
  }, group: 'Lists', get description() {
    return tr("The last orders shipped, early or late.")
  }, permission: 'dashboard.list.latest_shipped', w: 6, h: 5, filters: ['country', 'machineType'], limit: 5 },
  { key: 'schedule:changes', kind: 'schedule', get title() {
    return tr("Ship Dates at Risk")
  }, group: 'Lists', get description() {
    return tr("Orders whose suggested ship date is later than promised (Accept or Keep).")
  }, permission: 'dashboard.list.schedule_changes', needs: ['schedule'], w: 12, h: 4 },
  { key: 'board:snapshot', kind: 'board', get title() {
    return tr("Board Snapshot")
  }, group: 'Boards', get description() {
    return tr("Cards in each stage of a board you choose.")
  }, permission: 'dashboard.widget.board_snapshot', w: 6, h: 5, filters: ['board'] },
  { key: 'calendar:today', kind: 'calendar', get title() {
    return tr("Today’s Calendar")
  }, group: 'Calendar and People', get description() {
    return tr("Your calendar for today, with entries shared with you.")
  }, permission: 'dashboard.widget.calendar', w: 4, h: 4 },
  { key: 'events:upcoming', kind: 'events', get title() {
    return tr("Upcoming Events")
  }, group: 'Calendar and People', get description() {
    return tr("Company events meant for you.")
  }, permission: 'dashboard.widget.events', w: 4, h: 4, limit: 5 },
  { key: 'holidays:upcoming', kind: 'holidays', get title() {
    return tr("Upcoming Holidays")
  }, group: 'Calendar and People', get description() {
    return tr("Holidays and office closures still to come this year.")
  }, permission: 'dashboard.widget.holidays', w: 4, h: 4, limit: 6 },
  { key: 'people:whos_off', kind: 'whos_off', get title() {
    return tr("Who’s Off Today")
  }, group: 'Calendar and People', get description() {
    return tr("People on approved time off today.")
  }, permission: 'dashboard.whos_off', w: 4, h: 4 },
  { key: 'notices:latest', kind: 'notices', get title() {
    return tr("Latest Notices")
  }, group: 'Messages', get description() {
    return tr("The newest notices meant for you.")
  }, permission: 'dashboard.widget.notices', w: 4, h: 5, limit: 5 },
  { key: 'chats:unread', kind: 'chats', get title() {
    return tr("Unread Chats")
  }, group: 'Messages', get description() {
    return tr("Conversations with messages you have not read.")
  }, permission: 'dashboard.widget.chats', w: 4, h: 4, limit: 6 },
  { key: 'freight:totals', kind: 'freight', get title() {
    return tr("Freight and Crating")
  }, group: 'Freight and Money', get description() {
    return tr("Plywood sheets, crates made and crating hours in the dates chosen.")
  }, permission: 'dashboard.widget.freight_totals', w: 4, h: 3, range: true },
  { key: 'labour:cost', kind: 'labour', get title() {
    return tr("Labour Cost")
  }, group: 'Freight and Money', get description() {
    return tr("Labour cost, overtime and cost per hour in the dates chosen.")
  }, permission: 'dashboard.widget.labour_cost', needs: ['timesheets.labour_cost'], w: 4, h: 3, range: true, filters: ['department'] },
  { key: 'note:personal', kind: 'note', get title() {
    return tr("My Note")
  }, group: 'Personal', get description() {
    return tr("A note only you can see.")
  }, permission: 'dashboard.widget.note', w: 4, h: 3 },
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
