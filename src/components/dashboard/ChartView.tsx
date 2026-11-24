// @permission-scope dashboard.charts
import { useState } from 'react'
import { showNumber, targetState, type ChartPoint, type ChartResult, type ChartType, type Target } from '../../lib/dashboardCharts'
import { tr } from '../../i18n'

// Colours checked for colour-blind safety (the palette of the other charts).
const BLUE = '#2a78d6'
const SLICES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const STATUS = { good: '#0ca30c', watch: '#fab219', off: '#d03b3b' }
const STATUS_WORD = { good: 'On target', watch: 'Close to the limit', off: 'Off target' }
const W = 600
const H = 210

const text = (p: ChartPoint, unit: string) => `${p.long ?? p.label}: ${showNumber(p.value)} ${unit}`

/** At most 7 slices; the rest becomes "Other". */
function slices(points: ChartPoint[]) {
  const pos = points.filter((p) => p.value > 0)
  if (pos.length <= 8) return pos
  const sorted = [...pos].sort((a, b) => b.value - a.value)
  return [...sorted.slice(0, 7), { get label() {
    return tr("Other")
  }, value: sorted.slice(7).reduce((s, p) => s + p.value, 0) }]
}

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}
function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = polar(cx, cy, r, from)
  const [x1, y1] = polar(cx, cy, r, to)
  return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`
}

/**
 * One chart in any of the six forms. Hover or tab to a mark for its number;
 * "Show as Table" lists every number. `print` draws it without buttons and
 * with the numbers underneath.
 */
export default function ChartView({ title, type, result, target, print = false, color = BLUE }: { title: string; type: ChartType; result: ChartResult; target?: Target; print?: boolean; color?: string }) {
  const [active, setActive] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const { points, unit, headline } = result
  const isGauge = type === 'gauge' || type === 'gauge_targets'

  // One big number (the chart's headline, or the total).
  if (type === 'number') {
    const v = headline?.value ?? points.reduce((sum, p) => sum + p.value, 0)
    const state = target && headline ? targetState(v, target) : null
    return (
      <div className="flex h-full flex-col justify-center py-2">
        <p className="text-4xl font-semibold tabular-nums" style={{ color: state ? STATUS[state] : undefined }}>
          {showNumber(v)}
        </p>
        <p className="text-sm text-slate-600">{headline?.label ?? unit}</p>
        {state && <p className="text-xs font-semibold">{STATUS_WORD[state]}</p>}
        {result.note && <p className="mt-1 text-xs text-slate-500">{result.note}</p>}
      </div>
    )
  }

  if (!isGauge && points.length === 0) return <p className="py-8 text-center text-sm text-slate-500">{result.note && !headline ? result.note : tr("Nothing to show for these dates.")}</p>
  if (isGauge && !headline) return <p className="py-8 text-center text-sm text-slate-500">{tr("This chart has no single number for a gauge. Choose another form.")}</p>

  const hover = (i: number) => ({
    onMouseEnter: () => setActive(i),
    onMouseLeave: () => setActive(null),
    onFocus: () => setActive(i),
    onBlur: () => setActive(null),
    tabIndex: print ? undefined : 0,
  })

  const values = points.map((p) => p.value)
  const hi = Math.max(0, ...values)
  const lo = Math.min(0, ...values)
  const span = hi - lo || 1
  const padL = 8
  const padT = 18
  const plotH = H - padT - 26
  const y = (v: number) => padT + ((hi - v) / span) * plotH
  const band = (W - padL * 2) / Math.max(points.length, 1)
  const everyLabel = points.length <= 14 ? 1 : Math.ceil(points.length / 12)
  const numbers = points.length <= 12

  let body: React.ReactNode = null

  if (type === 'column' || type === 'line') {
    body = (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-slate-600" role="img" aria-label={`${title}: ${points.map((p) => text(p, unit)).join('; ')}`}>
        <line x1={padL} x2={W - padL} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity="0.4" />
        {type === 'line' && points.length > 1 && (
          <polyline fill="none" stroke={color} strokeWidth="2" points={points.map((p, i) => `${padL + band * (i + 0.5)},${y(p.value)}`).join(' ')} />
        )}
        {points.map((p, i) => {
          const cx = padL + band * (i + 0.5)
          const bw = Math.min(band * 0.62, 46)
          const top = Math.min(y(p.value), y(0))
          const h = Math.max(Math.abs(y(p.value) - y(0)), p.value ? 2 : 0)
          return (
            <g key={i} {...hover(i)} className="outline-none">
              {/* a wider invisible target than the mark */}
              <rect x={cx - band / 2} y={0} width={band} height={H - 22} fill="transparent" />
              {type === 'column' ? (
                <rect x={cx - bw / 2} y={top} width={bw} height={h} rx="3" fill={color} opacity={active === null || active === i ? 1 : 0.55} />
              ) : (
                <circle cx={cx} cy={y(p.value)} r={active === i ? 6 : 4} fill={color} stroke="white" strokeWidth="2" />
              )}
              {numbers && (
                <text x={cx} y={(p.value >= 0 ? top : top + h + 12) - (p.value >= 0 ? (type === 'line' ? 9 : 4) : 0)} textAnchor="middle" fontSize="11" fill="currentColor">
                  {showNumber(p.value)}
                </text>
              )}
              {i % everyLabel === 0 && (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" fill="currentColor">
                  {p.label.length > Math.max(4, Math.floor(band / 6)) ? `${p.label.slice(0, Math.max(3, Math.floor(band / 6) - 1))}…` : p.label}
                </text>
              )}
              <title>{text(p, unit)}</title>
            </g>
          )
        })}
      </svg>
    )
  } else if (type === 'bar') {
    const max = Math.max(...values.map(Math.abs), 1)
    body = (
      <ul className="space-y-1.5" aria-label={title}>
        {points.map((p, i) => (
          <li key={i} {...hover(i)} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs outline-none" title={text(p, unit)}>
            <span className="truncate text-slate-700">{p.label}</span>
            <span className="h-4 rounded-sm bg-slate-100">
              <span className="block h-4 rounded-sm" style={{ width: `${Math.max((Math.abs(p.value) / max) * 100, p.value ? 1.5 : 0)}%`, background: color, opacity: p.value < 0 ? 0.55 : active === null || active === i ? 1 : 0.6 }} />
            </span>
            <span className="w-14 text-right text-slate-700 tabular-nums">{showNumber(p.value)}</span>
          </li>
        ))}
      </ul>
    )
  } else if (type === 'pie') {
    const parts = slices(points)
    const total = parts.reduce((s, p) => s + p.value, 0)
    if (!total) return <p className="py-8 text-center text-sm text-slate-500">{tr("Nothing to show for these dates.")}</p>
    // Where each slice starts and ends, in degrees.
    const ends = parts.map((_, i) => (parts.slice(0, i + 1).reduce((a, x) => a + x.value, 0) / total) * 360)
    body = (
      <div className="flex flex-wrap items-center gap-4">
        <svg viewBox="0 0 200 200" className="h-44 w-44 shrink-0" role="img" aria-label={`${title}: ${parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}`}>
          {parts.map((p, i) => {
            const from = i === 0 ? 0 : ends[i - 1]
            const at = ends[i]
            const full = parts.length === 1
            const [x0, y0] = polar(100, 100, 92, from)
            const [x1, y1] = polar(100, 100, 92, at)
            return full ? (
              <circle key={i} cx="100" cy="100" r="92" fill={SLICES[i]} {...hover(i)} />
            ) : (
              <path key={i} d={`M 100 100 L ${x0} ${y0} A 92 92 0 ${at - from > 180 ? 1 : 0} 1 ${x1} ${y1} Z`} fill={SLICES[i % SLICES.length]} stroke="white" strokeWidth="2" opacity={active === null || active === i ? 1 : 0.6} {...hover(i)} className="outline-none">
                <title>{text(p, unit)}</title>
              </path>
            )
          })}
        </svg>
        <ul className="min-w-0 flex-1 space-y-1 text-xs">
          {parts.map((p, i) => (
            <li key={i} className={`flex items-center gap-2 ${active === i ? 'font-semibold' : ''}`}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SLICES[i % SLICES.length] }} />
              <span className="min-w-0 flex-1 truncate text-slate-700">{p.label}</span>
              <span className="text-slate-700 tabular-nums">
                {showNumber(p.value)} · {Math.round((p.value / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  } else if (headline) {
    const withTargets = type === 'gauge_targets' && !!target
    const v = headline.value
    const max = target?.max ?? (headline.label.startsWith('%') ? 100 : Math.max(10, Math.ceil((Math.abs(v) * 1.5) / 10) * 10))
    const min = Math.min(0, v)
    const pos = (n: number) => -90 + (Math.max(min, Math.min(max, n)) - min) / (max - min || 1) * 180
    const state = target ? targetState(v, target) : null
    // The three zones in the order they sit on the scale.
    const zones = target
      ? target.good === 'low'
        ? ([[min, target.green, 'good'], [target.green, target.amber, 'watch'], [target.amber, max, 'off']] as const)
        : ([[min, target.amber, 'off'], [target.amber, target.green, 'watch'], [target.green, max, 'good']] as const)
      : []
    const [nx, ny] = polar(120, 120, 78, pos(v))
    body = (
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 240 140" className="w-full max-w-xs text-slate-700" role="img" aria-label={`${title}: ${showNumber(v)} ${headline.label}${withTargets && state ? `, ${STATUS_WORD[state]}` : ''}`}>
          {withTargets ? (
            zones.map(([a, b, s]) => b > a && <path key={s} d={arc(120, 120, 100, pos(a), pos(b))} fill="none" stroke={STATUS[s]} strokeWidth="16" />)
          ) : (
            <>
              <path d={arc(120, 120, 100, -90, 90)} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="16" />
              {pos(v) > -90 && <path d={arc(120, 120, 100, -90, pos(v))} fill="none" stroke={color} strokeWidth="16" />}
            </>
          )}
          {withTargets && (
            <>
              <line x1="120" y1="120" x2={nx} y2={ny} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              <circle cx="120" cy="120" r="5" fill="currentColor" />
            </>
          )}
          <text x="20" y="136" textAnchor="middle" fontSize="10" fill="currentColor">{showNumber(min)}</text>
          <text x="220" y="136" textAnchor="middle" fontSize="10" fill="currentColor">{showNumber(max)}</text>
          <text x="120" y={withTargets ? 96 : 112} textAnchor="middle" fontSize="30" fontWeight="600" fill="currentColor">{showNumber(v)}</text>
        </svg>
        <p className="text-center text-xs text-slate-600">{headline.label}</p>
        {withTargets && state && target && (
          <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
            <span className="h-3 w-3 rounded-full" style={{ background: STATUS[state] }} aria-hidden="true" />
            {STATUS_WORD[state]}
            <span className="font-normal text-slate-600">
              {tr("(green")} {target.good === 'low' ? tr("up to") : tr("from")} {showNumber(target.green)}{tr(", amber")} {target.good === 'low' ? tr("up to") : tr("from")} {showNumber(target.amber)})
            </span>
          </p>
        )}
        {type === 'gauge_targets' && !target && <p className="mt-1 text-xs text-slate-500">{tr("No targets are set for this chart yet (Admin → Dashboard Charts).")}</p>}
      </div>
    )
  }

  const list = (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <tbody className="divide-y divide-slate-100">
          {points.map((p, i) => (
            <tr key={i}>
              <td className="py-1 pr-3">{p.long ?? p.label}</td>
              <td className="py-1 text-right tabular-nums">
                {showNumber(p.value)} {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div>
      {!print && points.length > 0 && type !== 'table' && (
        <div className="mb-1 flex justify-end">
          <button type="button" className="text-xs underline" aria-pressed={table} onClick={() => setTable(!table)}>
            {table ? tr("Show as Chart") : tr("Show as Table")}
          </button>
        </div>
      )}
      {(table && !print) || type === 'table' ? list : body}
      {!print && !table && !isGauge && (
        <p className="mt-1 min-h-4 text-xs text-slate-700" aria-live="polite">
          {active !== null && points[active] ? text(type === 'pie' ? slices(points)[active] ?? points[active] : points[active], unit) : headline ? `${showNumber(headline.value)} ${headline.label}` : ''}
        </p>
      )}
      {print && !isGauge && headline && (
        <p className="mt-1 text-xs text-slate-700">
          {showNumber(headline.value)} {headline.label}
        </p>
      )}
      {result.note && <p className="mt-1 text-xs text-slate-500">{result.note}</p>}
      {print && points.length > 0 && points.length <= 16 && type !== 'bar' && type !== 'pie' && <div className="mt-2">{list}</div>}
    </div>
  )
}
