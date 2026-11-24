// @permission-scope freight.profit
/* Shown only inside <Can permission="freight.profit"> (which needs freight.breakdowns); the rows come from freight_breakdowns, read with the person's own permissions. */
import { addYears, endOfQuarter, format, parseISO, startOfMonth, startOfQuarter, startOfWeek, startOfYear } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { showDate, todayISO } from '../../lib/dates'
import { fetchAll } from '../../lib/fetchAll'
import { formatMoney, friendlyError } from '../../lib/format'
import type { Breakdown } from '../../lib/freight'
import { supabase } from '../../lib/supabase'
import { inputClass } from '../form'
import { tr } from '../../i18n'

type Group = 'day' | 'week' | 'month' | 'quarter' | 'year'
const GROUPS: { key: Group; label: string }[] = [
  { key: 'day', get label() {
    return tr("Day")
  } },
  { key: 'week', get label() {
    return tr("Week")
  } },
  { key: 'month', get label() {
    return tr("Month")
  } },
  { key: 'quarter', get label() {
    return tr("Quarter")
  } },
  { key: 'year', get label() {
    return tr("Year")
  } },
]
type Row = Pick<Breakdown, 'id' | 'ship_date' | 'invoice_total' | 'invoice_total_cad' | 'breakdown_total_cad' | 'customer_name' | 'invoice_number'>
type Totals = { shipments: number; invoiced: number; cost: number; profit: number; losses: number }

const cad = (n: number) => formatMoney(n, 'CAD')
const iso = (d: Date) => format(d, 'yyyy-MM-dd')
const shift = (d: string, years: number) => iso(addYears(parseISO(d), years))

/** The start of the period a date falls in (weeks start on Monday). */
function bucketOf(d: string, g: Group) {
  const x = parseISO(d)
  if (g === 'day') return d
  if (g === 'week') return iso(startOfWeek(x, { weekStartsOn: 1 }))
  if (g === 'month') return iso(startOfMonth(x))
  if (g === 'quarter') return iso(startOfQuarter(x))
  return iso(startOfYear(x))
}
function bucketLabel(start: string, g: Group, long = false) {
  const x = parseISO(start)
  if (g === 'day') return format(x, long ? 'EEE MMM d, yyyy' : 'MMM d')
  if (g === 'week') return `${long ? tr("Week of ") : ''}${format(x, long ? 'MMM d, yyyy' : 'MMM d')}`
  if (g === 'month') return format(x, long ? 'MMMM yyyy' : 'MMM yy')
  if (g === 'quarter') return `Q${Math.floor(x.getMonth() / 3) + 1} ${format(x, 'yyyy')}${long ? ` (${format(x, 'MMM d')} to ${format(endOfQuarter(x), 'MMM d')})` : ''}`
  return format(x, 'yyyy')
}
function totals(rows: Row[]): Totals {
  const t: Totals = { shipments: 0, invoiced: 0, cost: 0, profit: 0, losses: 0 }
  for (const r of rows) {
    const p = Number(r.invoice_total_cad) - Number(r.breakdown_total_cad)
    t.shipments += 1
    t.invoiced += Number(r.invoice_total_cad)
    t.cost += Number(r.breakdown_total_cad)
    t.profit += p
    if (p < 0) t.losses += 1
  }
  return t
}
const pct = (t: Totals) => (t.invoiced ? `${((t.profit / t.invoiced) * 100).toFixed(1)} %` : '—')
const tone = (n: number) => (n > 0.005 ? 'text-green-800' : n < -0.005 ? 'text-red-700' : 'text-slate-700')
const words = (n: number) => (n > 0.005 ? 'Profit' : n < -0.005 ? 'Loss' : 'Break-even')

/**
 * Profit and loss from the cost breakdowns: what the customer was invoiced for
 * freight against what the shipment cost (both in CAD), by ship date, grouped
 * by day, week, month, quarter or year, optionally next to the same dates one
 * year earlier.
 */
export default function ProfitLoss() {
  const [params, setParams] = useSearchParams()
  const today = todayISO()
  const group = (GROUPS.find((g) => g.key === params.get('pgroup'))?.key ?? 'month') as Group
  const from = params.get('pfrom') || `${today.slice(0, 4)}-01-01`
  const to = params.get('pto') || today
  const compare = params.get('pcompare') === '1'
  const [rows, setRows] = useState<Row[] | null>(null)
  const [table, setTable] = useState(false)
  const [active, setActive] = useState<string | null>(null)

  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v) n.set(k, v)
        else n.delete(k)
        return n
      },
      { replace: true },
    )

  useEffect(() => {
    if (!supabase) return
    fetchAll<Row>(() =>
      supabase!.from('freight_breakdowns').select('id, ship_date, invoice_total, invoice_total_cad, breakdown_total_cad, customer_name, invoice_number').eq('archived', false).order('id'),
    ).then((r) => {
      if (r.error) toast.error(friendlyError(r.error))
      setRows(r.data)
    })
  }, [])

  const data = useMemo(() => {
    const all = rows ?? []
    const counted = all.filter((r) => r.ship_date && Number(r.invoice_total) > 0)
    const now = counted.filter((r) => r.ship_date! >= from && r.ship_date! <= to)
    const lyFrom = shift(from, -1)
    const lyTo = shift(to, -1)
    const before = counted.filter((r) => r.ship_date! >= lyFrom && r.ship_date! <= lyTo)
    // Periods of the chosen dates; last year's rows fall into the period one year later.
    const keys: string[] = []
    const byKey = new Map<string, { now: Row[]; before: Row[] }>()
    const add = (k: string) => {
      if (!byKey.has(k)) {
        byKey.set(k, { now: [], before: [] })
        keys.push(k)
      }
      return byKey.get(k)!
    }
    for (const r of now) add(bucketOf(r.ship_date!, group)).now.push(r)
    if (compare) for (const r of before) add(bucketOf(shift(r.ship_date!, 1), group)).before.push(r)
    keys.sort()
    return {
      now: totals(now),
      before: totals(before),
      missing: all.filter((r) => r.ship_date && r.ship_date >= from && r.ship_date <= to && !(Number(r.invoice_total) > 0)).length,
      noDate: all.filter((r) => !r.ship_date).length,
      buckets: keys.map((k) => ({ key: k, now: totals(byKey.get(k)!.now), before: totals(byKey.get(k)!.before) })),
    }
  }, [rows, from, to, group, compare])

  if (!rows) return <p className="text-sm text-slate-500">{tr("Loading…")}</p>
  const max = Math.max(1, ...data.buckets.flatMap((b) => [Math.abs(b.now.profit), compare ? Math.abs(b.before.profit) : 0]))
  const HALF = 90
  const bar = (v: number, colour: string, label: string) => (
    <div className="flex h-full w-3 flex-col sm:w-4" aria-hidden="true" title={label}>
      <div className="flex flex-1 items-end">{v > 0 && <div className="w-full rounded-t-sm" style={{ height: `${(v / max) * 100}%`, background: colour }} />}</div>
      <div className="flex flex-1 items-start">{v < 0 && <div className="w-full rounded-b-sm" style={{ height: `${(-v / max) * 100}%`, background: colour }} />}</div>
    </div>
  )
  const card = (title: string, value: string, extra?: React.ReactNode, cls = '') => (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">{title}</p>
      <p className={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</p>
      {extra && <p className="mt-0.5 text-xs text-slate-500">{extra}</p>}
    </div>
  )
  const change = (a: number, b: number) => (compare ? tr("Same dates last year: {{cad}}{{value}}", { cad: cad(b), value: b ? ` (${a >= b ? '+' : ''}${cad(a - b)})` : '' }) : undefined)
  const shown = active ? data.buckets.find((b) => b.key === active) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">{tr("Group by")}</span>
          <select className={`${inputClass} w-32`} value={group} onChange={(e) => set('pgroup', e.target.value === 'month' ? '' : e.target.value)}>
            {GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">{tr("Ship date from")}</span>
          <input type="date" className={`${inputClass} w-40`} value={from} onChange={(e) => set('pfrom', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">{tr("To")}</span>
          <input type="date" className={`${inputClass} w-40`} value={to} min={from} onChange={(e) => set('pto', e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" checked={compare} onChange={(e) => set('pcompare', e.target.checked ? '1' : '')} />
          {tr("Compare with the same dates last year")}
        </label>
      </div>

      <section aria-label={tr("Profit and loss summary")} data-print-section="Summary" className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr))]">
        {card(words(data.now.profit), cad(data.now.profit), change(data.now.profit, data.before.profit), tone(data.now.profit))}
        {card('Invoiced for freight', cad(data.now.invoiced), change(data.now.invoiced, data.before.invoiced))}
        {card('Breakdown cost', cad(data.now.cost), change(data.now.cost, data.before.cost))}
        {card('Margin', pct(data.now), compare ? `Same dates last year: ${pct(data.before)}` : 'Profit as a share of the amount invoiced', tone(data.now.profit))}
        {card('Shipments', String(data.now.shipments), `${data.now.losses} at a loss${compare ? ` · last year ${data.before.shipments} (${data.before.losses} at a loss)` : ''}`)}
      </section>
      <p className="text-xs text-slate-500">
        {tr("In CAD, from cost breakdowns with a ship date in these dates and an invoice amount. Profit = invoice amount − breakdown cost.")}
        {data.missing > 0 && tr(" {{count}} breakdown has no invoice amount and is left out.", { count: data.missing })}
        {data.noDate > 0 && tr(" {{count}} breakdown without a ship date is left out.", { count: data.noDate })}
      </p>

      <section aria-label={tr("Profit and loss by period")} data-print-section="Chart" className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{tr("Profit and Loss by")} {GROUPS.find((g) => g.key === group)!.label}</h3>
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded-sm bg-[#1baf7a]" aria-hidden="true" /> {tr("Profit")}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded-sm bg-[#e0453a]" aria-hidden="true" /> {tr("Loss")}
            </span>
            {compare && (
              <span className="flex items-center gap-1">
                <span className="h-3 w-3 rounded-sm bg-[#9aa5b4]" aria-hidden="true" /> {tr("Last year")}
              </span>
            )}
            <button type="button" className="underline" onClick={() => setTable(!table)}>
              {table ? tr("Show as Chart") : tr("Show as Table")}
            </button>
          </div>
        </div>
        {data.buckets.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">{tr("No shipments with an invoice amount in these dates.")}</p>
        ) : table ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-slate-600">
                <tr>
                  <th className="py-1 pr-3 font-semibold">{tr("Period")}</th>
                  <th className="py-1 pr-3 text-right font-semibold">{tr("Shipments")}</th>
                  <th className="py-1 pr-3 text-right font-semibold">{tr("Invoiced")}</th>
                  <th className="py-1 pr-3 text-right font-semibold">{tr("Cost")}</th>
                  <th className="py-1 pr-3 text-right font-semibold">{tr("Profit / loss")}</th>
                  {compare && <th className="py-1 text-right font-semibold">{tr("Last year")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {data.buckets.map((b) => (
                  <tr key={b.key}>
                    <td className="py-1 pr-3">{bucketLabel(b.key, group, true)}</td>
                    <td className="py-1 pr-3 text-right">{b.now.shipments}</td>
                    <td className="py-1 pr-3 text-right">{cad(b.now.invoiced)}</td>
                    <td className="py-1 pr-3 text-right">{cad(b.now.cost)}</td>
                    <td className={`py-1 pr-3 text-right font-medium ${tone(b.now.profit)}`}>{cad(b.now.profit)}</td>
                    {compare && <td className={`py-1 text-right ${tone(b.before.profit)}`}>{b.before.shipments ? cad(b.before.profit) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <div className="flex min-w-full items-stretch gap-1 border-b border-slate-100 pb-1" style={{ height: HALF * 2 + 24 }}>
                {data.buckets.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    className={`flex min-w-8 flex-1 flex-col items-center rounded px-0.5 ${active === b.key ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                    aria-label={`${bucketLabel(b.key, group, true)}: ${words(b.now.profit)} ${cad(b.now.profit)}${compare ? tr(", last year {{cad}}", { cad: cad(b.before.profit) }) : ''}`}
                    onMouseEnter={() => setActive(b.key)}
                    onFocus={() => setActive(b.key)}
                    onClick={() => setActive(b.key)}
                  >
                    <div className="relative flex w-full flex-1 justify-center gap-0.5">
                      <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-slate-300" aria-hidden="true" />
                      {bar(b.now.profit, b.now.profit < 0 ? '#e0453a' : '#1baf7a', cad(b.now.profit))}
                      {compare && bar(b.before.profit, '#9aa5b4', cad(b.before.profit))}
                    </div>
                    <span className="mt-1 text-[0.625rem] whitespace-nowrap text-slate-500">{bucketLabel(b.key, group)}</span>
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-2 min-h-5 text-sm" aria-live="polite">
              {shown
                ? tr("{{bucketLabel}}: {{words}} {{cad}} on {{shipments}} (invoiced {{cad2}}, cost {{cad3}}){{value2}}", { bucketLabel: bucketLabel(shown.key, group, true), words: words(shown.now.profit), cad: cad(shown.now.profit), shipments: tr("{{count}} shipment", { count: shown.now.shipments }), cad2: cad(shown.now.invoiced), cad3: cad(shown.now.cost), value2: compare ? tr(" · last year {{cad}}", { cad: cad(shown.before.profit) }) : '' })
                : tr("Point at a {{group}} for its numbers. {{showDate}} to {{showDate2}}.", { group: group, showDate: showDate(from), showDate2: showDate(to) })}
            </p>
          </>
        )}
      </section>
    </div>
  )
}
