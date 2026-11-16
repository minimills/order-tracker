// @permission-scope freight.dashboard
import { useState } from 'react'

export type ComparePoint = {
  key: string
  /** "Mar" */
  label: string
  /** "March 2026" */
  long: string
  /** this period */
  a: number
  /** the same month one year earlier */
  b: number
}

// Two series, checked for colour-blind safety (blue / amber) on light and dark cards.
const A = '#2a78d6'
const B = '#c9772a'
const HEIGHT = 140

const show = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-CA')

/**
 * Columns by month: the chosen period next to the same months one year earlier.
 * Hover or tab to a month for the numbers; "Show as Table" lists them.
 */
export default function CompareChart({ title, points, nameA, nameB, unit }: { title: string; points: ComparePoint[]; nameA: string; nameB: string; unit: string }) {
  const [active, setActive] = useState<string | null>(null)
  const [table, setTable] = useState(false)
  const max = Math.max(1, ...points.flatMap((p) => [p.a, p.b]))
  const totalA = points.reduce((s, p) => s + p.a, 0)
  const totalB = points.reduce((s, p) => s + p.b, 0)
  const hit = points.find((p) => p.key === active)

  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-slate-600">
            {nameA}: <strong>{show(totalA)}</strong> {unit} · {nameB}: <strong>{show(totalB)}</strong> {unit}
          </p>
        </div>
        <button type="button" className="text-xs underline" aria-pressed={table} onClick={() => setTable(!table)}>
          {table ? 'Show as Chart' : 'Show as Table'}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: A }} /> {nameA}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: B }} /> {nameB}
        </span>
      </div>

      {table ? (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs text-slate-600">
              <tr>
                <th className="py-1 pr-3 font-semibold">Month</th>
                <th className="py-1 pr-3 text-right font-semibold">{nameA}</th>
                <th className="py-1 text-right font-semibold">{nameB}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {points.map((p) => (
                <tr key={p.key}>
                  <td className="py-1 pr-3">{p.long}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{show(p.a)}</td>
                  <td className="py-1 text-right tabular-nums">{show(p.b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-3" role="img" aria-label={`${title} by month: ${nameA} compared with ${nameB}`}>
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between text-[10px] text-slate-400">
            <span>{show(max)}</span>
          </div>
          <div className="flex items-end gap-1 border-b border-slate-300 pt-4" style={{ height: HEIGHT + 16 }}>
            {points.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-label={`${p.long}: ${nameA} ${show(p.a)} ${unit}, ${nameB} ${show(p.b)} ${unit}`}
                className={`flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 rounded-t ${active === p.key ? 'bg-slate-100' : ''}`}
                onMouseEnter={() => setActive(p.key)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(p.key)}
                onBlur={() => setActive(null)}
              >
                <span className="w-2/5 max-w-4 rounded-t-sm" style={{ height: Math.max((p.a / max) * HEIGHT, p.a ? 2 : 0), background: A }} />
                <span className="w-2/5 max-w-4 rounded-t-sm" style={{ height: Math.max((p.b / max) * HEIGHT, p.b ? 2 : 0), background: B }} />
              </button>
            ))}
          </div>
          <div className="flex gap-1 text-center text-[10px] text-slate-500">
            {points.map((p) => (
              <span key={p.key} className="min-w-0 flex-1 truncate">
                {p.label}
              </span>
            ))}
          </div>
          <p className="mt-1 h-4 text-xs text-slate-700" aria-live="polite">
            {hit ? `${hit.long}: ${nameA} ${show(hit.a)} ${unit} · ${nameB} ${show(hit.b)} ${unit}` : 'Point at a month for its numbers.'}
          </p>
        </div>
      )}
    </section>
  )
}
