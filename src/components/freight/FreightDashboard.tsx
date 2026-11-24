import { currentLang, tr } from '../../i18n'
// @permission-scope freight.dashboard
import { addMonths, endOfMonth, format, parseISO, startOfMonth, startOfWeek } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { CrateRow } from '../../lib/crates'
import { addDaysISO, showDate, todayISO } from '../../lib/dates'
import { fetchAll } from '../../lib/fetchAll'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import { inputClass, narrowInputClass } from '../form'
import CompareChart, { type ComparePoint } from './CompareChart'

type Crate = Pick<CrateRow, 'id' | 'crated_on' | 'plywood_sheets' | 'build_hours'>
type Totals = { sheets: number; crates: number; hours: number }

const sum = (list: Crate[]): Totals => ({
  sheets: list.reduce((s, c) => s + Number(c.plywood_sheets ?? 0), 0),
  crates: list.length,
  hours: list.reduce((s, c) => s + Number(c.build_hours ?? 0), 0),
})
const show = (n: number) => (Math.round(n * 10) / 10).toLocaleString(currentLang())
const iso = (d: Date) => format(d, 'yyyy-MM-dd')

/** Freight dashboard: plywood, crates and crating hours now, and by month against the year before. */
export default function FreightDashboard() {
  const [params, setParams] = useSearchParams()
  const [crates, setCrates] = useState<Crate[]>([])
  const [loading, setLoading] = useState(true)
  const today = todayISO()
  const thisYear = Number(today.slice(0, 4))
  const mode = params.get('period') === 'range' ? 'range' : 'year'
  const year = Number(params.get('year')) || thisYear
  const from = params.get('dfrom') ?? `${thisYear}-01-01`
  const to = params.get('dto') ?? today
  const set = (patch: Record<string, string>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v)
          else next.delete(k)
        }
        return next
      },
      { replace: true },
    )

  useEffect(() => {
    if (!supabase) return
    fetchAll<Crate>(() => supabase!.from('crate_report').select('id, crated_on, plywood_sheets, build_hours').order('id')).then((r) => {
      if (r.error) toast.error(friendlyError(r.error))
      setCrates(r.data)
      setLoading(false)
    })
  }, [])

  const boxes = useMemo(() => {
    const week = iso(startOfWeek(parseISO(today), { weekStartsOn: 1 }))
    const month = today.slice(0, 8) + '01'
    const yearStart = today.slice(0, 5) + '01-01'
    const since = (d: string) => sum(crates.filter((c) => c.crated_on >= d && c.crated_on <= today))
    return [
      { get label() {
    return tr("Today")
  }, sub: showDate(today), t: since(today) },
      { get label() {
    return tr("This Week")
  }, sub: `since ${showDate(week, 'MMM d')}`, t: since(week) },
      { get label() {
    return tr("This Month")
  }, sub: format(parseISO(today), 'MMMM yyyy'), t: since(month) },
      { get label() {
    return tr("This Year")
  }, sub: String(thisYear), t: since(yearStart) },
    ]
  }, [crates, today, thisYear])

  const years = useMemo(() => {
    const set = new Set<number>([thisYear, thisYear - 1, year])
    for (const c of crates) set.add(Number(c.crated_on.slice(0, 4)))
    return [...set].sort((a, b) => b - a)
  }, [crates, thisYear, year])

  // The period on the charts: a whole year, or the chosen dates (at most 24 months).
  const [start, end] = mode === 'year' ? [`${year}-01-01`, `${year}-12-31`] : from <= to ? [from, to] : [to, from]
  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)
  const charts = useMemo(() => {
    if (!rangeOk) return null
    const points: Record<'sheets' | 'crates' | 'hours', ComparePoint[]> = { sheets: [], crates: [], hours: [] }
    let m = startOfMonth(parseISO(start))
    const last = startOfMonth(parseISO(end))
    for (let i = 0; m <= last && i < 24; i++, m = addMonths(m, 1)) {
      const a0 = iso(m) < start ? start : iso(m)
      const a1 = iso(endOfMonth(m)) > end ? end : iso(endOfMonth(m))
      const prev = addMonths(m, -12)
      // the same days one year earlier
      const b0 = iso(prev).slice(0, 8) + a0.slice(8)
      const b1 = a1 === iso(endOfMonth(m)) ? iso(endOfMonth(prev)) : iso(prev).slice(0, 8) + a1.slice(8)
      const a = sum(crates.filter((c) => c.crated_on >= a0 && c.crated_on <= a1))
      const b = sum(crates.filter((c) => c.crated_on >= b0 && c.crated_on <= b1))
      const base = { key: iso(m), label: format(m, 'MMM'), long: format(m, 'MMMM yyyy') }
      points.sheets.push({ ...base, a: a.sheets, b: b.sheets })
      points.crates.push({ ...base, a: a.crates, b: b.crates })
      points.hours.push({ ...base, a: a.hours, b: b.hours })
    }
    return points
  }, [crates, start, end, rangeOk])
  const period = rangeOk ? sum(crates.filter((c) => c.crated_on >= start && c.crated_on <= end)) : null
  const nameA = mode === 'year' ? String(year) : 'Chosen dates'
  const nameB = mode === 'year' ? String(year - 1) : 'One year earlier'

  if (loading) return <p className="py-8 text-center text-slate-500">{tr("Loading…")}</p>

  return (
    <div className="space-y-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
        {boxes.map((b) => (
          <section key={b.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold">{b.label}</h2>
            <p className="text-xs text-slate-500">{b.sub}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <dd className="text-xl font-semibold tabular-nums">{show(b.t.sheets)}</dd>
                <dt className="text-[0.6875rem] text-slate-600">{tr("Plywood sheets")}</dt>
              </div>
              <div>
                <dd className="text-xl font-semibold tabular-nums">{show(b.t.crates)}</dd>
                <dt className="text-[0.6875rem] text-slate-600">{tr("Crates made")}</dt>
              </div>
              <div>
                <dd className="text-xl font-semibold tabular-nums">{show(b.t.hours)}</dd>
                <dt className="text-[0.6875rem] text-slate-600">{tr("Crating hours")}</dt>
              </div>
            </dl>
          </section>
        ))}
      </div>

      <Can permission="freight.dashboard.filters">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{tr("Period")}</span>
            <select className={`${narrowInputClass} w-44`} value={mode} onChange={(e) => set({ period: e.target.value === 'range' ? 'range' : '' })}>
              <option value="year">{tr("A whole year")}</option>
              <option value="range">{tr("Custom dates")}</option>
            </select>
          </label>
          {mode === 'year' ? (
            <label className="text-sm">
              <span className="mb-1 block text-slate-600">{tr("Year")}</span>
              <select className={`${narrowInputClass} w-28`} value={year} onChange={(e) => set({ year: Number(e.target.value) === thisYear ? '' : e.target.value })}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">{tr("From")}</span>
                <input type="date" className={inputClass} value={from} max={to} onChange={(e) => set({ dfrom: e.target.value })} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">{tr("to")}</span>
                <input type="date" className={inputClass} value={to} min={from} max={addDaysISO(from, 730)} onChange={(e) => set({ dto: e.target.value })} />
              </label>
            </>
          )}
        </div>
      </Can>

      {period && (
        <p className="text-sm text-slate-700">
          {mode === 'year' ? tr("In {{year}}", { year: year }) : tr("{{showDate}} to {{showDate2}}", { showDate: showDate(start), showDate2: showDate(end) })}: <strong>{show(period.sheets)}</strong> {tr("plywood sheets,")}{' '}
          <strong>{show(period.crates)}</strong> {period.crates === 1 ? tr("crate") : tr("crates")} {tr("made,")} <strong>{show(period.hours)}</strong> {tr("crating hours.")}
        </p>
      )}

      {charts && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
          <CompareChart title={tr("Plywood Sheets Used")} points={charts.sheets} nameA={nameA} nameB={nameB} unit="sheets" />
          <CompareChart title={tr("Crates Made")} points={charts.crates} nameA={nameA} nameB={nameB} unit="crates" />
          <CompareChart title={tr("Crating Hours")} points={charts.hours} nameA={nameA} nameB={nameB} unit="hours" />
        </div>
      )}
      {crates.length === 0 && <p className="text-sm text-slate-500">{tr("No crates have been entered yet. Mark a machine as crated on an order that is ready to ship.")}</p>}
    </div>
  )
}
