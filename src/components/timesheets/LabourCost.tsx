// @permission-scope timesheets.labour_cost, payroll.pay
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import ChartView from '../dashboard/ChartView'
import CompareChart, { type ComparePoint } from '../freight/CompareChart'
import { narrowInputClass, secondaryButtonClass } from '../form'
import { downloadCsv } from '../../lib/csv'
import { showDate, todayISO } from '../../lib/dates'
import { formatMoney, friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { showHours, usePayrollSettings } from '../../lib/timesheets'
import { useDepartments } from '../../lib/useDepartments'
import PrintButton from '../print/PrintButton'

type CostRow = {
  employee_id: string
  employee_name: string
  department_id: string | null
  department_name: string | null
  week_start: string
  pay_type: string
  hourly_rate: number | null
  annual_salary: number | null
  rate_assumed: boolean
  no_rate: boolean
  worked: number
  paid_regular: number
  paid_overtime: number
  vacation: number
  sick: number
  stat: number
  banked_used: number
  imported: boolean
  cost_regular: number
  cost_overtime: number
  cost_vacation: number
  cost_sick: number
  cost_stat: number
  cost_salary: number
  cost_employer: number
  cost_total: number
}
const MONEY = ['cost_regular', 'cost_overtime', 'cost_vacation', 'cost_sick', 'cost_stat', 'cost_salary', 'cost_employer', 'cost_total'] as const
const HOURS = ['worked', 'paid_regular', 'paid_overtime', 'vacation', 'sick', 'stat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const th = 'px-2 py-1.5 text-left font-medium'
const td = 'px-2 py-1.5'
const cad = (n: number) => formatMoney(n, 'CAD')

type Sum = { name: string; dept: string; payType: string; rate: string; weeks: Set<string>; hpd: number; costHours: number } & Record<(typeof MONEY)[number] | (typeof HOURS)[number], number>
const empty = (name: string, dept: string, payType = '', rate = '', hpd = 8): Sum =>
  Object.assign({ name, dept, payType, rate, weeks: new Set<string>(), hpd, costHours: 0 }, Object.fromEntries([...MONEY, ...HOURS].map((k) => [k, 0]))) as unknown as Sum
function add(s: Sum, r: CostRow, hpd: number) {
  for (const k of [...MONEY, ...HOURS]) s[k] += Number(r[k]) || 0
  s.weeks.add(r.week_start)
  // the hours the cost is spread over: paid hours, or a full week for a salaried employee without hours entered
  const paid = Number(r.paid_regular) + Number(r.paid_overtime) + Number(r.vacation) + Number(r.sick) + Number(r.stat)
  s.costHours += paid > 0 ? paid : Number(r.cost_salary) > 0 ? hpd * 5 : 0
}
/** Cost per hour / day / week / month / year from a period's totals. */
function per(s: Sum) {
  const weeks = s.weeks.size || 1
  const hour = s.costHours > 0 ? s.cost_total / s.costHours : 0
  const week = s.cost_total / weeks
  return { hour, day: hour * s.hpd, week, month: (week * 52) / 12, year: week * 52 }
}

/** Labour cost (only with "View pay and labour cost"): per employee, department and company; years compared; charts; print. */
export default function LabourCost({ print = false }: { print?: boolean }) {
  const [params, setParams] = useSearchParams()
  const thisYear = Number(todayISO().slice(0, 4))
  const year = Number(params.get('year')) || thisYear
  const compare = params.get('compare') === 'none' ? null : Number(params.get('compare')) || year - 1
  const dept = params.get('dept') ?? ''
  const settings = usePayrollSettings()
  const { departments } = useDepartments()
  const [rows, setRows] = useState<CostRow[]>([])
  const [loading, setLoading] = useState(true)
  const set = (k: string, v: string) => {
    const p = Object.fromEntries(params)
    if (v) p[k] = v
    else delete p[k]
    setParams(p, { replace: true })
  }

  useEffect(() => {
    if (!supabase) return
    const from = `${Math.min(year, compare ?? year)}-01-01`
    const to = `${Math.max(year, compare ?? year)}-12-31`
    supabase.rpc('labour_cost_weeks', { p_from: from, p_to: to }).then(({ data, error }) => {
      if (error) toast.error(friendlyError(error))
      setRows(((data as CostRow[]) ?? []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && k !== 'week_start' ? Number(v) : v])) as CostRow))
      setLoading(false)
    })
  }, [year, compare])

  const inDept = (r: CostRow) => !dept || r.department_id === dept
  const yearRows = rows.filter((r) => r.week_start.startsWith(String(year)) && inDept(r))
  const { byEmp, byDept, company } = useMemo(() => {
    const e = new Map<string, Sum>()
    const d = new Map<string, Sum>()
    const c = empty('Company total', '', '', '', settings.hours_per_day)
    for (const r of yearRows) {
      const rate = r.pay_type === 'salaried' ? `${cad(Number(r.annual_salary))} a year` : r.hourly_rate != null ? `${cad(Number(r.hourly_rate))} an hour` : 'No pay rate'
      const s = e.get(r.employee_id) ?? empty(r.employee_name, r.department_name ?? 'No department', r.pay_type, rate, settings.hours_per_day)
      s.rate = rate
      add(s, r, settings.hours_per_day)
      e.set(r.employee_id, s)
      const dk = r.department_name ?? 'No department'
      const ds = d.get(dk) ?? empty(dk, dk, '', '', settings.hours_per_day)
      add(ds, r, settings.hours_per_day)
      d.set(dk, ds)
      add(c, r, settings.hours_per_day)
    }
    return { byEmp: [...e.values()].sort((a, b) => a.name.localeCompare(b.name)), byDept: [...d.values()].sort((a, b) => b.cost_total - a.cost_total), company: c }
  }, [yearRows, settings.hours_per_day])

  const monthTotals = (y: number) => {
    const out = Array(12).fill(0)
    for (const r of rows) if (r.week_start.startsWith(String(y)) && inDept(r)) out[Number(r.week_start.slice(5, 7)) - 1] += Number(r.cost_total) || 0
    return out
  }
  const a = monthTotals(year)
  const b = compare ? monthTotals(compare) : Array(12).fill(0)
  const points: ComparePoint[] = MONTHS.map((m, i) => ({ key: m, label: m, long: `${LONG[i]} ${year}`, a: Math.round(a[i]), b: Math.round(b[i]) }))
  const missing = [...new Set(yearRows.filter((r) => r.no_rate).map((r) => r.employee_name))]
  const assumed = [...new Set(yearRows.filter((r) => r.rate_assumed).map((r) => r.employee_name))]
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i)

  function exportCsv() {
    const head = ['Employee', 'Department', 'Pay type', 'Pay rate', 'Weeks', 'Hours worked', 'Paid regular h', 'Paid overtime h', 'Vacation h', 'Sick h', 'Stat holiday h', 'Regular $', 'Overtime $', 'Vacation $', 'Sick $', 'Stat holiday $', 'Salary $', 'Employer costs $', 'Total $', 'Per hour', 'Per day', 'Per week', 'Per month', 'Per year']
    const line = (s: Sum) => {
      const p = per(s)
      return [s.name, s.dept, s.payType, s.rate, s.weeks.size, ...HOURS.map((k) => Math.round(s[k] * 100) / 100), ...MONEY.map((k) => Math.round(s[k] * 100) / 100), ...[p.hour, p.day, p.week, p.month, p.year].map((x) => Math.round(x * 100) / 100)]
    }
    downloadCsv(`labour-cost-${year}.csv`, head, [...byEmp.map(line), ...byDept.map((d) => line({ ...d, name: `Department: ${d.name}` })), line(company)])
  }

  const table = (list: Sum[], first: string, total?: Sum) => (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white print:overflow-visible">
      <table className="w-full min-w-[64rem] text-sm print:min-w-0 print:text-[0.625rem]">
        <thead className="bg-slate-50 text-xs text-slate-600">
          <tr>
            <th className={th}>{first}</th>
            {first === 'Employee' && <th className={th}>Pay rate</th>}
            <th className={`${th} text-right`}>Hours worked</th>
            <th className={`${th} text-right`}>Regular</th>
            <th className={`${th} text-right`}>Overtime</th>
            <th className={`${th} text-right`}>Vacation</th>
            <th className={`${th} text-right`}>Sick</th>
            <th className={`${th} text-right`}>Stat holiday</th>
            <th className={`${th} text-right`}>Salary</th>
            <th className={`${th} text-right`}>Employer costs</th>
            <th className={`${th} text-right`}>Total</th>
            <th className={`${th} text-right`}>Per hour</th>
            <th className={`${th} text-right`}>Per day</th>
            <th className={`${th} text-right`}>Per week</th>
            <th className={`${th} text-right`}>Per month</th>
            <th className={`${th} text-right`}>Per year</th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td className={`${td} text-slate-500`} colSpan={16}>
                {loading ? 'Loading…' : 'No hours or salaries in this year.'}
              </td>
            </tr>
          )}
          {[...list, ...(total ? [total] : [])].map((s) => {
            const p = per(s)
            const isTotal = s === total
            return (
              <tr key={s.name} className={`border-t border-slate-100 ${isTotal ? 'bg-slate-50 font-semibold' : ''}`}>
                <td className={td}>
                  {s.name}
                  {first === 'Employee' && !isTotal && <div className="text-xs font-normal text-slate-500">{s.dept}</div>}
                </td>
                {first === 'Employee' && <td className={`${td} text-xs`}>{isTotal ? '' : s.rate}</td>}
                <td className={`${td} text-right tabular-nums`}>{showHours(s.worked)}</td>
                {(['cost_regular', 'cost_overtime', 'cost_vacation', 'cost_sick', 'cost_stat', 'cost_salary', 'cost_employer', 'cost_total'] as const).map((k) => (
                  <td key={k} className={`${td} text-right tabular-nums`}>
                    {cad(s[k])}
                  </td>
                ))}
                {[p.hour, p.day, p.week, p.month, p.year].map((x, i) => (
                  <td key={i} className={`${td} text-right tabular-nums`}>
                    {cad(x)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 text-sm print:hidden">
        <label className="flex flex-col">
          <span className="text-xs text-slate-600">Year</span>
          <select className={narrowInputClass} value={year} onChange={(e) => set('year', e.target.value)}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-600">Compare with</span>
          <select className={narrowInputClass} value={compare ?? 'none'} onChange={(e) => set('compare', e.target.value)}>
            <option value="none">No comparison</option>
            {years
              .filter((y) => y !== year)
              .map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-600">Department</span>
          <select className={narrowInputClass} value={dept} onChange={(e) => set('dept', e.target.value)}>
            <option value="">All</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <Can permission="timesheets.reports.export">
            <button type="button" className={secondaryButtonClass} onClick={exportCsv}>
              Export CSV
            </button>
          </Can>
          <Can permission="timesheets.labour_cost.print">
            {!print && (
              <PrintButton title="Labour Cost" to={`/timesheets/labour-cost/print?${params.toString()}`} className="py-2" />
            )}
          </Can>
        </div>
      </div>

      {missing.length > 0 && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">No pay rate for {missing.join(', ')}: their cost is shown as zero. Add a rate in Admin → Users → Employee Setup.</p>}
      {assumed.length > 0 && (
        <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          Some weeks are before the first pay rate of {assumed.join(', ')}: the earliest rate is used for them. Add the older rates (with their effective dates) to compare years exactly.
        </p>
      )}

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr))]">
        {[
          ['Total labour cost', cad(company.cost_total)],
          ['Overtime', cad(company.cost_overtime)],
          ['Paid vacation, sick and stat holidays', cad(company.cost_vacation + company.cost_sick + company.cost_stat)],
          ['Average cost per hour', cad(per(company).hour)],
        ].map(([l, v]) => (
          <div key={l} className="rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-600">
              {l} ({year})
            </p>
            <p className="text-xl font-semibold tabular-nums">{v}</p>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Per Employee</h2>
        {table(byEmp, 'Employee', company)}
      </section>
      <section className="space-y-2 break-inside-avoid">
        <h2 className="font-semibold">Per Department</h2>
        {table(byDept, 'Department', company)}
      </section>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))] print:grid-cols-2">
        <CompareChart title="Labour Cost by Month (CAD)" points={points} nameA={String(year)} nameB={compare ? String(compare) : 'No comparison'} unit="CAD" />
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 break-inside-avoid">
          <h3 className="mb-2 font-semibold">Labour Cost by Department ({year})</h3>
          <ChartView title="Labour cost by department" type="bar" print={print} result={{ points: byDept.map((d) => ({ label: d.name, value: Math.round(d.cost_total) })), unit: 'CAD', headline: null }} />
        </section>
      </div>
      <p className="text-xs text-slate-500">
        Hourly: paid regular hours (banked time used included) × the rate in force that week, overtime × {settings.overtime_rate}, vacation, paid sick days and statutory holidays (for eligible employees,
        from Admin → Company Holidays) × the rate. Salaried: the annual salary ÷ 52 for every week employed. Employer costs: {settings.employer_cost_pct} % (Admin → Payroll Settings). Hours put in the bank cost
        nothing until they are used. Weeks count in the month they start in. Per year = per week × 52. Printed {showDate(todayISO())}.
      </p>
    </div>
  )
}
