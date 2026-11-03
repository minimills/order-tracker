import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { inputClass, secondaryButtonClass } from '../components/form'
import { countryFlag } from '../lib/country'
import { downloadCsv } from '../lib/csv'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { formatMoney, friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import { PAYMENT_STATUSES, STAGES, type OrderSummaryRow } from '../lib/types'
import { useOptionList } from '../lib/useOptionList'

type Value = string | number | null

type ColumnDef = {
  key: string
  label: string
  /** Used for sorting and the CSV file. */
  value: (o: OrderSummaryRow) => Value
  /** How the cell looks on screen (defaults to the value). */
  render?: (o: OrderSummaryRow) => ReactNode
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

const money = (n: number | null, o: OrderSummaryRow) => (n === null ? '' : formatMoney(n, o.currency).replace(/^[A-Z]{3}\s?/, ''))

const COLUMNS: ColumnDef[] = [
  {
    key: 'order',
    label: 'Order #',
    value: (o) => o.order_number * 1000 + (o.split_number ?? 0),
    render: (o) => <span className="font-medium">{o.order_code}</span>,
  },
  { key: 'stage', label: 'Stage', value: (o) => o.stage },
  { key: 'customer', label: 'Customer', value: (o) => o.customer_name },
  { key: 'company', label: 'Company', value: (o) => o.customer_company },
  {
    key: 'country',
    label: 'Country',
    value: (o) => o.customer_country,
    render: (o) => (
      <>
        {countryFlag(o.customer_country)} {o.customer_country}
      </>
    ),
  },
  { key: 'state', label: 'State / province', value: (o) => o.customer_state_province },
  { key: 'machines', label: 'Machines', value: (o) => o.machines_list },
  {
    key: 'serials',
    label: 'Serials',
    value: (o) => o.serials,
    render: (o) => <span className="font-mono text-xs">{o.serials}</span>,
  },
  {
    key: 'ready',
    label: 'Ready',
    value: (o) => (o.machines_count ? `${o.machines_ready_count}/${o.machines_count}` : ''),
    align: 'right',
  },
  { key: 'expected', label: 'Expected ship', value: (o) => o.expected_ship_date, render: (o) => showDate(o.expected_ship_date) },
  { key: 'actual', label: 'Actual ship', value: (o) => o.actual_ship_date, render: (o) => showDate(o.actual_ship_date) },
  {
    key: 'delay',
    label: 'Delay (days)',
    value: (o) => o.delay_days,
    align: 'right',
    render: (o) =>
      o.delay_days === null ? '' : (
        <span className={o.delay_days > 0 ? 'text-red-700' : o.delay_days < 0 ? 'text-green-700' : ''}>
          {o.delay_days > 0 ? `+${o.delay_days}` : o.delay_days}
        </span>
      ),
  },
  { key: 'voltage', label: 'Voltage', value: (o) => o.voltage },
  { key: 'delivery', label: 'Delivery equipment', value: (o) => o.delivery_equipment },
  { key: 'freight', label: 'Freight', value: (o) => o.freight_type },
  { key: 'currency', label: 'Cur.', value: (o) => o.currency },
  { key: 'total', label: 'Total', value: (o) => o.order_total, align: 'right', render: (o) => money(o.order_total, o) },
  {
    key: 'downpct',
    label: 'Down %',
    value: (o) => o.down_payment_percent,
    align: 'right',
    render: (o) => (o.down_payment_percent === null ? '' : `${o.down_payment_percent}%`),
  },
  { key: 'paid', label: 'Paid', value: (o) => o.total_paid, align: 'right', render: (o) => money(o.total_paid, o) },
  {
    key: 'outstanding',
    label: 'Outstanding',
    value: (o) => o.amount_outstanding,
    align: 'right',
    render: (o) => money(o.amount_outstanding, o),
  },
  { key: 'nextdue', label: 'Next payment due', value: (o) => o.next_due_date, render: (o) => showDate(o.next_due_date) },
  {
    key: 'payment',
    label: 'Payment',
    value: (o) => o.payment_status,
    render: (o) => (
      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${paymentTone[o.payment_status] ?? ''}`}>
        {o.payment_status}
      </span>
    ),
  },
  { key: 'downamount', label: 'Down payment', value: (o) => o.down_payment_amount, csvOnly: true },
  { key: 'orderdate', label: 'Order date', value: (o) => o.order_date, csvOnly: true },
  { key: 'notes', label: 'Notes', value: (o) => o.notes, csvOnly: true },
  { key: 'archived', label: 'Archived', value: (o) => (o.archived ? 'Yes' : ''), csvOnly: true },
]

const visibleColumns = COLUMNS.filter((c) => !c.csvOnly)

type Filters = {
  q: string
  stage: string
  voltage: string
  payment: string
  sort: string
  dir: 'asc' | 'desc'
  archived: boolean
}

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
  const [params, setParams] = useSearchParams()
  const [orders, setOrders] = useState<OrderSummaryRow[]>([])
  const [loading, setLoading] = useState(true)
  const voltageList = useOptionList('voltage')

  // Filters are copied to the address bar, so a refresh or a shared link keeps them.
  const [filters, setFilters] = useState<Filters>(() => readFilters(params))
  const { q, stage, voltage, payment, sort: sortKey, dir: sortDir, archived: showArchived } = filters
  useEffect(() => {
    setParams(writeFilters(filters), { replace: true })
  }, [filters, setParams])
  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }))

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    const { data, error } = await fetchAll<OrderSummaryRow>(() => {
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

  const voltageChoices = useMemo(
    () => [...new Set([...voltageList.options, ...orders.map((o) => o.voltage)])],
    [voltageList.options, orders],
  )

  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = orders.filter((o) => {
      if (stage === 'open' && (o.stage === 'Shipped' || o.stage === 'Cancelled')) return false
      if (stage !== 'open' && stage !== 'all' && o.stage !== stage) return false
      if (voltage && o.voltage !== voltage) return false
      if (payment && o.payment_status !== payment) return false
      if (words.length) {
        const text = [
          o.order_code,
          o.customer_name,
          o.customer_company,
          o.customer_country,
          o.customer_state_province,
          o.serials,
          o.machines_list,
        ]
          .join(' ')
          .toLowerCase()
        if (!words.every((w) => text.includes(w))) return false
      }
      return true
    })
    const column = COLUMNS.find((c) => c.key === sortKey) ?? COLUMNS[0]
    const sorted = [...filtered].sort((a, b) => {
      const r = compare(column.value(a), column.value(b))
      // Keep empty cells at the bottom in both directions.
      const aEmpty = column.value(a) === null || column.value(a) === ''
      const bEmpty = column.value(b) === null || column.value(b) === ''
      if (aEmpty || bEmpty) return r
      return sortDir === 'asc' ? r : -r
    })
    return sorted
  }, [orders, q, stage, voltage, payment, sortKey, sortDir])

  const outstandingByCurrency = useMemo(() => {
    const sums: Record<string, number> = {}
    for (const o of rows) sums[o.currency] = (sums[o.currency] ?? 0) + Number(o.amount_outstanding)
    return sums
  }, [rows])

  function sortBy(key: string) {
    setFilters((f) =>
      f.sort === key ? { ...f, dir: f.dir === 'asc' ? 'desc' : 'asc' } : { ...f, sort: key, dir: 'asc' },
    )
  }

  function exportCsv() {
    downloadCsv(
      `orders-${todayISO()}.csv`,
      COLUMNS.map((c) => c.label),
      rows.map((o) =>
        COLUMNS.map((c) => (c.key === 'order' ? o.order_code : c.value(o))),
      ),
    )
  }

  const filtersOn = q || stage !== 'open' || voltage || payment

  return (
    <div className="-m-4 flex h-[calc(100%+2rem)] flex-col p-4 md:-m-8 md:h-[calc(100%+4rem)] md:p-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Orders list</h1>
        <div className="flex gap-2">
          <button type="button" className={secondaryButtonClass} onClick={exportCsv} disabled={rows.length === 0}>
            ⬇ Export CSV
          </button>
          <Link
            to="/orders/new"
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            + New order
          </Link>
        </div>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <input
          type="search"
          aria-label="Search"
          className={inputClass}
          placeholder="Search customer, company, country, serial, order #"
          value={q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <select aria-label="Stage" className={inputClass} value={stage} onChange={(e) => setFilter('stage', e.target.value)}>
          <option value="open">Open orders</option>
          <option value="all">All stages</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select aria-label="Voltage" className={inputClass} value={voltage} onChange={(e) => setFilter('voltage', e.target.value)}>
          <option value="">Any voltage</option>
          {voltageChoices.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select aria-label="Payment" className={inputClass} value={payment} onChange={(e) => setFilter('payment', e.target.value)}>
          <option value="">Any payment status</option>
          {PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setFilter('archived', e.target.checked)} />
          Show archived
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-slate-300 bg-white">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-100">
            <tr>
              {visibleColumns.map((c) => (
                <th
                  key={c.key}
                  className={`border-r border-b border-slate-300 px-2 py-1.5 font-semibold whitespace-nowrap text-slate-700 ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                  aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 hover:underline">
                    {c.label}
                    <span className="text-xs text-slate-400">{sortKey === c.key ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
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
                  {orders.length === 0 ? 'No orders yet.' : 'No orders match these filters.'}
                </td>
              </tr>
            )}
            {rows.map((o) => (
              <tr
                key={o.id}
                onClick={() => navigate(`/orders/${o.id}`)}
                className={`cursor-pointer odd:bg-white even:bg-slate-50 hover:bg-blue-50 ${o.archived ? 'text-slate-400' : ''}`}
              >
                {visibleColumns.map((c) => (
                  <td
                    key={c.key}
                    className={`border-r border-b border-slate-200 px-2 py-1 whitespace-nowrap ${
                      c.align === 'right' ? 'text-right tabular-nums' : ''
                    }`}
                  >
                    {c.render ? c.render(o) : (c.value(o) ?? '')}
                  </td>
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
            <button
              type="button"
              className="ml-3 underline"
              onClick={() => setFilters((f) => ({ ...defaultFilters, sort: f.sort, dir: f.dir, archived: f.archived }))}
            >
              Clear filters
            </button>
          )}
        </span>
        <span>
          Outstanding:{' '}
          {Object.keys(outstandingByCurrency).length === 0
            ? '—'
            : Object.entries(outstandingByCurrency)
                .map(([cur, sum]) => formatMoney(sum, cur))
                .join(' · ')}
        </span>
      </div>
    </div>
  )
}
