// @permission-scope admin.timesheets
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import Can from '../../components/Can'
import { buttonClass, secondaryButtonClass } from '../../components/form'
import EmployeeDialog from '../../components/timesheets/EmployeeDialog'
import TimesheetImport from '../../components/timesheets/TimesheetImport'
import { confirmAction } from '../../lib/confirm'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useEmployees, type Employee } from '../../lib/timesheets'
import { useDepartments } from '../../lib/useDepartments'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

/** Admin → Timesheets: the employees (with or without a login) and the import of the old timesheet sheets. */
export default function TimesheetsAdminPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'import' || params.get('find') === 'ts-import' ? 'import' : 'employees'
  const [showArchived, setShowArchived] = useState(false)
  const { employees, reload } = useEmployees(true)
  const { departments } = useDepartments()
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)
  const deptName = new Map(departments.map((d) => [d.id, d.name]))
  const shown = employees.filter((e) => showArchived || !e.archived)

  async function archive(e: Employee) {
    if (!supabase) return
    if (!e.archived && !(await confirmAction(tr("Archive {{name}}? Their hours stay in the reports; they leave the weekly list.", { name: e.name }), { confirmLabel: ACTION.archive }))) return
    const { error } = await supabase.rpc('save_employee', { p: { id: e.id, name: e.name, archived: !e.archived } })
    if (error) return toast.error(friendlyError(error))
    reload()
  }

  return (
    <div className="space-y-4">
      <AdminPageHeader title={tr("Timesheets")}>
        {tr("Employees and the import of the old timesheet sheets. People who sign in are set up from Admin → Users → Employee Setup; former staff and others without a login are added here.")}
      </AdminPageHeader>
      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label={tr("Timesheets admin")}>
        {(
          [
            ['employees', 'Employees'],
            ['import', 'Import'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setParams(k === 'employees' ? {} : { tab: k }, { replace: true })} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'employees' && (
        <section className="space-y-3 text-sm" data-setting="ts-employees">
          <div className="flex flex-wrap items-center gap-3">
            <Can permission="admin.employees" level="edit">
              <button type="button" className={buttonClass} onClick={() => setEditing('new')}>
                {tr("Add Employee Without a Login")}
              </button>
            </Can>
            <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              {ACTION.showArchived}
            </label>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[44rem]">
              <thead className="bg-slate-50 text-left text-xs text-slate-600">
                <tr>
                  <th className="px-2 py-1.5">{tr("Name")}</th>
                  <th className="px-2 py-1.5">{tr("Login")}</th>
                  <th className="px-2 py-1.5">{tr("Pay type")}</th>
                  <th className="px-2 py-1.5">{tr("Department")}</th>
                  <th className="px-2 py-1.5">{tr("Start date")}</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-3 text-slate-500">
                      {tr("No employees yet. Set people up from Admin → Users → Employee Setup.")}
                    </td>
                  </tr>
                )}
                {shown.map((e) => (
                  <tr key={e.id} className={`border-t border-slate-100 ${e.archived ? 'opacity-60' : ''}`}>
                    <td className="px-2 py-1.5 font-medium">{e.name}</td>
                    <td className="px-2 py-1.5 text-slate-600">{e.user_email ?? tr("No login")}</td>
                    <td className="px-2 py-1.5">{e.pay_type === 'hourly' ? tr("Hourly") : tr("Salaried")}</td>
                    <td className="px-2 py-1.5">{e.department_id ? deptName.get(e.department_id) : '—'}</td>
                    <td className="px-2 py-1.5">{showDate(e.start_date)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <Can permission="admin.employees" level="edit">
                        <button type="button" className="mr-3 text-blue-700 underline" onClick={() => setEditing(e)}>
                          {tr("Employee Setup")}
                        </button>
                        <button type="button" className={secondaryButtonClass} onClick={() => archive(e)}>
                          {e.archived ? ACTION.restore : ACTION.archive}
                        </button>
                      </Can>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'import' && <TimesheetImport employees={employees} reloadEmployees={reload} />}

      {editing && <EmployeeDialog employee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  )
}
