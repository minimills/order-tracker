// @permission-scope timesheets
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { narrowInputClass, secondaryButtonClass } from '../form'
import { addDaysISO, showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { loadWeekRows, showHours, useEmployees, usePayrollSettings, weekStartOf, type WeekRow } from '../../lib/timesheets'
import { useDepartments } from '../../lib/useDepartments'
import { useAuth } from '../../lib/auth'
import { usePermissions } from '../../lib/permissions'
import { confirmAction } from '../../lib/confirm'
import Can from '../Can'
import FillEveryoneDialog from './FillEveryoneDialog'
import { tr } from '../../i18n'

const th = 'px-2 py-1.5 text-left font-medium'
const td = 'px-2 py-1.5'

/** Every employee's hours for one pay week, with the approval status. */
export default function WeeksOverview() {
  const [params, setParams] = useSearchParams()
  const settings = usePayrollSettings()
  const ws = weekStartOf(params.get('week') || todayISO(), settings.week_start)
  const { employees } = useEmployees()
  const { departments } = useDepartments()
  const { session } = useAuth()
  const { can } = usePermissions()
  const me = session?.user.email?.toLowerCase()
  const [rows, setRows] = useState<WeekRow[]>([])
  const [dept, setDept] = useState(params.get('dept') ?? '')
  const [q, setQ] = useState('')
  const [version, setVersion] = useState(0)
  const [filling, setFilling] = useState(false)

  useEffect(() => {
    loadWeekRows(ws, ws)
      .then(setRows)
      .catch((e) => toast.error(friendlyError(e)))
  }, [ws, version])

  const byEmp = new Map(rows.map((r) => [r.employee_id, r]))
  const managed = new Set(departments.filter((d) => d.manager_email && d.manager_email === me).map((d) => d.id))
  const shown = employees.filter((e) => (!dept || e.department_id === dept) && (!q || e.name.toLowerCase().includes(q.toLowerCase())))
  const go = (d: string) => setParams({ ...Object.fromEntries(params), week: d }, { replace: true })
  const canApprove = (deptId: string | null) => can('timesheets.approve', 'edit') || (deptId != null && managed.has(deptId))
  const openRows = shown.map((e) => byEmp.get(e.id)).filter((r): r is WeekRow => !!r && r.status === 'open' && r.entries > 0 && !r.needs_review && canApprove(r.department_id) && r.user_email !== me)

  const closeFill = useCallback(() => setFilling(false), [])

  async function approveAll() {
    if (!supabase || !openRows.length) return
    if (!(await confirmAction(tr("Approve and lock {{length}} week{{value}} (week of {{showDate}})?", { length: openRows.length, value: openRows.length === 1 ? '' : 's', showDate: showDate(ws) }), { get confirmLabel() {
    return tr("Approve Weeks")
  } }))) return
    let failed = 0
    for (const r of openRows) {
      const { error } = await supabase.rpc('approve_timesheet_week', { p_employee: r.employee_id, p_week_start: ws, p_note: null })
      if (error) failed++
    }
    if (failed) toast.error(tr("{{failed}} week{{value}} could not be approved. Open them to see why.", { failed: failed, value: failed === 1 ? '' : 's' }))
    else toast.success(tr("Weeks approved and locked."))
    setVersion((v) => v + 1)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondaryButtonClass} onClick={() => go(addDaysISO(ws, -7))} aria-label={tr("Previous week")}>
          ←
        </button>
        <input type="date" aria-label={tr("Choose a week")} className={narrowInputClass} value={ws} onChange={(e) => e.target.value && go(e.target.value)} />
        <button type="button" className={secondaryButtonClass} onClick={() => go(addDaysISO(ws, 7))} aria-label={tr("Next week")}>
          →
        </button>
        <span className="text-sm text-slate-600">
          {tr("Week of")} {showDate(ws, 'EEE MMM d')} {tr("to")} {showDate(addDaysISO(ws, 6), 'EEE MMM d, yyyy')}
        </span>
        <select aria-label={tr("Department")} className={`${narrowInputClass} ml-auto`} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">{tr("All departments")}</option>
          {departments
            .filter((d) => !d.archived)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
        <input aria-label={tr("Search employees")} placeholder={tr("Search")} className={`${narrowInputClass} w-40`} value={q} onChange={(e) => setQ(e.target.value)} />
        <Can permission="timesheets.fill_all" level="edit">
          <button type="button" className={secondaryButtonClass} onClick={() => setFilling(true)}>
            {tr("Fill Weekday Hours for Everyone")}
          </button>
        </Can>
        {openRows.length > 0 && (
          <button type="button" className={secondaryButtonClass} onClick={approveAll}>
            {tr("Approve All (")}{openRows.length})
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className={th}>{tr("Employee")}</th>
              <th className={`${th} text-right`}>{tr("Worked")}</th>
              <th className={`${th} text-right`}>{tr("Banked used")}</th>
              <th className={`${th} text-right`}>{tr("Regular")}</th>
              <th className={`${th} text-right`}>{tr("Overtime")}</th>
              <th className={`${th} text-right`}>{tr("Vacation")}</th>
              <th className={`${th} text-right`}>{tr("Sick")}</th>
              <th className={`${th} text-right`}>{tr("Stat holiday")}</th>
              <th className={`${th} text-right`}>{tr("Banked")}</th>
              <th className={th}>{tr("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td className={`${td} text-slate-500`} colSpan={10}>
                  {tr("No employees. Add them in Admin → Users → Employee Setup.")}
                </td>
              </tr>
            )}
            {shown.map((e) => {
              const r = byEmp.get(e.id)
              return (
                <tr key={e.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className={td}>
                    <Link to={`/timesheets/employee/${e.id}?week=${ws}`} className="font-medium text-blue-700 underline">
                      {e.name}
                    </Link>
                    <span className="ml-1 text-xs text-slate-500">{e.pay_type === 'salaried' ? tr("Salaried") : tr("Hourly")}</span>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r?.worked ?? 0)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r?.banked_used ?? 0)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r?.regular ?? 0)}</td>
                  <td className={`${td} text-right tabular-nums ${r?.overtime ? 'font-semibold' : ''}`}>{showHours(r?.overtime ?? 0)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r?.vacation ?? 0)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r?.sick ?? 0)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r?.stat ?? 0)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours((r?.earned_regular ?? 0) + (r?.earned_overtime ?? 0))}</td>
                  <td className={td}>
                    {!r || r.entries === 0 ? (
                      <span className="text-slate-400">{tr("No hours")}</span>
                    ) : r.needs_review ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">{tr("Needs review")}</span>
                    ) : r.status === 'approved' ? (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-900">{tr("Approved")}</span>
                    ) : (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{tr("Not approved")}</span>
                    )}
                    {r?.ot_choice && r.over_by_banked > 0 && (
                      <span className="ml-1 text-xs text-slate-500">{r.ot_choice === 'regular' ? tr("Extra paid as regular") : tr("Extra paid as overtime")}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {tr("Overtime: hours over")} {showHours(settings.overtime_weekly_hours)} {tr("a week (hours worked + banked hours used). Banked: hours put in the bank this week (not paid now).")}
      </p>
      {filling && (
        <Can permission="timesheets.fill_all" level="edit">
          <FillEveryoneDialog
            weekStart={ws}
            onClose={closeFill}
            onDone={() => {
              setFilling(false)
              setVersion((v) => v + 1)
            }}
          />
        </Can>
      )}
    </div>
  )
}
