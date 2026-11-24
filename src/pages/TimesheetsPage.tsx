import { Link, useSearchParams } from 'react-router-dom'
import Can from '../components/Can'
import { secondaryButtonClass } from '../components/form'
import AbsenceCalendar from '../components/timesheets/AbsenceCalendar'
import LabourCost from '../components/timesheets/LabourCost'
import TimesheetReports from '../components/timesheets/TimesheetReports'
import WeeksOverview from '../components/timesheets/WeeksOverview'
import { usePermissions } from '../lib/permissions'
import { TIMESHEET_KEYS } from '../lib/permissions/catalog'
import PrintButton from '../components/print/PrintButton'
import { tr } from '../i18n'

const TABS = [
  { key: 'weeks', get label() {
    return tr("Weekly Hours")
  }, permission: 'timesheets' },
  { key: 'absences', get label() {
    return tr("Absence Calendar")
  }, permission: 'timesheets.absences' },
  { key: 'reports', get label() {
    return tr("Reports")
  }, permission: 'timesheets.reports' },
  { key: 'labour', get label() {
    return tr("Labour Cost")
  }, permission: 'timesheets.labour_cost' },
] as const

/** Timesheets: weekly hours of every employee, the absence calendar, reports and labour cost (each tab has its own permission). */
export default function TimesheetsPage() {
  const [params, setParams] = useSearchParams()
  const { can } = usePermissions()
  const allowed = TABS.filter((t) => can(t.permission) && (t.key !== 'labour' || can('payroll.pay')))
  const tab = allowed.find((t) => t.key === params.get('tab'))?.key ?? allowed[0]?.key

  return (
    <Can anyOf={TIMESHEET_KEYS}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold">{tr("Timesheets")}</h1>
              <Can permission="timesheets.print">
                <PrintButton title={tr("Timesheets")} />
              </Can>
            </div>
            <p className="text-sm text-slate-600">{tr("Hours, overtime, banked hours, time off and payroll reports.")}</p>
          </div>
          <Can permission="timesheets.time_off">
            <Link to="/time-off" className={secondaryButtonClass}>
              {tr("Time Off Requests")}
            </Link>
          </Can>
        </div>
        {allowed.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist" aria-label={tr("Timesheets")}>
            {allowed.map((t) => (
              <Can key={t.key} permission={t.permission}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${tab === t.key ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}
                  onClick={() => setParams(t.key === allowed[0].key ? {} : { tab: t.key }, { replace: true })}
                >
                  {t.label}
                </button>
              </Can>
            ))}
          </div>
        )}
        {tab === 'weeks' && (
          <Can permission="timesheets">
            <WeeksOverview />
          </Can>
        )}
        {tab === 'absences' && (
          <Can permission="timesheets.absences">
            <AbsenceCalendar />
          </Can>
        )}
        {tab === 'reports' && (
          <Can permission="timesheets.reports">
            <TimesheetReports />
          </Can>
        )}
        {tab === 'labour' && (
          <Can permission="timesheets.labour_cost">
            <Can permission="payroll.pay">
              <LabourCost />
            </Can>
          </Can>
        )}
      </div>
    </Can>
  )
}
