import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Can from '../components/Can'
import PrintButton from '../components/print/PrintButton'
import { countryFlag } from '../lib/country'
import { showDate } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { cad, STOCK_LABEL, type StockStatus } from '../lib/machines'
import { supabase } from '../lib/supabase'

type Reports = {
  costs_visible: boolean
  buybacks: { machine_id: string; date: string; model: string; serial: string | null; from: string | null; country: string | null; price_cad: number | null; reason: string | null; status: StockStatus | null }[]
  in_progress: { job_id: string; machine_id: string; model: string; serial: string | null; opened_at: string; days_open: number; stage: string | null; cost_so_far: number | null }[]
  by_type: { model: string; completed: number; avg_days: number | null; avg_hours: number | null; avg_cost: number | null }[]
  profit: { job_id: string; machine_id: string; model: string; serial: string | null; completed_at: string; status: StockStatus | null; total: number; sale: number | null; profit: number | null; margin_pct: number | null }[] | null
  by_owner: { owner: string; country: string | null; machines: number }[]
  by_country: { country: string; machines: number }[]
}

const th = 'px-2 py-1.5 text-left font-medium'
const td = 'px-2 py-1.5'
const num = `${td} text-right tabular-nums`

/* @layout-helper */
function Block({ title, empty, children, count }: { title: string; empty: string; count: number; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-label={title} data-print-section={title}>
      <h2 className="mb-2 font-semibold">{title}</h2>
      {count === 0 ? <p className="text-slate-500">{empty}</p> : <div className="overflow-x-auto">{children}</div>}
    </section>
  )
}

/** Reports → Machines: buy-backs, refurbishments, time and cost per type, profit, owners and countries. */
export default function MachineReportsPage() {
  const [r, setR] = useState<Reports | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    supabase?.rpc('machine_reports').then(({ data, error: e }) => (e ? setError(friendlyError(e)) : setR(data as Reports)))
  }, [])

  return (
    <Can permission="reports.machines">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold">Machine Reports</h1>
          <Can permission="reports.machines.print">
            <PrintButton title="Machine Reports" />
          </Can>
        </div>
        {error && <p className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}</p>}
        {!r && !error && <p className="text-sm text-slate-500">Loading…</p>}
        {r && (
          <>
            <Block title="Refurbishments in Progress" empty="No machine is being refurbished." count={r.in_progress.length}>
              <table className="w-full min-w-[36rem]">
                <thead className="text-xs text-slate-600">
                  <tr>
                    <th className={th}>Machine</th>
                    <th className={th}>Started</th>
                    <th className={`${th} text-right`}>Days</th>
                    <th className={th}>Stage</th>
                    {r.costs_visible && <th className={`${th} text-right`}>Cost so far</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.in_progress.map((j) => (
                    <tr key={j.job_id} className="border-t border-slate-100">
                      <td className={td}>
                        <Link to={`/machines/refurb/${j.job_id}`} className="underline">
                          {j.model} {j.serial}
                        </Link>
                      </td>
                      <td className={td}>{showDate(j.opened_at.slice(0, 10))}</td>
                      <td className={num}>{j.days_open}</td>
                      <td className={td}>{j.stage ?? '—'}</td>
                      {r.costs_visible && <td className={num}>{cad(j.cost_so_far)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Block>

            <Block title="Buy-backs" empty="No machines have been bought back." count={r.buybacks.length}>
              <table className="w-full min-w-[40rem]">
                <thead className="text-xs text-slate-600">
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>Machine</th>
                    <th className={th}>From</th>
                    {r.costs_visible && <th className={`${th} text-right`}>Price (CAD)</th>}
                    <th className={th}>Reason</th>
                    <th className={th}>Now</th>
                  </tr>
                </thead>
                <tbody>
                  {r.buybacks.map((b, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className={td}>{showDate(b.date)}</td>
                      <td className={td}>
                        <Link to={`/machines/${b.machine_id}`} className="underline">
                          {b.model} {b.serial}
                        </Link>
                      </td>
                      <td className={td}>
                        {b.from ?? '—'}
                        {b.country ? ` · ${b.country}` : ''}
                      </td>
                      {r.costs_visible && <td className={num}>{cad(b.price_cad)}</td>}
                      <td className={td}>{b.reason ?? ''}</td>
                      <td className={td}>{b.status ? STOCK_LABEL[b.status] : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Block>

            <Block title="Refurbishment Time and Cost per Machine Type" empty="No refurbishment has been completed yet." count={r.by_type.length}>
              <table className="w-full min-w-[32rem]">
                <thead className="text-xs text-slate-600">
                  <tr>
                    <th className={th}>Machine type</th>
                    <th className={`${th} text-right`}>Completed</th>
                    <th className={`${th} text-right`}>Average days</th>
                    <th className={`${th} text-right`}>Average labour hours</th>
                    {r.costs_visible && <th className={`${th} text-right`}>Average total cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.by_type.map((t) => (
                    <tr key={t.model} className="border-t border-slate-100">
                      <td className={td}>{t.model}</td>
                      <td className={num}>{t.completed}</td>
                      <td className={num}>{t.avg_days ?? '—'}</td>
                      <td className={num}>{t.avg_hours ?? '—'}</td>
                      {r.costs_visible && <td className={num}>{cad(t.avg_cost)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Block>

            {r.profit && (
              <Block title="Profit per Refurbished Machine" empty="No refurbishment has been completed yet." count={r.profit.length}>
                <table className="w-full min-w-[40rem]">
                  <thead className="text-xs text-slate-600">
                    <tr>
                      <th className={th}>Machine</th>
                      <th className={th}>Completed</th>
                      <th className={th}>Status</th>
                      <th className={`${th} text-right`}>Total cost</th>
                      <th className={`${th} text-right`}>Sale price</th>
                      <th className={`${th} text-right`}>Profit</th>
                      <th className={`${th} text-right`}>Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.profit.map((p) => (
                      <tr key={p.job_id} className="border-t border-slate-100">
                        <td className={td}>
                          <Link to={`/machines/refurb/${p.job_id}`} className="underline">
                            {p.model} {p.serial}
                          </Link>
                        </td>
                        <td className={td}>{showDate(p.completed_at.slice(0, 10))}</td>
                        <td className={td}>{p.status ? STOCK_LABEL[p.status] : '—'}</td>
                        <td className={num}>{cad(p.total)}</td>
                        <td className={num}>{p.sale != null ? cad(p.sale) : 'Not set'}</td>
                        <td className={`${num} ${p.profit != null && p.profit < 0 ? 'text-red-700' : 'text-green-700'}`}>{p.profit != null ? cad(p.profit) : '—'}</td>
                        <td className={num}>{p.margin_pct != null ? `${p.margin_pct}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Block>
            )}

            <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1">
                <Block title="Machines by Current Owner" empty="No machines yet." count={r.by_owner.length}>
                  <table className="w-full">
                    <thead className="text-xs text-slate-600">
                      <tr>
                        <th className={th}>Owner</th>
                        <th className={th}>Country</th>
                        <th className={`${th} text-right`}>Machines</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.by_owner.map((o, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className={td}>{o.owner}</td>
                          <td className={td}>{o.country ? `${countryFlag(o.country)} ${o.country}` : '—'}</td>
                          <td className={num}>{o.machines}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Block>
              </div>
              <div className="min-w-0 lg:w-80">
                <Block title="Machines by Country" empty="No machines yet." count={r.by_country.length}>
                  <table className="w-full">
                    <tbody>
                      {r.by_country.map((c) => (
                        <tr key={c.country} className="border-t border-slate-100">
                          <td className={td}>
                            {countryFlag(c.country)} {c.country}
                          </td>
                          <td className={num}>{c.machines}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Block>
              </div>
            </div>
          </>
        )}
      </div>
    </Can>
  )
}
