// @permission-scope dashboard.charts.print
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WidgetBody from '../components/dashboard/WidgetBody'
import { useCompany } from '../lib/company'
import { rangeText } from '../lib/dashboardCharts'
import { dashData } from '../lib/dashboardData'
import { showDate, todayISO } from '../lib/dates'
import { usePermissions } from '../lib/permissions'
import { PRINT_KEY } from '../lib/useChart'
import { widgetAllowed, widgetDef, widgetTitle, type Widget } from '../lib/widgets'

/** The chosen dashboard widgets as a report with the letterhead, for printing or "Save as PDF". Nothing is stored. */
export default function DashboardPrintPage() {
  const company = useCompany()
  const { can } = usePermissions()
  const data = useMemo(() => dashData(), [])
  const [report] = useState<{ title: string; widgets: Widget[] } | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(PRINT_KEY) ?? 'null')
    } catch {
      return null
    }
  })
  // Only widgets the person is allowed to see.
  const widgets = (report?.widgets ?? []).filter((w) => Array.isArray(report?.widgets) && widgetAllowed(widgetDef(w.key), can))
  const small = widgets.filter((w) => widgetDef(w.key)?.kind === 'kpi')
  const big = widgets.filter((w) => widgetDef(w.key)?.kind !== 'kpi')
  const sub = (w: Widget) => (widgetDef(w.key)?.range ? rangeText({ range: w.range ?? (widgetDef(w.key)?.kind === 'chart' ? '12m' : 'month'), from: w.from, to: w.to }) + (w.compare ? ', compared with last year' : '') : 'Now')

  return (
    <div className="keep-light mx-auto min-h-full max-w-5xl bg-white p-4 text-slate-900 sm:p-6 print:max-w-none print:p-0">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <Link to="/dashboard" className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
          ← Back to the Dashboard
        </Link>
        <button type="button" onClick={() => window.print()} disabled={widgets.length === 0} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          Print or Save as PDF
        </button>
      </div>
      {widgets.length === 0 ? (
        <p className="rounded-md bg-amber-50 p-4 text-amber-900">No widgets were chosen. Go back to the Dashboard and select Print.</p>
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
          <p className="mb-4 text-slate-600">
            Printed {showDate(todayISO())} at {data.loadedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax' })}
          </p>
          {small.length > 0 && (
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
              {small.map((w) => (
                <section key={w.id} className="break-inside-avoid rounded border border-slate-300 p-3">
                  <h2 className="text-xs font-semibold text-slate-600">{widgetTitle(w)}</h2>
                  <WidgetBody widget={w} data={data} print />
                </section>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 print:grid-cols-2">
            {big.map((w) => (
              <section key={w.id} className="break-inside-avoid rounded border border-slate-300 p-3">
                <h2 className="font-semibold">{widgetTitle(w)}</h2>
                {widgetDef(w.key)?.kind !== 'chart' && <p className="mb-2 text-xs text-slate-600">{sub(w)}</p>}
                <WidgetBody widget={w} data={data} print />
              </section>
            ))}
          </div>
        </article>
      )}
    </div>
  )
}
