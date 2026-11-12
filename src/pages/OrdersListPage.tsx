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
    label: 'Order #',
    value: (o) => o.order_number * 1000 + (o.split_number ?? 0),
    render: /* @rendered-inside-can */ (o) => <span className="font-medium">{o.order_code}</span>,
  },
  { key: 'quote', permission: 'orders.list.column.quote', label: 'Quote #', value: (o) => o.quote_number ?? null },
  { key: 'invoice', permission: 'orders.list.column.invoice', label: 'Invoice #', value: (o) => o.invoice_number ?? null },
  { key: 'stage', permission: 'orders.list.column.stage', label: 'Stage', value: (o) => stageLabel(o.stage) },
  { key: 'customer', permission: 'orders.list.column.customer', label: 'Customer', value: (o) => o.customer_name },
  { key: 'company', permission: 'orders.list.column.company', label: 'Company', value: (o) => o.customer_company },
  {
    key: 'country',
    permission: 'orders.list.column.country',
    label: 'Country',
    value: (o) => o.customer_country,
    render: /* @rendered-inside-can */ (o) => (
      <>
        {countryFlag(o.customer_country)} {o.customer_country}
      </>
    ),
  },
  { key: 'state', permission: 'orders.list.column.state', label: 'State / province', value: (o) => o.customer_state_province },
  { key: 'machines', permission: 'orders.list.column.machines', label: 'Machines', value: (o) => o.machines_list },
  {
    key: 'serials',
    permission: 'orders.list.column.serials',
    label: 'Serials',
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
    label: 'Ready',
    value: (o) => (o.machines_count ? `${o.machines_ready_count}/${o.machines_count}` : ''),
    align: 'right',
  },
  {
    key: 'expected',
    permission: 'orders.list.column.expected',
    label: 'Expected ship',
    value: (o) => o.expected_ship_date,
    render: /* @rendered-inside-can */ (o) => showDate(o.expected_ship_date),
  },
  {
    key: 'original',
    permission: 'orders.list.column.original',
    label: 'Original ship date',
    value: (o) => o.original_ship_date ?? null,
    render: /* @rendered-inside-can */ (o) => showDate(o.original_ship_date),
  },
  { key: 'revisions', permission: 'orders.list.column.revisions', label: 'Ship date changes', value: (o) => o.ship_date_revisions ?? 0, align: 'right' },
  {
    key: 'actual',
    permission: 'orders.list.column.actual',
    label: 'Actual ship',
    value: (o) => o.actual_ship_date,
    render: /* @rendered-inside-can */ (o) => showDate(o.actual_ship_date),
  },
  {
    key: 'delay',
    permission: 'orders.list.column.delay',
    label: 'Delay (days)',
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
  { key: 'voltage', permission: 'orders.list.column.voltage', label: 'Voltage', value: (o) => o.voltage },
  { key: 'delivery', permission: 'orders.list.column.delivery', label: 'Delivery equipment', value: (o) => o.delivery_equipment },
  { key: 'freight', permission: 'orders.list.column.freight', label: 'Freight', value: (o) => o.freight_type },
  { key: 'currency', permission: 'orders.list.column.currency', label: 'Cur.', value: (o) => o.currency },
  {
    key: 'total',
    permission: 'orders.list.column.total',
    label: 'Total',
    value: (o) => o.order_total,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => money(o.order_total, o),
  },
  {
    key: 'downpct',
    permission: 'orders.list.column.downpct',
    label: 'Down %',
    value: (o) => o.down_payment_percent,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => (o.down_payment_percent === null ? '' : `${o.down_payment_percent}%`),
  },
  {
    key: 'paid',
    permission: 'orders.list.column.paid',
    label: 'Paid',
    value: (o) => o.total_paid,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => money(o.total_paid, o),
  },
  {
    key: 'outstanding',
    permission: 'orders.list.column.outstanding',
    label: 'Outstanding',
    value: (o) => o.amount_outstanding,
    align: 'right',
    render: /* @rendered-inside-can */ (o) => money(o.amount_outstanding, o),
  },
  {
    key: 'nextdue',
    permission: 'orders.list.column.nextdue',
    label: 'Next payment due',
    value: (o) => o.next_due_date,
    render: /* @rendered-inside-can */ (o) => showDate(o.next_due_date),
  },
  {
    key: 'payment',
    permission: 'orders.list.column.payment',
    label: 'Payment',
    value: (o) => o.payment_status,
    render: /* @rendered-inside-can */ (o) => (
      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${o.payment_status ? (paymentTone[o.payment_status] ?? '') : ''}`}>{o.payment_status}</span>
    ),
  },
  {
    key: 'training',
    permission: 'orders.list.column.training',
    label: 'Training',
    value: (o) => (o.service?.training_needed ? 'Needed' : ''),
  },
  { key: 'technician', permission: 'orders.list.column.technician', label: 'Technician', value: (o) => o.service?.technician_name ?? null },
  {
    key: 'servicedates',
    permission: 'orders.list.column.service_dates',
    label: 'Training dates',
    value: (o) => o.service?.service_start ?? null,
    render: /* @rendered-inside-can */ (o) => serviceDates(o.service?.service_start ?? null, o.service?.service_end ?? null),
  },
  {
    key: 'servicedays',
    permission: 'orders.list.column.service_days',
    label: 'Training / travel days',
    value: (o) =>
      o.service && (o.service.training_days !== null || o.service.travel_days !== null)
        ? `${o.service.training_days ?? 0} / ${o.service.travel_days ?? 0}`
        : null,
    align: 'right',
  },
  { key: 'downamount', permission: 'orders.list.column.downamount', label: 'Down payment', value: (o) => o.down_payment_amount, csvOnly: true },
  { key: 'orderdate', permission: 'orders.list.column.orderdate', label: 'Order date', value: (o) => o.order_date, csvOnly: true },
  { key: 'notes', permission: 'orders.list.column.notes', label: 'Notes', value: (o) => richTextToPlain(o.notes), csvOnly: true },
  { key: 'archived', permission: 'orders.list.column.archived', label: 'Archived', value: (o) => (o.archived ? 'Archived' : ''), csvOnly: true },
]

type Filters = {
  q: string
  stage: string
  voltage: string
  payment: string
  sort: string
  dir: 'asc' | 'desc'
  archived: boolean
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

const defaultFilters: Filters = { q: '', stage: 'open', voltage: '', payment: '', sort: 'order', dir: 'asc', archived: false }

function readFilters(p: URLSearchParams): Filters {
  return {
    q: p.get('q') ?? defaultFilters.q,
    stage: p.get('stage') ?? defaultFilters.stage,
    voltage: p.get('voltage') ?? defaultFilters.voltage,
    payment: p.get('payment') ?? defaultFilters.payment,
    sort: p.get('sort') ?? defaultFilters.sort,
    dir: p.get('dir') === 'desc' ? 'desc' : 'asc',
    archived: p.get('archived') === '1',
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
    ['orders.list.column.training', 'orders.list.column.technician', 'orders.list.column.service_dates', 'orders.list.column.service_days'].some((k) => can(k)),
  )
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
  const { q, stage, voltage, payment, sort: sortKey, dir: sortDir, archived: showArchived } = filters
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
  }, [orders, q, stage, voltage, payment, sortKey, sortDir, can, params])

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
      // Exactly what the list shows: the filtered rows and the chosen columns.
      chosenColumns.map((c) => c.label),
      rows.map((o) => chosenColumns.map((c) => (c.key === 'order' ? o.order_code : c.value(o)))),
    )
  }

  const filtersOn = q || stage !== 'open' || voltage || payment || stages.length || voltages.length || types.length
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
      <div className="-m-4 flex h-[calc(100%+2rem)] flex-col p-4 md:-m-8 md:h-[calc(100%+4rem)] md:p-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Orders List</h1>
          <div className="flex gap-2">
            <Can permission="orders.list.columns">
              <div className="relative">
                <button type="button" className={secondaryButtonClass} onClick={() => setChooser(!chooser)} aria-expanded={chooser}>
                  Columns
                </button>
                {chooser && (
                  <div className="absolute right-0 z-20 mt-1 max-h-96 w-64 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 text-sm shadow-lg">
                    {allowedColumns
                      .filter((c) => c.key !== 'order')
                      .map((c) => (
                        <label key={c.key} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-50">
                          <input type="checkbox" className="h-4 w-4" checked={!hidden.includes(c.key)} onChange={() => toggleColumn(c.key)} />
                          {c.label}
                          {c.csvOnly && <span className="text-xs text-slate-500">(CSV only)</span>}
                        </label>
                      ))}
                  </div>
                )}
              </div>
            </Can>
            <Can permission="orders.list.export_csv">
              <button type="button" className={secondaryButtonClass} onClick={exportCsv} disabled={rows.length === 0}>
                Export CSV
              </button>
            </Can>
            <Can permission="orders.new" level="edit">
              <Link to="/orders/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
                New Order
              </Link>
            </Can>
          </div>
        </div>

        <div className="mb-3 grid gap-2 empty:hidden sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto_auto]">
          <Can permission="orders.list.filter.search">
            <input
              type="search"
              aria-label="Search"
              className={inputClass}
              placeholder="Search by customer, company, country, serial or order #"
              value={q}
              onChange={(e) => setFilter('q', e.target.value)}
            />
          </Can>
          <Can permission="orders.list.filter.stage">
            <select aria-label="Stage" className={inputClass} value={stage} onChange={(e) => setFilter('stage', e.target.value)}>
              <option value="open">Open orders</option>
              <option value="all">All stages</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {stageLabel(s)}
                </option>
              ))}
            </select>
          </Can>
          <Can permission="orders.list.filter.voltage">
            <select aria-label="Voltage" className={inputClass} value={voltage} onChange={(e) => setFilter('voltage', e.target.value)}>
              <option value="">Any voltage</option>
              {voltageChoices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Can>
          <Can permission="orders.list.filter.payment">
            <select aria-label="Payment" className={inputClass} value={payment} onChange={(e) => setFilter('payment', e.target.value)}>
              <option value="">Any payment status</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Can>
          <Can permission="orders.list.filter.checkboxes">
            <button type="button" className={`${secondaryButtonClass} whitespace-nowrap`} onClick={() => setMore(!more)} aria-expanded={more}>
              More Filters{stages.length + voltages.length + types.length ? ` (${stages.length + voltages.length + types.length})` : ''}
            </button>
          </Can>
          <Can permission="orders.list.filter.archived">
            <label className="flex items-center gap-2 text-sm whitespace-nowrap text-slate-600">
              <input type="checkbox" checked={showArchived} onChange={(e) => setFilter('archived', e.target.checked)} />
              Show archived
            </label>
          </Can>
        </div>
        {more && (
          <Can permission="orders.list.filter.checkboxes">
            <div className="mb-3 grid gap-3 rounded-md border border-slate-200 bg-white p-3 text-sm [grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr))]">
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
            </div>
          </Can>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-slate-300 bg-white">
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
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-6 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-6 text-center text-slate-500">
                    {orders.length === 0 ? 'No orders have been entered yet.' : 'No orders match these filters. Clear the filters to see all orders.'}
                  </td>
                </tr>
              )}
              {rows.map((o) => (
                <tr
                  key={o.id}
                  onClick={opensOrders ? () => navigate(`/orders/${o.id}`) : undefined}
                  className={`odd:bg-white even:bg-slate-50 ${opensOrders ? 'cursor-pointer hover:bg-blue-50' : ''} ${o.archived ? 'text-slate-400' : ''}`}
                >
                  {visibleColumns.map((c) => (
                    <Can key={c.key} permission={c.permission}>
                      <td className={`border-r border-b border-slate-200 px-2 py-1 whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                        {c.render ? c.render(o) : (c.value(o) ?? '')}
                      </td>
                    </Can>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
          <span>
            {rows.length} of {orders.length} order{orders.length === 1 ? '' : 's'}
            {filtersOn && (
              <Can anyOf={['orders.list.filter.search', 'orders.list.filter.stage', 'orders.list.filter.voltage', 'orders.list.filter.payment']}>
                <button
                  type="button"
                  className="ml-3 underline"
                  onClick={() => {
                    setParams(writeFilters({ ...defaultFilters, sort: filters.sort, dir: filters.dir, archived: filters.archived }), { replace: true })
                    setFilters((f) => ({ ...defaultFilters, sort: f.sort, dir: f.dir, archived: f.archived }))
                  }}
                >
                  Clear Filters
                </button>
              </Can>
            )}
          </span>
          <Can permission="orders.list.outstanding_total">
            <span>
              Outstanding:{' '}
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
