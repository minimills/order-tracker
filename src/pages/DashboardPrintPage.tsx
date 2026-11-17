// @permission-scope dashboard.charts.print
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ChartView from '../components/dashboard/ChartView'
import { useCompany } from '../lib/company'
import { CHART_SETTINGS_DEFAULT, chartData, loadChartSettings, rangeText, type ChartConfig, type ChartData, type ChartSettings } from '../lib/dashboardCharts'
import { showDate, todayISO } from '../lib/dates'
import { usePermissions } from '../lib/permissions'
import { PRINT_KEY, useChart } from '../lib/useChart'

function PrintChart({ cfg, data, settings }: { cfg: ChartConfig; data: ChartData; settings: ChartSettings }) {
  const { result, def } = useChart(cfg, data)
  if (!def) return null
  return (
    <section className="break-inside-avoid rounded border border-slate-300 p-3">
      <h2 className="font-semibold">{def.title}</h2>
      <p className="mb-2 text-xs text-slate-600">{def.now ? 'Now' : rangeText(cfg)}</p>
      {result ? <ChartView title={def.title} type={cfg.type} result={result} target={settings.targets[cfg.chart]} print /> : <p className="py-6 text-center text-sm text-slate-500">Loading…</p>}
    </section>
  )
}

/** The chosen dashboard charts as a report with the letterhead, for printing or "Save as PDF". Nothing is stored. */
export default function DashboardPrintPage() {
  const company = useCompany()
  const { can } = usePermissions()
  const data = useMemo(() => chartData(), [])
  const [settings, setSettings] = useState<ChartSettings>(CHART_SETTINGS_DEFAULT)
  const [report] = useState<{ title: string; charts: ChartConfig[] } | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(PRINT_KEY) ?? 'null')
    } catch {
      return null
    }
  })
  useEffect(() => {
    loadChartSettings().then(setSettings)
  }, [])
  // Only charts the person is allowed to see.
  const charts = (report?.charts ?? []).filter((c) => can(`dashboard.chart.${c.chart}`))

  return (
    <div className="keep-light mx-auto min-h-full max-w-5xl bg-white p-4 text-slate-900 sm:p-6 print:max-w-none print:p-0">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <Link to="/dashboard" className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
          ← Back to the Dashboard
        </Link>
        <button type="button" onClick={() => window.print()} disabled={charts.length === 0} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          Print or Save as PDF
        </button>
      </div>
      {charts.length === 0 ? (
        <p className="rounded-md bg-amber-50 p-4 text-amber-900">No charts were chosen. Go back to the Dashboard and click Print Report.</p>
      ) : (
        <article className="text-sm">
          <header className="flex items-start justify-between gap-6 border-b-2 border-slate-900 pb-3">
            <div>
              <div className="text-xl font-bold">{company.name}</div>
              {company.address && <div className="whitespace-pre-line text-slate-700">{company.address}</div>}
              <div className="text-slate-700">{[company.phone, company.email, company.website].filter(Boolean).join(' · ')}</div>
            </div>
            {company.logo && <img src={company.logo} alt="" className="max-h-16" />}
          </header>
          <h1 className="mt-4 text-2xl font-bold">{report?.title}</h1>
          <p className="mb-4 text-slate-600">Printed {showDate(todayISO())}</p>
          <div className="grid gap-3 sm:grid-cols-2 print:grid-cols-2">
            {charts.map((c) => (
              <PrintChart key={c.id} cfg={c} data={data} settings={settings} />
            ))}
          </div>
        </article>
      )}
    </div>
  )
}
