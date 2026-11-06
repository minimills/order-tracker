// @permission-scope dashboard.chart.delay_by_month
import { useState } from 'react'

export type MonthDelay = {
  /** for example "2026-03" */
  month: string
  /** "Mar" */
  label: string
  /** Full name for the tooltip and table, for example "March 2026" */
  longLabel: string
  /** Average delay in days (negative = early); null when nothing shipped. */
  average: number | null
  orders: number
}

// Diverging pair (checked for colour-blind safety): red = late, blue = early.
const LATE = '#e0563a'
const EARLY = '#2a78d6'
const HEIGHT = 160 // px for the bars area

function fmt(n: number) {
  const r = Math.round(n * 10) / 10
  return r > 0 ? `+${r}` : String(r)
}

/**
 * Average delay per month as columns that grow up (late) or down (early)
 * from a zero line. Hover or tab to a column for details; "Show as Table"
 * lists the numbers.
 */
export default function DelayChart({ months }: { months: MonthDelay[] }) {
  const [active, setActive] = useState<string | null>(null)
  const values = months.map((m) => m.average).filter((v): v is number => v !== null)
  const maxLate = Math.max(0, ...values)
  const maxEarly = Math.max(0, ...values.map((v) => -v))
  const span = maxLate + maxEarly || 1
  // Room above the zero line for late bars, below for early bars (+ space for labels).
  const upper = values.length ? (HEIGHT * maxLate) / span : HEIGHT / 2
  const lower = HEIGHT - upper

  if (values.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">No orders shipped in the last 12 months have both an expected and an actual ship date.</p>
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: LATE }} /> Late (days after the
          expected date)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: EARLY }} /> Early
        </span>
      </div>

      <div className="relative pt-5 pb-5" role="img" aria-label="Average delay in days by month, last 12 months">
        {/* zero line */}
        <div className="absolute right-0 left-0 border-t border-slate-300" style={{ top: 20 + upper }} />
        <span className="absolute -left-0.5 bg-white pr-1 text-[10px] text-slate-400" style={{ top: 13 + upper }}>
          0
        </span>
        <div className="relative flex" style={{ height: HEIGHT }}>
          {months.map((m) => {
            const v = m.average
            const h = v === null ? 0 : Math.max(2, (Math.abs(v) / span) * HEIGHT)
            const isActive = active === m.month
            return (
              <button
                key={m.month}
                type="button"
                className="group relative flex-1 focus:outline-none"
                onMouseEnter={() => setActive(m.month)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(m.month)}
                onBlur={() => setActive(null)}
                aria-label={`${m.longLabel}: ${v === null ? 'nothing shipped' : `${fmt(v)} days on average, ${m.orders} order${m.orders === 1 ? '' : 's'}`}`}
              >
                {isActive && <span className="absolute inset-x-0 -top-5 -bottom-5 rounded bg-slate-100" />}
                {v !== null && (
                  <>
                    <span
                      className="absolute left-1/2 w-[min(24px,70%)] -translate-x-1/2"
                      style={
                        v >= 0
                          ? { bottom: lower, height: h, background: LATE, borderRadius: '4px 4px 0 0' }
                          : { top: upper, height: h, background: EARLY, borderRadius: '0 0 4px 4px' }
                      }
                    />
                    <span
                      className="absolute inset-x-0 text-center text-[10px] font-medium text-slate-700 tabular-nums sm:text-xs"
                      style={v >= 0 ? { bottom: lower + h + 1 } : { top: upper + h + 1 }}
                    >
                      {fmt(v)}
                    </span>
                  </>
                )}
                {isActive && (
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-6 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs whitespace-nowrap text-white shadow">
                    {m.longLabel}:{' '}
                    {v === null ? 'nothing shipped' : `${fmt(v)} days avg · ${m.orders} order${m.orders === 1 ? '' : 's'}`}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
      {/* month labels */}
      <div className="flex">
        {months.map((m) => (
          <span key={m.month} className="flex-1 text-center text-[10px] text-slate-500 sm:text-xs">
            {m.label}
          </span>
        ))}
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-600">Show as Table</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="py-1 font-normal">Month</th>
              <th className="py-1 text-right font-normal">Orders shipped</th>
              <th className="py-1 text-right font-normal">Average delay (days)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums">
            {months.map((m) => (
              <tr key={m.month}>
                <td className="py-1">{m.longLabel}</td>
                <td className="py-1 text-right">{m.orders}</td>
                <td className="py-1 text-right">{m.average === null ? '—' : fmt(m.average)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}
