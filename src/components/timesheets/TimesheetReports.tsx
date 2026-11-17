// @permission-scope timesheets.reports
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { narrowInputClass, secondaryButtonClass } from '../form'
import { downloadCsv } from '../../lib/csv'
import { showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { loadBalances, loadWeekRows, showHours, useEmployees, type Balances, type WeekRow } from '../../lib/timesheets'
import { useDepartments } from '../../lib/useDepartments'

const VIEWS = [
  { key: 'hours', label: 'Hours' },
  { key: 'overtime', label: 'Overtime' },
  { key: 'banked', label: 'Banked Hours' },
  { key: 'leave', label: 'Leave Taken' },
] as const
type Ledger = { id: string; employee_id: string; work_date: string; kind: string; source: string | null; hours: number; change: number; note: string | null; by_name: string | null; created_at: string }

const th = 'px-2 py-1.5 text-left font-medium'
const td = 'px-2 py-1.5'
const r2 = (n: number) => Math.round(n * 100) / 100
const HOUR_COLS = [
  ['worked', 'Worked'],
  ['regular', 'Regular'],
  ['overtime', 'Overtime'],
  ['paid_regular', 'Paid regular'],
  ['paid_overtime', 'Paid overtime'],
  ['banked_used', 'Banked used'],
  ['banked_in', 'Banked (put in)'],
  ['vacation', 'Vacation'],
  ['sick', 'Sick'],
  ['stat', 'Stat holiday'],
  ['unpaid', 'Unpaid'],
] as const

/** Timesheet reports: hours per employee per week / month / year, overtime, banked hours and leave taken; CSV for payroll. */
export default function TimesheetReports() {
  const [params, setParams] = useSearchParams()
  const year = todayISO().slice(0, 4)
  const from = params.get('from') || `${year}-01-01`
  const to = params.get('to') || todayISO()
  const view = (VIEWS.find((v) => v.key === params.get('view'))?.key ?? 'hours') as (typeof VIEWS)[number]['key']
  const by = (params.get('by') as 'week' | 'month' | 'year' | null) ?? 'month'
  const empFilter = params.get('employee') ?? ''
  const deptFilter = params.get('dept') ?? ''
  const { employees } = useEmployees(true)
  const { departments } = useDepartments()
  const [rows, setRows] = useState<WeekRow[]>([])
  const [ledger, setLedger] = useState<Ledger[]>([])
  const [balances, setBalances] = useState<Record<string, Balances>>({})
  const set = (k: string, v: string) => {
    const p = Object.fromEntries(params)
    if (v) p[k] = v
    else delete p[k]
    setParams(p, { replace: true })
  }

  useEffect(() => {
    loadWeekRows(from, to)
      .then(setRows)
      .catch((e) => toast.error(friendlyError(e)))
  }, [from, to])
  useEffect(() => {
    if (view !== 'banked' || !supabase) return
    supabase
      .from('banked_hours_ledger')
      .select('*')
      .order('work_date')
      .order('created_at')
      .then(({ data }) => setLedger(((data as Ledger[]) ?? []).map((l) => ({ ...l, hours: Number(l.hours), change: Number(l.change) }))))
  }, [view])

  const empName = new Map(employees.map((e) => [e.id, e.name]))
  const empDept = new Map(employees.map((e) => [e.id, e.department_id]))
  const keep = (id: string) => (!empFilter || id === empFilter) && (!deptFilter || empDept.get(id) === deptFilter)
  const shown = rows.filter((r) => keep(r.employee_id) && (r.entries > 0 || r.stat > 0 || r.credited !== 0))
  const period = (ws: string) => (by === 'week' ? ws : by === 'month' ? ws.slice(0, 7) : ws.slice(0, 4))
  const periodLabel = (p: string) => (by === 'week' ? `Week of ${showDate(p)}` : by === 'month' ? showDate(`${p}-01`, 'MMMM yyyy') : p)

  const grouped = (() => {
    const m = new Map<string, Record<string, number> & { employee_id: string; period: string; imported: number; review: number; choices: string[] }>()
    for (const r of shown) {
      const key = `${r.employee_id}|${period(r.week_start)}`
      const g = m.get(key) ?? Object.assign({ employee_id: r.employee_id, period: period(r.week_start), imported: 0, review: 0, choices: [] as string[] }, Object.fromEntries(HOUR_COLS.map(([k]) => [k, 0])))
      for (const [k] of HOUR_COLS) g[k] += k === 'banked_in' ? r.earned_regular + r.earned_overtime : Number(r[k as keyof WeekRow])
      if (r.imported) g.imported++
      if (r.needs_review) g.review++
      if (r.ot_choice && r.over_by_banked > 0) g.choices.push(`${showDate(r.week_start, 'MMM d')}: ${r.ot_choice === 'regular' ? 'regular pay' : 'overtime'} (${r.ot_choice_by_name ?? '—'})`)
      m.set(key, g)
    }
    return [...m.values()].sort((a, b) => (empName.get(a.employee_id) ?? '').localeCompare(empName.get(b.employee_id) ?? '') || a.period.localeCompare(b.period))
  })()

  const leaveYears = [...new Set(shown.map((r) => r.week_start.slice(0, 4)))].sort()
  const leaveKey = `${leaveYears.join(',')}|${[...new Set(shown.map((r) => r.employee_id))].join(',')}`
  useEffect(() => {
    if (view !== 'leave') return
    const pairs = leaveKey.split('|')[1].split(',').filter(Boolean).flatMap((e) => leaveKey.split('|')[0].split(',').filter(Boolean).map((y) => [e, Number(y)] as const))
    Promise.all(pairs.map(async ([e, y]) => [`${e}|${y}`, await loadBalances(e, y)] as const)).then((list) => setBalances(Object.fromEntries(list.filter(([, b]) => b)) as Record<string, Balances>))
  }, [view, leaveKey])

  function exportCsv() {
    const stamp = `${from}_to_${to}`
    if (view === 'hours') {
      downloadCsv(
        `timesheet-hours-${stamp}.csv`,
        ['Employee', 'Period', ...HOUR_COLS.map(([, l]) => l), 'Imported weeks', 'Weeks needing review', 'Banked time over the threshold'],
        grouped.map((g) => [empName.get(g.employee_id) ?? '', periodLabel(g.period), ...HOUR_COLS.map(([k]) => r2(g[k])), g.imported, g.review, g.choices.join('; ')]),
      )
    } else if (view === 'overtime') {
      downloadCsv(
        `timesheet-overtime-${stamp}.csv`,
        ['Employee', 'Week of', 'Worked', 'Banked used', 'Overtime', 'Overtime banked', 'Paid overtime', 'Extra hours from banked time', 'Paid as', 'Chosen by', 'Chosen on'],
        overtimeRows.map((r) => [r.employee_name, r.week_start, r.worked, r.banked_used, r.overtime, r.earned_overtime, r.paid_overtime, r.over_by_banked, r.over_by_banked > 0 ? (r.ot_choice === 'regular' ? 'Regular pay' : 'Overtime') : '', r.ot_choice_by_name ?? '', r.ot_choice_at?.slice(0, 10) ?? '']),
      )
    } else if (view === 'banked') {
      downloadCsv(
        `timesheet-banked-${stamp}.csv`,
        ['Employee', 'Date', 'What', 'From', 'Hours', 'Bank change', 'Balance', 'Note', 'By'],
        ledgerRows.map((l) => [empName.get(l.employee_id) ?? '', l.work_date, LEDGER_WORDS[l.kind] ?? l.kind, l.source ?? '', l.hours, l.change, l.balance, l.note ?? '', l.by_name ?? '']),
      )
    } else {
      downloadCsv(
        `timesheet-leave-${stamp}.csv`,
        ['Employee', 'Year', 'Vacation hours', 'Vacation days', 'Vacation entitlement', 'Sick hours', 'Sick days', 'Sick entitlement', 'Banked time used (hours)', 'Unpaid (hours)', 'Stat holiday (hours)'],
        leaveRows.map((l) => [l.name, l.year, r2(l.vacation), r2(l.vacation / l.hpd), l.b?.vacation.entitlement ?? '', r2(l.sick), r2(l.sick / l.hpd), l.b?.sick.entitlement ?? '', r2(l.banked), r2(l.unpaid), r2(l.stat)]),
      )
    }
  }

  const overtimeRows = shown.filter((r) => r.overtime > 0 || r.over_by_banked > 0)
  const LEDGER_WORDS: Record<string, string> = { earn: 'Banked', import: 'Banked (imported)', adjust: 'Correction', used: 'Used' }
  const ledgerRows = (() => {
    const bal = new Map<string, number>()
    const out = ledger.map((l) => {
      const b = r2((bal.get(l.employee_id) ?? 0) + l.change)
      bal.set(l.employee_id, b)
      return { ...l, balance: b }
    })
    return out.filter((l) => keep(l.employee_id) && l.work_date >= from && l.work_date <= to).reverse()
  })()
  const leaveRows = (() => {
    const m = new Map<string, { name: string; year: string; vacation: number; sick: number; banked: number; unpaid: number; stat: number; hpd: number; b?: Balances }>()
    for (const r of shown) {
      const y = r.week_start.slice(0, 4)
      const k = `${r.employee_id}|${y}`
      const emp = employees.find((e) => e.id === r.employee_id)
      const g = m.get(k) ?? { name: r.employee_name, year: y, vacation: 0, sick: 0, banked: 0, unpaid: 0, stat: 0, hpd: Number(emp?.hours_per_day ?? 8) || 8 }
      g.vacation += r.vacation
      g.sick += r.sick
      g.banked += r.banked_used
      g.unpaid += r.unpaid
      g.stat += r.stat
      g.b = balances[k]
      if (g.b) g.hpd = Number(g.b.hours_per_day) || g.hpd
      m.set(k, g)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name) || a.year.localeCompare(b.year))
  })()

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 border-b border-slate-200" role="tablist" aria-label="Report">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => set('view', v.key === 'hours' ? '' : v.key)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${view === v.key ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-slate-600">From</span>
          <input type="date" className={narrowInputClass} value={from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-600">To</span>
          <input type="date" className={narrowInputClass} value={to} onChange={(e) => set('to', e.target.value)} />
        </label>
        {[Number(year) - 1, Number(year)].map((y) => (
          <button key={y} type="button" className={secondaryButtonClass} onClick={() => setParams({ ...Object.fromEntries(params), from: `${y}-01-01`, to: `${y}-12-31` }, { replace: true })}>
            {y}
          </button>
        ))}
        <button type="button" className={secondaryButtonClass} onClick={() => setParams({ ...Object.fromEntries(params), from: `${Number(year) - 1}-01-01`, to: todayISO(), by: 'year' }, { replace: true })}>
          Compare Years
        </button>
        {view === 'hours' && (
          <label className="flex flex-col">
            <span className="text-xs text-slate-600">Group by</span>
            <select className={narrowInputClass} value={by} onChange={(e) => set('by', e.target.value === 'month' ? '' : e.target.value)}>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </label>
        )}
        <label className="flex flex-col">
          <span className="text-xs text-slate-600">Department</span>
          <select className={narrowInputClass} value={deptFilter} onChange={(e) => set('dept', e.target.value)}>
            <option value="">All</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-slate-600">Employee</span>
          <select className={narrowInputClass} value={empFilter} onChange={(e) => set('employee', e.target.value)}>
            <option value="">All</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <Can permission="timesheets.reports.export">
          <button type="button" className={`${secondaryButtonClass} ml-auto`} onClick={exportCsv}>
            Export CSV
          </button>
        </Can>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        {view === 'hours' && (
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className={th}>Employee</th>
                <th className={th}>{by === 'week' ? 'Week' : by === 'month' ? 'Month' : 'Year'}</th>
                {HOUR_COLS.map(([k, l]) => (
                  <th key={k} className={`${th} text-right`}>
                    {l}
                  </th>
                ))}
                <th className={th}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {grouped.length === 0 && (
                <tr>
                  <td className={`${td} text-slate-500`} colSpan={HOUR_COLS.length + 3}>
                    No hours in these dates.
                  </td>
                </tr>
              )}
              {grouped.map((g) => (
                <tr key={`${g.employee_id}|${g.period}`} className="border-t border-slate-100">
                  <td className={td}>{empName.get(g.employee_id)}</td>
                  <td className={`${td} whitespace-nowrap`}>{periodLabel(g.period)}</td>
                  {HOUR_COLS.map(([k]) => (
                    <td key={k} className={`${td} text-right tabular-nums`}>
                      {showHours(g[k])}
                    </td>
                  ))}
                  <td className={`${td} text-xs text-slate-600`}>
                    {g.imported > 0 && <span className="mr-1 rounded bg-slate-100 px-1">Imported</span>}
                    {g.review > 0 && <span className="mr-1 rounded bg-amber-100 px-1 text-amber-900">Needs review</span>}
                    {g.choices.length > 0 && <span>Banked time over the threshold: {g.choices.join('; ')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view === 'overtime' && (
          <table className="w-full min-w-[54rem] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className={th}>Employee</th>
                <th className={th}>Week of</th>
                <th className={`${th} text-right`}>Worked</th>
                <th className={`${th} text-right`}>Banked used</th>
                <th className={`${th} text-right`}>Overtime</th>
                <th className={`${th} text-right`}>Banked from overtime</th>
                <th className={`${th} text-right`}>Paid overtime</th>
                <th className={th}>Hours over the threshold from banked time</th>
              </tr>
            </thead>
            <tbody>
              {overtimeRows.length === 0 && (
                <tr>
                  <td className={`${td} text-slate-500`} colSpan={8}>
                    No overtime in these dates.
                  </td>
                </tr>
              )}
              {overtimeRows.map((r) => (
                <tr key={`${r.employee_id}|${r.week_start}`} className="border-t border-slate-100">
                  <td className={td}>{r.employee_name}</td>
                  <td className={td}>{showDate(r.week_start)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r.worked)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r.banked_used)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r.overtime)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r.earned_overtime)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(r.paid_overtime)}</td>
                  <td className={`${td} text-xs`}>
                    {r.over_by_banked > 0
                      ? `${showHours(r.over_by_banked)} hours paid as ${r.ot_choice === 'regular' ? 'regular pay' : 'overtime'}${r.ot_choice_by_name ? ` (chosen by ${r.ot_choice_by_name}${r.ot_choice_at ? `, ${showDate(r.ot_choice_at.slice(0, 10))}` : ''})` : ''}`
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view === 'banked' && (
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className={th}>Employee</th>
                <th className={th}>Date</th>
                <th className={th}>What</th>
                <th className={`${th} text-right`}>Hours</th>
                <th className={`${th} text-right`}>Bank change</th>
                <th className={`${th} text-right`}>Balance</th>
                <th className={th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.length === 0 && (
                <tr>
                  <td className={`${td} text-slate-500`} colSpan={7}>
                    No banked hours in these dates.
                  </td>
                </tr>
              )}
              {ledgerRows.map((l) => (
                <tr key={`${l.kind}${l.id}`} className="border-t border-slate-100">
                  <td className={td}>{empName.get(l.employee_id)}</td>
                  <td className={td}>{showDate(l.work_date)}</td>
                  <td className={td}>
                    {LEDGER_WORDS[l.kind] ?? l.kind}
                    {l.source ? ` (${l.source})` : ''}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(l.hours)}</td>
                  <td className={`${td} text-right tabular-nums ${l.change < 0 ? 'text-red-700' : 'text-green-800'}`}>
                    {l.change > 0 ? '+' : ''}
                    {showHours(l.change)}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(l.balance)}</td>
                  <td className={`${td} text-xs`}>
                    {l.note}
                    {l.by_name ? ` · ${l.by_name}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view === 'leave' && (
          <table className="w-full min-w-[50rem] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className={th}>Employee</th>
                <th className={th}>Year</th>
                <th className={`${th} text-right`}>Vacation days</th>
                <th className={`${th} text-right`}>Vacation left</th>
                <th className={`${th} text-right`}>Sick days</th>
                <th className={`${th} text-right`}>Sick days left</th>
                <th className={`${th} text-right`}>Banked used (h)</th>
                <th className={`${th} text-right`}>Unpaid (h)</th>
                <th className={`${th} text-right`}>Stat holiday (h)</th>
              </tr>
            </thead>
            <tbody>
              {leaveRows.length === 0 && (
                <tr>
                  <td className={`${td} text-slate-500`} colSpan={9}>
                    No leave in these dates.
                  </td>
                </tr>
              )}
              {leaveRows.map((l) => (
                <tr key={`${l.name}|${l.year}`} className="border-t border-slate-100">
                  <td className={td}>{l.name}</td>
                  <td className={td}>{l.year}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(l.vacation / l.hpd)}</td>
                  <td className={`${td} text-right tabular-nums`}>{l.b ? `${showHours(l.b.vacation.left)} of ${showHours(l.b.vacation.entitlement)}` : '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(l.sick / l.hpd)}</td>
                  <td className={`${td} text-right tabular-nums`}>{l.b ? `${showHours(l.b.sick.left)} of ${showHours(l.b.sick.entitlement)}` : '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(l.banked)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(l.unpaid)}</td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(l.stat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Weeks count in the month and year they start in. Imported years are included, so years can be compared. Days = hours ÷ the employee’s hours per day. “Left” counts the whole year, including approved
        time off still to come.
      </p>
    </div>
  )
}
