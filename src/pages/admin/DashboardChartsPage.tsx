// @permission-scope admin.dashboard_charts
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, inputClass } from '../../components/form'
import { CHARTS, loadChartSettings, type ChartSettings, type Target } from '../../lib/dashboardCharts'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { HEALTH_DEFAULTS, HEALTH_DIRECTIONS, healthFor, healthValueText, healthWidgets, healthWords, type Health } from '../../lib/widgets'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

const GAUGES = CHARTS.filter((c) => c.types.includes('gauge_targets'))
const blank: Target = { good: 'low', green: 0, amber: 0, max: 100 }
const n = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? 0 : Number(v))

/** Admin → Dashboard Charts: green / amber / red targets for the gauges and the charts a new dashboard starts with. */
export default function DashboardChartsPage() {
  const [s, setS] = useState<ChartSettings | null>(null)
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    loadChartSettings().then((v) => {
      setS(v)
      setSaved(JSON.stringify(v))
    })
  }, [])
  if (!s) return <p className="text-sm text-slate-500">{tr("Loading…")}</p>

  const setHealth = (key: string, h: Health | null) => {
    const health = { ...s.health }
    if (h === null) delete health[key]
    else health[key] = h
    setS({ ...s, health })
  }
  const set = (key: string, patch: Partial<Target> | null) => {
    const targets = { ...s.targets }
    if (patch === null) delete targets[key]
    else targets[key] = { ...(targets[key] ?? blank), ...patch }
    setS({ ...s, targets })
  }
  async function save() {
    if (!supabase || !s) return
    for (const [k, t] of Object.entries(s.targets)) {
      const ok = t.good === 'low' ? t.green <= t.amber && t.amber <= t.max : t.green >= t.amber && t.green <= t.max
      if (!ok) return toast.error(tr("Check the limits of “{{value}}”: {{value2}}.", { value: CHARTS.find((c) => c.key === k)?.title ?? k, value2: t.good === 'low' ? tr("green must be below amber, and amber below the top of the scale") : tr("amber must be below green, and green below the top of the scale") }))
    }
    setBusy(true)
    const { error } = await supabase.rpc('set_dashboard_chart_settings', { p: s })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setSaved(JSON.stringify(s))
    toast.success(tr("Dashboard chart settings saved."))
  }

  return (
    <div className="space-y-4">
      <AdminPageHeader title={tr("Dashboard Charts")}>
        {tr("Good and bad colours of the dashboard numbers, and targets for the “Gauge With Targets” form of a chart: green is on target, amber is close to the limit, red is off target. Who sees which chart is set in Admin → Users → Permissions.")}
      </AdminPageHeader>

      <section className="rounded-lg border border-slate-200 bg-white" data-setting="dc-targets">
        <h2 className="border-b border-slate-200 p-4 text-base font-semibold">{tr("Gauge Targets")}</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-600">
              <tr>
                <th className="px-3 py-2 font-semibold">{tr("Chart (the number on the gauge)")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Targets")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Good is")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Green limit")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Amber limit")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Top of the scale")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {GAUGES.map((c) => {
                const t = s.targets[c.key]
                return (
                  <tr key={c.key}>
                    <td className="px-3 py-2">{c.title}</td>
                    <td className="px-3 py-2">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={!!t} onChange={(e) => set(c.key, e.target.checked ? {} : null)} aria-label={tr("Targets for {{title}}", { title: c.title })} />
                        {t ? tr("Enabled") : tr("Disabled")}
                      </label>
                    </td>
                    {t ? (
                      <>
                        <td className="px-3 py-2">
                          <select aria-label={tr("Good direction for {{title}}", { title: c.title })} className={`${inputClass} min-w-28`} value={t.good} onChange={(e) => set(c.key, { good: e.target.value as 'low' | 'high' })}>
                            <option value="low">{tr("Low")}</option>
                            <option value="high">{tr("High")}</option>
                          </select>
                        </td>
                        {(['green', 'amber', 'max'] as const).map((k) => (
                          <td key={k} className="px-3 py-2">
                            <input aria-label={tr("{{k}} for {{title}}", { k: k, title: c.title })} inputMode="decimal" className={`${inputClass} min-w-20`} value={t[k]} onChange={(e) => set(c.key, { [k]: n(e.target.value) })} />
                          </td>
                        ))}
                      </>
                    ) : (
                      <td colSpan={4} className="px-3 py-2 text-slate-500">
                        {tr("No targets: the gauge shows the number only.")}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 p-4 text-xs text-slate-500">
          {tr("Good is Low: green up to the green limit, amber up to the amber limit, red above it (for example days late). Good is High: green from the green limit, amber from the amber limit, red below it (for example % on time).")}
        </p>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white" data-setting="dc-health">
        <h2 className="border-b border-slate-200 p-4 text-base font-semibold">{tr("Good and Bad Colours")}</h2>
        <p className="px-4 pt-3 text-sm text-slate-600">
          {tr("Whether a higher number is better or worse for each widget, and the limits. A bad number shows the whole widget in red with “Needs attention”, a good number in green with “Good”; numbers between the limits keep the normal colour. This applies to every dashboard; a widget can have its own setting in its Widget Settings.")}
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-600">
              <tr>
                <th className="px-3 py-2 font-semibold">{tr("Widget (the number judged)")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Direction")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Green limit")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Red limit")}</th>
                <th className="px-3 py-2 font-semibold">{tr("Now")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {healthWidgets().map((w) => {
                const h = healthFor({ key: w.key }, s.health)
                const own = !!s.health[w.key]
                return (
                  <tr key={w.key}>
                    <td className="px-3 py-2">
                      {w.title}
                      <span className="block text-xs text-slate-500">{healthValueText(w.key)}</span>
                    </td>
                    <td className="px-3 py-2">
                      <select aria-label={tr("Direction for {{title}}", { title: w.title })} className={`${inputClass} min-w-44`} value={h.direction} onChange={(e) => setHealth(w.key, { ...h, direction: e.target.value as Health['direction'] })}>
                        {HEALTH_DIRECTIONS.map((d) => (
                          <option key={d.value} value={d.value}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    {(['good', 'bad'] as const).map((k) => (
                      <td key={k} className="px-3 py-2">
                        {h.direction !== 'none' && (
                          <label className="flex items-center gap-1 whitespace-nowrap text-xs text-slate-600">
                            {k === 'good' ? tr("Green") : tr("Red")} {(k === 'good') === (h.direction === 'low') ? tr("below") : tr("above")}
                            <input aria-label={tr("{{value}} limit for {{title}}", { value: k === 'good' ? tr("Green") : tr("Red"), title: w.title })} inputMode="decimal" className={`${inputClass} min-w-20`} value={h[k]} onChange={(e) => setHealth(w.key, { ...h, [k]: n(e.target.value) })} />
                          </label>
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {healthWords(h)}
                      {own && (
                        <button type="button" className="ml-2 underline" onClick={() => setHealth(w.key, null)}>
                          {HEALTH_DEFAULTS[w.key] ? tr("Use the Built-in Setting") : tr("Clear")}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 p-4 text-xs text-slate-500">
          {tr("Lower is better: green below the green limit, red above the red limit (for example average delay: green below 0, red above 0). Higher is better: green above the green limit, red below the red limit (for example % on time). When both apply, red wins.")}
        </p>
      </section>

      <section className="max-w-3xl rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="dc-defaults">
        <h2 className="text-base font-semibold">{tr("Charts a New Dashboard Starts With")}</h2>
        <p className="mb-2 text-slate-600">{tr("Shown to people who have not arranged their own charts yet (only the charts they are allowed to see).")}</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {CHARTS.map((c) => (
            <label key={c.key} className="flex items-center gap-2">
              <input type="checkbox" checked={s.defaults.includes(c.key)} onChange={(e) => setS({ ...s, defaults: e.target.checked ? [...s.defaults, c.key] : s.defaults.filter((x) => x !== c.key) })} />
              {c.title}
            </label>
          ))}
        </div>
      </section>

      <button type="button" className={buttonClass} onClick={save} disabled={busy || JSON.stringify(s) === saved}>
        {busy ? ACTION.saving : ACTION.save}
      </button>
    </div>
  )
}
