import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { inputClass, secondaryButtonClass } from '../components/form'
import { countryFlag } from '../lib/country'
import { downloadCsv } from '../lib/csv'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { formatMoney, friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { richTextToPlain } from '../lib/richText'
import { stageLabel, useStageLabels } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { PAYMENT_STATUSES, STAGES, type OrderSummaryRow } from '../lib/types'
import { serviceDates, useServiceInfo, type ServiceInfo } from '../lib/service'
import { useOptionList } from '../lib/useOptionList'
import SerialNumber from '../components/SerialNumber'
import PrintButton from '../components/print/PrintButton'
import { tr } from '../i18n'

type Value = string | number | null
/** An order, with its on-site training plan when a service column is shown. */
type Row = OrderSummaryRow & { service?: ServiceInfo }

type ColumnDef = {
  key: string
  /** Each column has its own permission (orders.list.column.…). */
  permission: string
  label: string
  /** Used for sorting and the CSV file. */
  value: (o: Row) => Value
  /** How the cell looks on screen (defaults to the value). */
  render?: (o: Row) => ReactNode
  align?: 'right'
  /** Shown in the CSV only. */
  csvOnly?: boolean
}

const paymentTone: Record<string, string> = {
  Overdue: 'bg-red-100 text-red-800',
  'Due soon': 'bg-amber-100 text-amber-900',
  Paid: 'bg-green-100 text-green-800',
  Open: 'bg-slate-100 text-slate-700',
  'No total': 'text-slate-400',
}

const money = (n: number | null, o: Row) => (n === null ? '' : formatMoney(n, o.currency).replace(/^[A-Z]{3}\s?/, ''))

const COLUMNS: ColumnDef[] = [
  {
    key: 'order',
    permission: 'orders.list.column.order',
    get label() {
    return tr("Order #")
  },
    value: (o) => o.order_number * 1000 + (o.split_number ?? 0),
    render: /* @rendered-inside-can */ (o) => <span className="font-medium">{o.order_code}</span>,
  },
  { key: 'quote', permission: 'orders.list.column.quote', get label() {
    return tr("Quote #")
  }, value: (o) => o.quote_number ?? null },
  { key: 'invoice', permission: 'orders.list.column.invoice', get label() {
    return tr("Invoice #")
  }, value: (o) => o.invoice_number ?? null },
  { key: 'stage', permission: 'orders.list.column.stage', get label() {
    return tr("Stage")
  }, value: (o) => stageLabel(o.stage) },
  { key: 'customer', permission: 'orders.list.column.customer', get label() {
    return tr("Customer")
  }, value: (o) => o.customer_name },
  { key: 'company', permission: 'orders.list.column.company', get label() {
    return tr("Company")
  }, value: (o) => o.customer_company },
  {
    key: 'country',
    permission: 'orders.list.column.country',
    get label() {
    return tr("Country")
  },
    value: (o) => o.customer_country,
    render: /* @rendered-inside-can */ (o) => (
      <>
        {countryFlag(o.customer_country)} {o.customer_country}
      </>
    ),
  },
  { key: 'state', permission: 'orders.list.column.state', get label() {
    return tr("State / province")
  }, value: (o) => o.customer_state_province },
  { key: 'machines', permission: 'orders.list.column.machines', get label() {
    return tr("Machines")
  }, value: (o) => o.machines_list },
  {
    key: 'serials',
    permission: 'orders.list.column.serials',
    get label() {
    return tr("Serials")
  },
    value: (o) => o.serials,
    render: /* @rendered-inside-can */ (o) => (
      <span className="flex gap-x-2 text-xs">
        {(o.serials ?? '')
          .split(', ')
          .filter(Boolean)
          .map((s) => (
            <SerialNumber key={s} serial={s} />
          ))}
      </span>
    ),
  },
  {
    key: 'ready',
    permission: 'orders.list.column.ready',
    get label() {
    return tr("Ready")
  },
    value: (o) => (o.machines_count ? `${o.machines_ready_count}/${o.machines_count}` : ''),
    align: 'right',
  },
  {
    key: 'expected',
    permission: 'orders.list.column.expected',
    get label() {
    return tr("Expected ship")
  },
    value: (o) => o.expected_ship_date,
    render: /* @rendered-inside-can */ (o) => showDate(o.expected_ship_date),
  },
  {
    key: 'original',
    permission: 'orders.list.column.original',
    get label() {
    return tr("Original ship date")
  },
    value: (o) => o.original_ship_date ?? null,
    render: /* @rendered-inside-can */ (o) => showDate(o.original_ship_date),
  },
  { key: 'revisions', permission: 'orders.list.column.revisions', get label() {
    return tr("Ship date changes")
  }, value: (o) => o.ship_date_revisions ?? 0, align: 'right' },
  {
    key: 'actual',
    permission: 'orders.list.column.actual',
    get label() {
    return tr("Actual ship")
  },
    value: (o) => o.actual_ship_date,
    render: /* @rendered-inside-can */ (o) => showDate(o.actual_ship_date),
  },
  {
    key: 'delay',
    permission: 'orders.list.column.delay',
    get label() {
    return tr("Delay (days)")
  },
    value: (o) => o.delay_days,
    align: 'right',
    render: /* @rendered-inside-can */ (o) =>
      o.delay_days === null ? (
        ''
      ) : (
        <span className={o.delay_days > 0 ? 'text-red-700' : o.delay_days < 0 ? 'text-green-700' : ''}>
          {o.delay_days > 0 ? `+${o.delay_days}` : o.delay_days}
        </span>
      ),
  },
  { key: 'voltage', permission: 'orders.list.column.voltage', get label() {
    return tr("Voltage")
  }, value: (o) => o.voltage },
  { key: 'delivery', permission: 'orders.list.column.delivery', get label() {
    return tr("Delivery equipment")
  }, value: (o) => o.delivery_equipment },
  { key: 'freight', permission: 'orders.list.column.freight', get label() {
    return tr("Freight")
  }, value: (o) => o.freight_type },
  { key: 'currency', permission: 'orders.list.column.currency', get label() {
    return tr("Cur.")
  }, value: (o) => o.currency },
  {
    key: 'total',
    permission: 'orders.list.column.total',
    get label() {
    return tr("Total")
  },
    value: (o) => o.order_total,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => money(o.order_total, o),
  },
  {
    key: 'downpct',
    permission: 'orders.list.column.downpct',
    get label() {
    return tr("Down %")
  },
    value: (o) => o.down_payment_percent,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => (o.down_payment_percent === null ? '' : `${o.down_payment_percent}%`),
  },
  {
    key: 'paid',
    permission: 'orders.list.column.paid',
    get label() {
    return tr("Paid")
  },
    value: (o) => o.total_paid,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => money(o.total_paid, o),
  },
  {
    key: 'outstanding',
    permission: 'orders.list.column.outstanding',
    get label() {
    return tr("Outstanding")
  },
    value: (o) => o.amount_outstanding,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => money(o.amount_outstanding, o),
  },
  {
    key: 'nextdue',
    permission: 'orders.list.column.nextdue',
    get label() {
    return tr("Next payment due")
  },
    value: (o) => o.next_due_date,
    render: /* @rendered-inside-can */ (o) => showDate(o.next_due_date),
  },
  {
    key: 'payment',
    permission: 'orders.list.column.payment',
    get label() {
    return tr("Payment")
  },
    value: (o) => o.payment_status,
    render: /* @rendered-inside-can */ (o) => (
      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${o.payment_status ? (paymentTone[o.payment_status] ?? '') : ''}`}>{o.payment_status}</span>
    ),
  },
  {
    key: 'training',
    permission: 'orders.list.column.training',
    get label() {
    return tr("Training")
  },
    value: (o) => (o.service?.training_needed ? 'Needed' : ''),
  },
  { key: 'technician', permission: 'orders.list.column.technician', get label() {
    return tr("Technician")
  }, value: (o) => o.service?.technician_name ?? null },
  {
    key: 'servicedates',
    permission: 'orders.list.column.service_dates',
    get label() {
    return tr("Training dates")
  },
    value: (o) => o.service?.service_start ?? null,
    render: /* @rendered-inside-can */ (o) => serviceDates(o.service?.service_start ?? null, o.service?.service_end ?? null),
  },
  {
    key: 'servicedays',
    permission: 'orders.list.column.service_days',
    get label() {
    return tr("Training / travel days")
  },
    value: (o) =>
      o.service && (o.service.training_days !== null || o.service.travel_days !== null)
        ? `${o.service.training_days ?? 0} / ${o.service.travel_days ?? 0}`
        : null,
    align: 'right',
  },
  { key: 'downamount', permission: 'orders.list.column.downamount', get label() {
    return tr("Down payment")
  }, value: (o) => o.down_payment_amount, csvOnly: true },
  { key: 'orderdate', permission: 'orders.list.column.orderdate', get label() {
    return tr("Order date")
  }, value: (o) => o.order_date, csvOnly: true },
  { key: 'notes', permission: 'orders.list.column.notes', get label() {
    return tr("Notes")
  }, value: (o) => richTextToPlain(o.notes), csvOnly: true },
  { key: 'archived', permission: 'orders.list.column.archived', get label() {
    return tr("Archived")
  }, value: (o) => (o.archived ? 'Archived' : ''), csvOnly: true },
]

type Filters = {
  q: string
  stage: string
  voltage: string
  payment: string
  sort: string
  dir: 'asc' | 'desc'
  archived: boolean
  /** Expected and actual ship date from / to (yyyy-mm-dd), delay days lowest / highest, currency, training yes / no. */
  shipFrom: string
  shipTo: string
  actFrom: string
  actTo: string
  delayMin: string
  delayMax: string
  currency: string
  training: string
}

/** Optional columns: hidden until chosen with "Columns". */
const HIDDEN_BY_DEFAULT = ['quote', 'invoice', 'original', 'revisions', 'downamount', 'orderdate', 'notes', 'archived']
const COLS_KEY = 'bmm.orders.columns'
function readHidden(): string[] {
  try {
    const v = localStorage.getItem(COLS_KEY)
    return v ? (JSON.parse(v) as string[]) : HIDDEN_BY_DEFAULT
  } catch {
    return HIDDEN_BY_DEFAULT
  }
}
const list = (v: string | null) => (v ? v.split('|').filter(Boolean) : [])

const RANGE_KEYS = ['shipFrom', 'shipTo', 'actFrom', 'actTo', 'delayMin', 'delayMax', 'currency', 'training'] as const
const defaultFilters: Filters = {
  q: '', stage: 'open', voltage: '', payment: '', sort: 'order', dir: 'asc', archived: false,
  shipFrom: '', shipTo: '', actFrom: '', actTo: '', delayMin: '', delayMax: '', currency: '', training: '',
}
// Rows hidden with "Hide" (remembered in this browser).
const ROWS_KEY = 'bmm.orders.hiddenRows'
function readHiddenRows(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ROWS_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function readFilters(p: URLSearchParams): Filters {
  return {
    q: p.get('q') ?? defaultFilters.q,
    stage: p.get('stage') ?? defaultFilters.stage,
    voltage: p.get('voltage') ?? defaultFilters.voltage,
    payment: p.get('payment') ?? defaultFilters.payment,
    sort: p.get('sort') ?? defaultFilters.sort,
    dir: p.get('dir') === 'desc' ? 'desc' : 'asc',
    archived: p.get('archived') === '1',
    ...(Object.fromEntries(RANGE_KEYS.map((k) => [k, p.get(k) ?? ''])) as Pick<Filters, (typeof RANGE_KEYS)[number]>),
  }
}

/** Only values that differ from the defaults go in the address bar. */
function writeFilters(f: Filters) {
  const p = new URLSearchParams()
  for (const key of Object.keys(defaultFilters) as (keyof Filters)[]) {
    if (f[key] !== defaultFilters[key]) p.set(key, key === 'archived' ? '1' : String(f[key]))
  }
  return p
}

function compare(a: Value, b: Value) {
  // Empty cells always go to the bottom.
  if (a === null || a === '') return b === null || b === '' ? 0 : 1
  if (b === null || b === '') return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export default function OrdersListPage() {
  const navigate = useNavigate()
  const { can } = usePermissions()
  useStageLabels()
  // Only the columns this person may see (on screen and in the CSV file).
  const allowedColumns = COLUMNS.filter((c) => can(c.permission))
  // Columns chosen with "Columns" (remembered in this browser); CSV-only ones go in the file only.
  const [hidden, setHidden] = useState<string[]>(readHidden)
  const [chooser, setChooser] = useState(false)
  const chosenColumns = allowedColumns.filter((c) => c.key === 'order' || !hidden.includes(c.key))
  const visibleColumns = chosenColumns.filter((c) => !c.csvOnly)
  const toggleColumn = (key: string) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]
    setHidden(next)
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(next))
    } catch {
      // storage blocked: the choice lasts until the page is closed
    }
  }
  const canSort = can('orders.list.sort')
  const opensOrders = can('order.page')
  const [params, setParams] = useSearchParams()
  const [loaded, setOrders] = useState<Row[]>([])
  const serviceInfo = useServiceInfo(
    ['orders.list.column.training', 'orders.list.column.technician', 'orders.list.column.service_dates', 'orders.list.column.service_days', 'orders.list.filter.training'].some((k) => can(k)),
  )
  // Rows hidden by hand, and whether they are shown again for now.
  const [hiddenRows, setHiddenRows] = useState<string[]>(readHiddenRows)
  const [showHiddenRows, setShowHiddenRows] = useState(false)
  const toggleRow = (id: string) => {
    const next = hiddenRows.includes(id) ? hiddenRows.filter((x) => x !== id) : [...hiddenRows, id]
    setHiddenRows(next)
    try {
      localStorage.setItem(ROWS_KEY, JSON.stringify(next))
    } catch {
      // storage blocked: the choice lasts until the page is closed
    }
  }
  const mayHideRows = can('orders.list.rows')
  const orders = useMemo(() => (serviceInfo.size ? loaded.map((o) => ({ ...o, service: serviceInfo.get(o.id) })) : loaded), [loaded, serviceInfo])
  const [loading, setLoading] = useState(true)
  const voltageList = useOptionList('voltage')

  // Filters are copied to the address bar, so a refresh or a shared link keeps them.
  const [filters, setFilters] = useState<Filters>(() => readFilters(params))
  // Checkbox filters (several stages, voltages, machine types), kept in the address too.
  const stages = list(params.get('stages'))
  const voltages = list(params.get('voltages'))
  const types = list(params.get('types'))
  const [more, setMore] = useState(stages.length + voltages.length + types.length > 0)
  const toggleIn = (key: 'stages' | 'voltages' | 'types', value: string) => {
    const cur = list(params.get(key))
    const next = new URLSearchParams(params)
    const v = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]
    if (v.length) next.set(key, v.join('|'))
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const { q, stage, voltage, payment, sort: sortKey, dir: sortDir, archived: showArchived, shipFrom, shipTo, actFrom, actTo, delayMin, delayMax, currency, training } = filters
  const rangeCount = RANGE_KEYS.filter((k) => filters[k]).length
  useEffect(() => {
    const next = writeFilters(filters)
    for (const k of ['stages', 'voltages', 'types']) {
      const v = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(k)
      if (v) next.set(k, v)
    }
    setParams(next, { replace: true })
  }, [filters, setParams])
  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }))

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    const { data, error } = await fetchAll<Row>(() => {
      let query = supabase!.from('order_summary').select('*').order('id')
      if (!showArchived) query = query.eq('archived', false)
      return query
    })
    if (error) toast.error(friendlyError(error))
    setOrders(data)
    setLoading(false)
  }, [showArchived])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const voltageChoices = useMemo(() => [...new Set([...voltageList.options, ...orders.map((o) => o.voltage)])], [voltageList.options, orders])

  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = orders.filter((o) => {
      if (stage === 'open' && (o.stage === 'Shipped' || o.stage === 'Cancelled')) return false
      if (stage !== 'open' && stage !== 'all' && o.stage !== stage) return false
      if (voltage && o.voltage !== voltage) return false
      if (payment && o.payment_status !== payment) return false
      if (stages.length && !stages.includes(o.stage)) return false
      if (voltages.length && !voltages.includes(o.voltage)) return false
      if (types.length && !types.some((t) => (o.machines_list ?? '').includes(`× ${t}`))) return false
      // Ship dates, delay, currency and training: an empty value never matches a filter that is set.
      const exp = o.expected_ship_date ?? ''
      if (shipFrom && (!exp || exp < shipFrom)) return false
      if (shipTo && (!exp || exp > shipTo)) return false
      const act = o.actual_ship_date ?? ''
      if (actFrom && (!act || act < actFrom)) return false
      if (actTo && (!act || act > actTo)) return false
      if (delayMin !== '' && (o.delay_days === null || o.delay_days < Number(delayMin))) return false
      if (delayMax !== '' && (o.delay_days === null || o.delay_days > Number(delayMax))) return false
      if (currency && o.currency !== currency) return false
      if (training === 'yes' && !o.service?.training_needed) return false
      if (training === 'no' && o.service?.training_needed) return false
      if (mayHideRows && !showHiddenRows && hiddenRows.includes(o.id)) return false
      if (words.length) {
        const text = [o.order_code, o.customer_name, o.customer_company, o.customer_country, o.customer_state_province, o.serials, o.machines_list]
          .join(' ')
          .toLowerCase()
        if (!words.every((w) => text.includes(w))) return false
      }
      return true
    })
    const column = COLUMNS.find((c) => c.key === sortKey && can(c.permission)) ?? COLUMNS[0]
    const sorted = [...filtered].sort((a, b) => {
      const r = compare(column.value(a), column.value(b))
      // Keep empty cells at the bottom in both directions.
      const aEmpty = column.value(a) === null || column.value(a) === ''
      const bEmpty = column.value(b) === null || column.value(b) === ''
      if (aEmpty || bEmpty) return r
      return sortDir === 'asc' ? r : -r
    })
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, q, stage, voltage, payment, sortKey, sortDir, can, params, shipFrom, shipTo, actFrom, actTo, delayMin, delayMax, currency, training, hiddenRows, showHiddenRows, mayHideRows])

  const outstandingByCurrency = useMemo(() => {
    const sums: Record<string, number> = {}
    for (const o of rows) sums[o.currency] = (sums[o.currency] ?? 0) + Number(o.amount_outstanding ?? 0)
    return sums
  }, [rows])

  function sortBy(key: string) {
    if (!canSort) return
    setFilters((f) => (f.sort === key ? { ...f, dir: f.dir === 'asc' ? 'desc' : 'asc' } : { ...f, sort: key, dir: 'asc' }))
  }

  function exportCsv() {
    downloadCsv(
      `orders-${todayISO()}.csv`,
      // Exactly what the list shows: the filtered rows (hidden rows left out) and the chosen columns.
      chosenColumns.map((c) => c.label),
      rows.filter((o) => !(mayHideRows && hiddenRows.includes(o.id))).map((o) => chosenColumns.map((c) => (c.key === 'order' ? o.order_code : c.value(o)))),
    )
  }

  const filtersOn = q || stage !== 'open' || voltage || payment || stages.length || voltages.length || types.length || rangeCount
  const hiddenCount = mayHideRows ? orders.filter((o) => hiddenRows.includes(o.id)).length : 0
  const currencies = [...new Set(orders.map((o) => o.currency))].sort()
  const MORE_KEYS = ['orders.list.filter.checkboxes', 'orders.list.filter.ship_dates', 'orders.list.filter.delay', 'orders.list.filter.currency', 'orders.list.filter.training']
  const typeNames = [
    ...new Set(
      orders.flatMap((o) =>
        (o.machines_list ?? '')
          .split(', ')
          .map((x) => x.replace(/^\d+× /, ''))
          .filter(Boolean),
      ),
    ),
  ].sort()

  return (
    <Can permission="orders.list">
      <div className="-m-4 flex flex-col p-4 md:-m-8 md:h-[calc(100%+4rem)] md:p-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold">{tr("Orders List")}</h1>
            <Can permission="orders.list.print">
              <PrintButton title={tr("Orders List")} />
            </Can>
          </div>
          <div className="flex gap-2">
            <Can permission="orders.list.columns">
              <div className="relative">
                <button type="button" className={secondaryButtonClass} onClick={() => setChooser(!chooser)} aria-expanded={chooser}>
                  {tr("Columns")}
                </button>
                {chooser && (
                  <div className="absolute right-0 z-20 mt-1 max-h-96 w-64 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 text-sm shadow-lg">
                    {allowedColumns
                      .filter((c) => c.key !== 'order')
                      .map((c) => (
                        <label key={c.key} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-50">
                          <input type="checkbox" className="h-4 w-4" checked={!hidden.includes(c.key)} onChange={() => toggleColumn(c.key)} />
                          {c.label}
                          {c.csvOnly && <span className="text-xs text-slate-500">{tr("(CSV only)")}</span>}
                        </label>
                      ))}
                  </div>
                )}
              </div>
            </Can>
            <Can permission="orders.list.export_csv">
              <button type="button" className={secondaryButtonClass} onClick={exportCsv} disabled={rows.length === 0}>
                {tr("Export CSV")}
              </button>
            </Can>
            <Can permission="orders.new" level="edit">
              <Link to="/orders/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
                {tr("New Order")}
              </Link>
            </Can>
          </div>
        </div>

        <div className="mb-3 grid gap-2 empty:hidden sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto_auto]">
          <Can permission="orders.list.filter.search">
            <input
              type="search"
              aria-label={tr("Search")}
              className={inputClass}
              placeholder={tr("Search by customer, company, country, serial or order #")}
              value={q}
              onChange={(e) => setFilter('q', e.target.value)}
            />
          </Can>
          <Can permission="orders.list.filter.stage">
            <select aria-label={tr("Stage")} className={inputClass} value={stage} onChange={(e) => setFilter('stage', e.target.value)}>
              <option value="open">{tr("Open orders")}</option>
              <option value="all">{tr("All stages")}</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {stageLabel(s)}
                </option>
              ))}
            </select>
          </Can>
          <Can permission="orders.list.filter.voltage">
            <select aria-label={tr("Voltage")} className={inputClass} value={voltage} onChange={(e) => setFilter('voltage', e.target.value)}>
              <option value="">{tr("Any voltage")}</option>
              {voltageChoices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Can>
          <Can permission="orders.list.filter.payment">
            <select aria-label={tr("Payment")} className={inputClass} value={payment} onChange={(e) => setFilter('payment', e.target.value)}>
              <option value="">{tr("Any payment status")}</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Can>
          <Can anyOf={MORE_KEYS}>
            <button type="button" className={`${secondaryButtonClass} whitespace-nowrap`} onClick={() => setMore(!more)} aria-expanded={more}>
              {tr("More Filters")}{stages.length + voltages.length + types.length + rangeCount ? ` (${stages.length + voltages.length + types.length + rangeCount})` : ''}
            </button>
          </Can>
          <Can permission="orders.list.filter.archived">
            <label className="flex items-center gap-2 text-sm whitespace-nowrap text-slate-600">
              <input type="checkbox" checked={showArchived} onChange={(e) => setFilter('archived', e.target.checked)} />
              {tr("Show archived")}
            </label>
          </Can>
        </div>
        {more && (
          <Can anyOf={MORE_KEYS}>
            <div className="mb-3 grid gap-3 rounded-md border border-slate-200 bg-white p-3 text-sm [grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]">
              <Can permission="orders.list.filter.ship_dates">
                <fieldset>
                  <legend className="mb-1 font-medium">{tr("Expected ship date")}</legend>
                  <div className="grid gap-1">
                    <input type="date" aria-label={tr("Expected ship date from")} className={inputClass} value={shipFrom} onChange={(e) => setFilter('shipFrom', e.target.value)} />
                    <input type="date" aria-label={tr("Expected ship date to")} className={inputClass} value={shipTo} onChange={(e) => setFilter('shipTo', e.target.value)} />
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="mb-1 font-medium">{tr("Actual ship date")}</legend>
                  <div className="grid gap-1">
                    <input type="date" aria-label={tr("Actual ship date from")} className={inputClass} value={actFrom} onChange={(e) => setFilter('actFrom', e.target.value)} />
                    <input type="date" aria-label={tr("Actual ship date to")} className={inputClass} value={actTo} onChange={(e) => setFilter('actTo', e.target.value)} />
                  </div>
                </fieldset>
              </Can>
              <Can permission="orders.list.filter.delay">
                <fieldset>
                  <legend className="mb-1 font-medium">{tr("Delay (days)")}</legend>
                  <div className="grid grid-cols-2 gap-1">
                    <input inputMode="numeric" aria-label={tr("Delay at least")} placeholder={tr("Lowest")} className={inputClass} value={delayMin} onChange={(e) => setFilter('delayMin', e.target.value.replace(/[^0-9-]/g, ''))} />
                    <input inputMode="numeric" aria-label={tr("Delay at most")} placeholder={tr("Highest")} className={inputClass} value={delayMax} onChange={(e) => setFilter('delayMax', e.target.value.replace(/[^0-9-]/g, ''))} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{tr("Negative = shipped early. Only shipped orders have a delay.")}</p>
                </fieldset>
              </Can>
              <Can permission="orders.list.filter.currency">
                <fieldset>
                  <legend className="mb-1 font-medium">{tr("Currency")}</legend>
                  <select aria-label={tr("Currency")} className={inputClass} value={currency} onChange={(e) => setFilter('currency', e.target.value)}>
                    <option value="">{tr("Any currency")}</option>
                    {currencies.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </fieldset>
              </Can>
              <Can permission="orders.list.filter.training">
                <fieldset>
                  <legend className="mb-1 font-medium">{tr("On-site training")}</legend>
                  <select aria-label={tr("On-site training")} className={inputClass} value={training} onChange={(e) => setFilter('training', e.target.value)}>
                    <option value="">{tr("Any")}</option>
                    <option value="yes">{tr("Training needed")}</option>
                    <option value="no">{tr("No training")}</option>
                  </select>
                </fieldset>
              </Can>
              <Can permission="orders.list.filter.checkboxes">
              {(
                [
                  ['stages', 'Stages', STAGES.map((x) => [x, stageLabel(x)])],
                  ['voltages', 'Voltage', voltageChoices.map((x) => [x, x])],
                  ['types', 'Machine types', typeNames.map((x) => [x, x])],
                ] as ['stages' | 'voltages' | 'types', string, string[][]][]
              ).map(([key, title, options]) => (
                <fieldset key={key}>
                  <legend className="mb-1 font-medium">{title}</legend>
                  <div className="max-h-40 space-y-0.5 overflow-y-auto">
                    {options.map(([v, l]) => (
                      <label key={v} className="flex items-center gap-2">
                        <input type="checkbox" className="h-4 w-4" checked={list(params.get(key)).includes(v)} onChange={() => toggleIn(key, v)} />
                        {l}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              </Can>
            </div>
          </Can>
        )}

        <div className="max-h-[40rem] min-h-64 flex-1 overflow-auto rounded-md border border-slate-300 bg-white md:max-h-none">
          <table className="min-w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-100">
              <tr>
                {visibleColumns.map((c) => (
                  <Can key={c.key} permission={c.permission}>
                    <th
                      className={`border-r border-b border-slate-300 px-2 py-1.5 font-semibold whitespace-nowrap text-slate-700 ${
                        c.align === 'right' ? 'text-right' : 'text-left'
                      }`}
                      aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      <Can permission="orders.list.sort" fallback={c.label}>
                        <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 hover:underline">
                          {c.label}
                          <span className="text-xs text-slate-400">{sortKey === c.key ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                        </button>
                      </Can>
                    </th>
                  </Can>
                ))}
                {mayHideRows && (
                  <Can permission="orders.list.rows">
                    <th className="border-b border-slate-300 px-2 py-1.5 text-left font-semibold text-slate-700" data-print="hide">
                      <span className="sr-only">{tr("Hide row")}</span>
                    </th>
                  </Can>
                )}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-6 text-center text-slate-500">
                    {tr("Loading…")}
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-6 text-center text-slate-500">
                    {orders.length === 0 ? tr("No orders have been entered yet.") : tr("No orders match these filters. Clear the filters to see all orders.")}
                  </td>
                </tr>
              )}
              {rows.map((o) => (
                <tr
                  key={o.id}
                  onClick={opensOrders ? () => navigate(`/orders/${o.id}`) : undefined}
                  className={`odd:bg-white even:bg-slate-50 ${opensOrders ? 'cursor-pointer hover:bg-blue-50' : ''} ${o.archived || hiddenRows.includes(o.id) ? 'text-slate-400' : ''}`}
                >
                  {visibleColumns.map((c) => (
                    <Can key={c.key} permission={c.permission}>
                      <td className={`border-r border-b border-slate-200 px-2 py-1 whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                        {c.render ? c.render(o) : (c.value(o) ?? '')}
                      </td>
                    </Can>
                  ))}
                  {mayHideRows && (
                    <Can permission="orders.list.rows">
                      <td className="border-b border-slate-200 px-2 py-1 whitespace-nowrap" data-print="hide">
                        <button
                          type="button"
                          className="text-xs text-slate-600 underline"
                          aria-label={tr("{{value}} order {{order_code}}", { value: hiddenRows.includes(o.id) ? tr("Show") : tr("Hide"), order_code: o.order_code })}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleRow(o.id)
                          }}
                        >
                          {hiddenRows.includes(o.id) ? tr("Show") : tr("Hide")}
                        </button>
                      </td>
                    </Can>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
          <span>
            {rows.length} {tr("of")} {tr("{{count}} order", { count: orders.length })}
            {hiddenCount > 0 && (
              <Can permission="orders.list.rows">
                <button type="button" className="ml-3 underline" onClick={() => setShowHiddenRows(!showHiddenRows)}>
                  {showHiddenRows ? tr("Leave Out Hidden Rows ({{hiddenCount}})", { hiddenCount: hiddenCount }) : tr("Show Hidden Rows ({{hiddenCount}})", { hiddenCount: hiddenCount })}
                </button>
              </Can>
            )}
            {filtersOn && (
              <Can anyOf={['orders.list.filter.search', 'orders.list.filter.stage', 'orders.list.filter.voltage', 'orders.list.filter.payment', ...MORE_KEYS]}>
                <button
                  type="button"
                  className="ml-3 underline"
                  onClick={() => {
                    setParams(writeFilters({ ...defaultFilters, sort: filters.sort, dir: filters.dir, archived: filters.archived }), { replace: true })
                    setFilters((f) => ({ ...defaultFilters, sort: f.sort, dir: f.dir, archived: f.archived }))
                  }}
                >
                  {tr("Clear Filters")}
                </button>
              </Can>
            )}
          </span>
          <Can permission="orders.list.outstanding_total">
            <span>
              {tr("Outstanding:")}{' '}
              {Object.keys(outstandingByCurrency).length === 0
                ? '—'
                : Object.entries(outstandingByCurrency)
                    .map(([cur, sum]) => formatMoney(sum, cur))
                    .join(' · ')}
            </span>
          </Can>
        </div>
      </div>
    </Can>
  )
}
