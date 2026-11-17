// @permission-scope dashboard.charts
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '../../lib/auth'
import {
  CHART_SETTINGS_DEFAULT,
  CHART_TYPES,
  CHARTS,
  chartData,
  chartDef,
  loadChartSettings,
  newChartId,
  RANGES,
  type ChartConfig,
  type ChartData,
  type ChartSettings,
  type ChartType,
  type RangeKey,
} from '../../lib/dashboardCharts'
import { todayISO } from '../../lib/dates'
import { PRINT_KEY, useChart } from '../../lib/useChart'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'
import ChartView from './ChartView'

const small = 'rounded border border-slate-300 bg-white px-1.5 py-1 text-xs'

function ChartCard({
  cfg,
  data,
  settings,
  edit,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  cfg: ChartConfig
  data: ChartData
  settings: ChartSettings
  edit: boolean
  first: boolean
  last: boolean
  onChange: (patch: Partial<ChartConfig>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const { result, failed, def } = useChart(cfg, data)
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    if (def?.boards) data.boards().then(setBoards)
  }, [def, data])
  if (!def) return null
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-4" data-chart={cfg.chart}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 font-semibold">{def.title}</h3>
        {edit && (
          <div className="flex items-center gap-1">
            <button type="button" className={small} disabled={first} aria-label={`Move ${def.title} earlier`} onClick={() => onMove(-1)}>
              ←
            </button>
            <button type="button" className={small} disabled={last} aria-label={`Move ${def.title} later`} onClick={() => onMove(1)}>
              →
            </button>
            <button type="button" className={small} aria-label={`Remove ${def.title}`} onClick={onRemove}>
              ✕
            </button>
          </div>
        )}
      </div>
      <div className="mt-2 mb-3 flex flex-wrap items-center gap-2">
        <Can permission="dashboard.charts.form">
          <select aria-label={`Form of ${def.title}`} className={small} value={cfg.type} onChange={(e) => onChange({ type: e.target.value as ChartType })}>
            {CHART_TYPES.filter((t) => def.types.includes(t.key)).map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Can>
        {!def.now && (
          <Can permission="dashboard.charts.dates" fallback={<span className="text-xs text-slate-500">{RANGES.find((r) => r.key === cfg.range)?.label}</span>}>
            <select aria-label={`Dates of ${def.title}`} className={small} value={cfg.range} onChange={(e) => onChange({ range: e.target.value as RangeKey })}>
              {RANGES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            {cfg.range === 'custom' && (
              <>
                <input type="date" aria-label="From" className={small} value={cfg.from ?? ''} max={cfg.to} onChange={(e) => onChange({ from: e.target.value })} />
                <input type="date" aria-label="To" className={small} value={cfg.to ?? ''} min={cfg.from} onChange={(e) => onChange({ to: e.target.value })} />
              </>
            )}
          </Can>
        )}
        {def.boards && (
          <details className="relative text-xs">
            <summary className={`${small} cursor-pointer list-none`}>Boards ({cfg.boards?.length ?? 0})</summary>
            <div className="absolute z-10 mt-1 max-h-64 w-64 overflow-auto rounded-md border border-slate-300 bg-white p-2 shadow-lg">
              {boards.length === 0 && <p className="text-slate-500">No boards you can open.</p>}
              {boards.map((b) => (
                <label key={b.id} className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={cfg.boards?.includes(b.id) ?? false}
                    onChange={(e) => onChange({ boards: e.target.checked ? [...(cfg.boards ?? []), b.id] : (cfg.boards ?? []).filter((x) => x !== b.id) })}
                  />
                  <span className="truncate">{b.name}</span>
                </label>
              ))}
            </div>
          </details>
        )}
      </div>
      {failed ? (
        <p className="py-8 text-center text-sm text-slate-500">This chart could not be loaded. Refresh the page to try again.</p>
      ) : !result ? (
        <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
      ) : (
        <ChartView title={def.title} type={cfg.type} result={result} target={settings.targets[cfg.chart]} />
      )}
    </section>
  )
}

/** Dashboard → My Charts: each person's own charts, with Add, remove, rearrange and Print Report. */
export default function DashboardCharts() {
  const { can } = usePermissions()
  const { session } = useAuth()
  const navigate = useNavigate()
  const me = session?.user.email?.toLowerCase() ?? ''
  const edit = can('dashboard.charts.customize', 'edit')
  const data = useMemo(() => chartData(), [])
  const [settings, setSettings] = useState<ChartSettings>(CHART_SETTINGS_DEFAULT)
  const [charts, setCharts] = useState<ChartConfig[] | null>(null)
  const [adding, setAdding] = useState('')
  const [printing, setPrinting] = useState(false)
  const allowed = useMemo(() => CHARTS.filter((c) => can(c.permission)), [can])

  useEffect(() => {
    if (!supabase || !me) return
    Promise.all([loadChartSettings(), supabase.from('user_preferences').select('dashboard').eq('user_email', me).maybeSingle()]).then(([s, p]) => {
      setSettings(s)
      const saved = p.data?.dashboard as ChartConfig[] | null | undefined
      setCharts(
        Array.isArray(saved)
          ? saved
          : s.defaults.filter((k) => chartDef(k)).map((k) => ({ id: newChartId() + k, chart: k, type: chartDef(k)!.defaultType, range: '12m' as RangeKey })),
      )
    })
  }, [me])

  async function save(next: ChartConfig[]) {
    setCharts(next)
    if (!edit || !supabase) return
    const { error } = await supabase.rpc('set_my_dashboard', { p: next })
    if (error) toast.error(friendlyError(error))
  }

  if (!charts) return null
  // Charts the person may no longer see stay saved but are not drawn.
  const shown = charts.filter((c) => allowed.some((a) => a.key === c.chart))
  const groups = [...new Set(allowed.map((c) => c.group))]

  return (
    <section className="space-y-3" aria-label="My charts">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">My Charts</h2>
          <p className="text-sm text-slate-600">
            {edit ? 'Choose the form and dates of each chart. Your charts are saved for you only.' : 'Charts chosen for your dashboard.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {edit && (
            <select
              aria-label="Add a chart"
              className={`${narrowInputClass} w-52`}
              value={adding}
              onChange={(e) => {
                const def = chartDef(e.target.value)
                setAdding('')
                if (def) save([...charts, { id: newChartId(), chart: def.key, type: def.defaultType, range: '12m' }])
              }}
            >
              <option value="">Add Chart…</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {allowed
                    .filter((c) => c.group === g)
                    .map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.title}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          )}
          <Can permission="dashboard.charts.print">
            <button type="button" className={secondaryButtonClass} onClick={() => setPrinting(true)} disabled={shown.length === 0}>
              Print Report
            </button>
          </Can>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          {allowed.length === 0 ? 'No charts are enabled for your account.' : edit ? 'No charts yet. Choose one under Add Chart.' : 'No charts have been chosen.'}
        </p>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))]">
          {shown.map((c, i) => (
            <ChartCard
              key={c.id}
              cfg={c}
              data={data}
              settings={settings}
              edit={edit}
              first={i === 0}
              last={i === shown.length - 1}
              onChange={(patch) => save(charts.map((x) => (x.id === c.id ? { ...x, ...patch } : x)))}
              onRemove={() => save(charts.filter((x) => x.id !== c.id))}
              onMove={(dir) => {
                const other = shown[i + dir]
                if (!other) return
                const a = charts.findIndex((x) => x.id === c.id)
                const b = charts.findIndex((x) => x.id === other.id)
                const next = [...charts]
                ;[next[a], next[b]] = [next[b], next[a]]
                save(next)
              }}
            />
          ))}
        </div>
      )}

      {printing && (
        <Can permission="dashboard.charts.print">
          <PrintDialog
            charts={shown}
            onClose={() => setPrinting(false)}
            onPrint={(picked, title) => {
              try {
                sessionStorage.setItem(PRINT_KEY, JSON.stringify({ title, charts: picked }))
              } catch {
                return toast.error('The report could not be prepared in this browser.')
              }
              navigate('/dashboard/print')
            }}
          />
        </Can>
      )}
    </section>
  )
}

function PrintDialog({ charts, onClose, onPrint }: { charts: ChartConfig[]; onClose: () => void; onPrint: (charts: ChartConfig[], title: string) => void }) {
  const [picked, setPicked] = useState<string[]>(charts.map((c) => c.id))
  const [title, setTitle] = useState('Dashboard Report')
  const [range, setRange] = useState<RangeKey | 'own'>('own')
  const [from, setFrom] = useState(`${todayISO().slice(0, 4)}-01-01`)
  const [to, setTo] = useState(todayISO())
  return (
    <Modal
      title="Print Report"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={picked.length === 0}
            onClick={() =>
              onPrint(
                charts.filter((c) => picked.includes(c.id)).map((c) => (range === 'own' || chartDef(c.chart)?.now ? c : { ...c, range, from, to })),
                title.trim() || 'Dashboard Report',
              )
            }
          >
            Open Report
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Title" htmlFor="pr-title" hint="For example Management Meeting, November.">
          <input id="pr-title" className={inputClass} maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Dates" htmlFor="pr-range">
          <select id="pr-range" className={inputClass} value={range} onChange={(e) => setRange(e.target.value as RangeKey | 'own')}>
            <option value="own">Each chart’s own dates</option>
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label} (every chart)
              </option>
            ))}
          </select>
        </Field>
        {range === 'custom' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="pr-from">
              <input id="pr-from" type="date" className={inputClass} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" htmlFor="pr-to">
              <input id="pr-to" type="date" className={inputClass} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        )}
        <fieldset>
          <legend className="mb-1 font-medium">Charts in the report</legend>
          <div className="mb-1 flex gap-3 text-xs">
            <button type="button" className="underline" onClick={() => setPicked(charts.map((c) => c.id))}>
              Select All
            </button>
            <button type="button" className="underline" onClick={() => setPicked([])}>
              Clear Selection
            </button>
          </div>
          {charts.map((c) => (
            <label key={c.id} className="flex items-center gap-2 py-0.5">
              <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
              {chartDef(c.chart)?.title} <span className="text-xs text-slate-500">({CHART_TYPES.find((t) => t.key === c.type)?.label})</span>
            </label>
          ))}
        </fieldset>
      </div>
    </Modal>
  )
}
