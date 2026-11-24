// @permission-scope timesheets.labour_cost.print, payroll.pay
import { Link, useSearchParams } from 'react-router-dom'
import LabourCost from '../components/timesheets/LabourCost'
import { useCompany } from '../lib/company'
import { todayISO } from '../lib/dates'
import { tr } from '../i18n'

/** The labour cost report with the letterhead, for printing or "Save as PDF" (no sidebar). Nothing is stored. */
export default function LabourCostPrintPage() {
  const company = useCompany()
  const [params] = useSearchParams()
  return (
    <div className="keep-light mx-auto min-h-full max-w-6xl bg-white p-4 text-slate-900 sm:p-6 print:max-w-none print:p-0">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <Link to={`/timesheets?tab=labour&${params.toString()}`} className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
          {tr("← Back to Labour Cost")}
        </Link>
        <button type="button" onClick={() => window.print()} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
          {tr("Print or Save as PDF")}
        </button>
      </div>
      <header className="mb-4 flex items-start justify-between gap-4 border-b border-slate-300 pb-3">
        <div>
          <h1 className="text-xl font-semibold">{tr("Labour Cost")} {params.get('year') ?? todayISO().slice(0, 4)}</h1>
          <p className="text-sm text-slate-600">{tr("Confidential: pay information.")}</p>
        </div>
        <div className="text-right text-sm">
          {company.logo && <img src={company.logo} alt="" className="ml-auto h-12" />}
          <p className="font-semibold">{company.name}</p>
          <p className="whitespace-pre-line text-slate-600">{company.address}</p>
        </div>
      </header>
      <LabourCost print />
    </div>
  )
}
