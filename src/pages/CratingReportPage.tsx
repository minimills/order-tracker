import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import UnitsSwitch from '../components/crating/UnitsSwitch'
import { inputClass, secondaryButtonClass } from '../components/form'
import { contentsLabel, type CrateRow } from '../lib/crates'
import { downloadCsv } from '../lib/csv'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { usePreferences } from '../lib/preferences'
import { supabase } from '../lib/supabase'
import {
  csvLength,
  csvWeight,
  lengthFromCm,
  lengthUnit,
  showDims,
  showNumber,
  showWeight,
  weightFromKg,
  weightUnit,
  type Units,
} from '../lib/units'

type Stat = { avg: number; min: number; max: number; n: number } | null

function stat(values: (number | null)[]): Stat {
  const v = values.filter((x): x is number => x !== null && x !== undefined).map(Number)
  if (v.length === 0) return null
  return { avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v), n: v.length }
}

type Measure = 'weight' | 'length' | 'width' | 'height' | 'sheets' | 'hours'

const MEASURES: { key: Measure; label: (u: Units) => string; value: (c: CrateRow) => number | null }[] = [
  { key: 'weight', label: (u) => `Weight (${weightUnit(u)})`, value: (c) => c.weight_kg },
  { key: 'length', label: (u) => `Length (${lengthUnit(u)})`, value: (c) => c.length_cm },
  { key: 'width', label: (u) => `Width (${lengthUnit(u)})`, value: (c) => c.width_cm },
  { key: 'height', label: (u) => `Height (${lengthUnit(u)})`, value: (c) => c.height_cm },
  { key: 'sheets', label: () => 'Plywood sheets', value: (c) => c.plywood_sheets },
  { key: 'hours', label: () => 'Hours to build', value: (c) => c.build_hours },
]

/** Converts a stored (metric) value of a measure to the person's units, rounded for showing. */
function inUnits(key: Measure, metric: number, units: Units) {
  if (key === 'weight') return weightFromKg(metric, units)
  if (key === 'length' || key === 'width' || key === 'height') return lengthFromCm(metric, units)
  return Math.round(metric * 10) / 10
}

type Group = { label: string; crates: CrateRow[]; stats: Record<Measure, Stat> }

export default function CratingReportPage() {
  const { units } = usePreferences()
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const typeId = params.get('type') ?? ''
  const setFilter = (key: string, value: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )

  const [crates, setCrates] = useState<CrateRow[]>([])
  const [types, setTypes] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    ;(async () => {
      const [c, t] = await Promise.all([
        fetchAll<CrateRow>(() => supabase!.from('crate_report').select('*').order('id')),
        supabase!.from('machine_types').select('id, name').order('name'),
      ])
      if (cancelled) return
      const e = c.error ?? t.error
      if (e) toast.error(friendlyError(e))
      setCrates(c.data)
      setTypes((t.data as { id: string; name: string }[]) ?? [])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Only offer machine types that have been crated at least once.
  const typeChoices = useMemo(() => {
    const used = new Set(crates.flatMap((c) => c.machine_type_ids))
    return types.filter((t) => used.has(t.id) || t.id === typeId)
  }, [crates, types, typeId])

  const rows = useMemo(
    () =>
      crates
        .filter((c) => (!from || c.crated_on >= from) && (!to || c.crated_on <= to))
        .filter((c) => !typeId || c.machine_type_ids.includes(typeId))
        .sort((a, b) => b.crated_on.localeCompare(a.crated_on) || b.created_at.localeCompare(a.created_at)),
    [crates, from, to, typeId],
  )

  // One group per kind of crate contents ("Carder - Large", "2 × Picker"…), so a
  // shared crate is counted once, under everything it holds together.
  const groups = useMemo(() => {
    const map = new Map<string, CrateRow[]>()
    for (const c of rows) {
      const label = contentsLabel(c.machine_types)
      map.set(label, [...(map.get(label) ?? []), c])
    }
    return [...map]
      .map(([label, list]): Group => ({
        label,
        crates: list,
        stats: Object.fromEntries(MEASURES.map((m) => [m.key, stat(list.map(m.value))])) as Record<Measure, Stat>,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [rows])

  const filtersOn = from || to || typeId

  function exportCrates() {
    const L = lengthUnit(units)
    const W = weightUnit(units)
    downloadCsv(
      `crates-${todayISO()}.csv`,
      [
        'Date crated', 'Order #', 'Customer', 'Company', 'Country', 'Contents', 'Serials',
        `Length (${L})`, `Width (${L})`, `Height (${L})`, `Weight (${W})`, 'Plywood sheets', 'Hours to build',
        'Crated by', 'Notes',
      ],
      rows.map((c) => [
        c.crated_on, c.order_code, c.customer_name, c.customer_company, c.customer_country,
        contentsLabel(c.machine_types), c.serials.join(' '),
        csvLength(c.length_cm, units), csvLength(c.width_cm, units), csvLength(c.height_cm, units),
        csvWeight(c.weight_kg, units), c.plywood_sheets, c.build_hours, c.crated_by, c.notes,
      ]),
    )
  }

  function exportSummary() {
    const header = ['Contents', 'Crates']
    for (const m of MEASURES) header.push(`${m.label(units)} average`, `${m.label(units)} min`, `${m.label(units)} max`)
    downloadCsv(
      `crating-summary-${todayISO()}.csv`,
      header,
      groups.map((g) => {
        const row: (string | number | null)[] = [g.label, g.crates.length]
        for (const m of MEASURES) {
          const s = g.stats[m.key]
          row.push(
            s ? inUnits(m.key, s.avg, units) : null,
            s ? inUnits(m.key, s.min, units) : null,
            s ? inUnits(m.key, s.max, units) : null,
          )
        }
        return row
      }),
    )
  }

  return (
    <Can permission="reports.crating">
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Crating report</h1>
          <p className="text-sm text-slate-600">
            What our crates weigh, measure and take to build, from every crate entered so far.
          </p>
        </div>
        <Can permission="crating.units">
          <UnitsSwitch />
        </Can>
      </div>

      <Can permission="reports.crating.filters">
      <div className="grid gap-2 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Crated from</span>
          <input type="date" className={inputClass} value={from} onChange={(e) => setFilter('from', e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">to</span>
          <input type="date" className={inputClass} value={to} onChange={(e) => setFilter('to', e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Machine type</span>
          <select className={inputClass} value={typeId} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">All machine types</option>
            {typeChoices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {filtersOn && (
          <button type="button" className="text-sm underline sm:pb-2" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>
      </Can>

      {loading ? (
        <p className="py-8 text-center text-slate-500">Loading…</p>
      ) : (
        <>
          {/* ---------- Per machine type ---------- */}
          <Can permission="reports.crating.by_type">
          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4">
              <div>
                <h2 className="font-semibold">By machine type</h2>
                <p className="text-xs text-slate-500">
                  Average, with the smallest – largest below. A crate holding several machines is counted once, under
                  everything it holds. “1 of 2” means only 1 of the 2 crates has that box filled in.
                </p>
              </div>
              <Can permission="reports.crating.export_summary">
                <button type="button" className={secondaryButtonClass} onClick={exportSummary} disabled={groups.length === 0}>
                  ⬇ Summary CSV
                </button>
              </Can>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Machine type</th>
                    <th className="px-3 py-2 text-right font-semibold">Crates</th>
                    {MEASURES.map((m) => (
                      <th key={m.key} className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                        {m.label(units)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {groups.length === 0 && (
                    <tr>
                      <td colSpan={MEASURES.length + 2} className="px-3 py-6 text-center text-slate-500">
                        {crates.length === 0
                          ? 'No crates entered yet. Tick “Crated?” on a machine of an order that is ready to ship.'
                          : 'No crates match these filters.'}
                      </td>
                    </tr>
                  )}
                  {groups.map((g) => (
                    <tr key={g.label} className="align-top">
                      <td className="px-3 py-2 font-medium">{g.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{g.crates.length}</td>
                      {MEASURES.map((m) => {
                        const s = g.stats[m.key]
                        const d = m.key === 'weight' && units === 'imperial' ? 0 : 1
                        return (
                          <td key={m.key} className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                            {s ? (
                              <>
                                <div className="font-medium">{showNumber(inUnits(m.key, s.avg, units), d)}</div>
                                <div className="text-xs text-slate-500">
                                  {showNumber(inUnits(m.key, s.min, units), d)} – {showNumber(inUnits(m.key, s.max, units), d)}
                                  {s.n < g.crates.length && <> · {s.n} of {g.crates.length}</>}
                                </div>
                              </>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          </Can>

          {/* ---------- Every crate ---------- */}
          <Can permission="reports.crating.every_crate">
          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4">
              <h2 className="font-semibold">
                Every crate <span className="font-normal text-slate-500">({rows.length})</span>
              </h2>
              <Can permission="reports.crating.export_csv">
                <button type="button" className={secondaryButtonClass} onClick={exportCrates} disabled={rows.length === 0}>
                  ⬇ Export CSV
                </button>
              </Can>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Date crated</th>
                    <th className="px-3 py-2 font-semibold">Order</th>
                    <th className="px-3 py-2 font-semibold">Contents</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Size (L × W × H)</th>
                    <th className="px-3 py-2 text-right font-semibold">Weight</th>
                    <th className="px-3 py-2 text-right font-semibold">Plywood</th>
                    <th className="px-3 py-2 text-right font-semibold">Hours</th>
                    <th className="px-3 py-2 font-semibold">Crated by</th>
                    <th className="px-3 py-2 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((c) => (
                    <tr key={c.id} className="align-top">
                      <td className="px-3 py-2 whitespace-nowrap">{showDate(c.crated_on)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Can permission="order.page" fallback={<span className="font-medium">{c.order_code}</span>}>
                          <Link to={`/orders/${c.order_id}`} className="font-medium text-blue-700 underline">
                            {c.order_code}
                          </Link>
                        </Can>
                        <div className="text-xs text-slate-500">{c.customer_name}</div>
                      </td>
                      <td className="px-3 py-2">
                        {contentsLabel(c.machine_types)}
                        {c.serials.length > 0 && <div className="font-mono text-xs text-slate-500">{c.serials.join(', ')}</div>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{showDims(c, units) ?? <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{showWeight(c.weight_kg, units)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{showNumber(c.plywood_sheets)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{showNumber(c.build_hours)}</td>
                      <td className="px-3 py-2">{c.crated_by ?? '—'}</td>
                      <td className="max-w-xs px-3 py-2 text-slate-600">{c.notes}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                        No crates to show.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          </Can>
        </>
      )}
    </div>
    </Can>
  )
}
