// @permission-scope timesheets.reports
import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getISOWeek } from 'date-fns'
import { toast } from 'sonner'
import Can from '../Can'
import Icon from '../Icon'
import PrintButton from '../print/PrintButton'
import { narrowInputClass, secondaryButtonClass } from '../form'
import { downloadCsv, downloadXlsx } from '../../lib/csv'
import { addDaysISO, showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { clockText, isoDow, kindLabel, loadWeekRows, showHours, usePayrollSettings, weekDays, weekStartOf, type Employee, type WeekRow } from '../../lib/timesheets'

type Entry = {
  employee_id: string
  work_date: string
  kind: string
  start_time: string | null
  end_time: string | null
  break_minutes: number | null
  hours: number
  notes: string | null
  needs_review: boolean
}
type Holiday = { day: string; name: string }

/** The numbers columns of the payroll report, in order. */
const PAY_COLS = [
  ['worked', 'Worked'],
  ['banked_used', 'Banked used'],
  ['stat', 'Stat holiday'],
  ['vacation', 'Vacation'],
  ['sick', 'Sick'],
  ['total', 'Total paid hours'],
  ['overtime', 'Overtime'],
  ['banked_earned', 'Banked earned'],
] as const
type ColKey = (typeof PAY_COLS)[number][0]
type PayRow = Record<ColKey, number> & { row: WeekRow; name: string; flags: Flag[]; missing: string[] }
type Flag = { key: 'missing' | 'open' | 'over' | 'review'; text: string; tone: string }

const r2 = (n: number) => Math.round(n * 100) / 100
const th = 'px-2 py-1.5 text-left font-medium'
const td = 'px-2 py-1.5'
const num = `${td} text-right tabular-nums`

/** "Week 47, Nov 16 – 22, 2026" (ISO week number of the week). */
function weekLabel(ws: string) {
  const we = addDaysISO(ws, 6)
  const n = getISOWeek(new Date(`${addDaysISO(ws, 3)}T12:00:00`))
  const dates =
    ws.slice(0, 4) !== we.slice(0, 4)
      ? `${showDate(ws)} – ${showDate(we)}`
      : ws.slice(0, 7) !== we.slice(0, 7)
        ? `${showDate(ws, 'MMM d')} – ${showDate(we, 'MMM d, yyyy')}`
        : `${showDate(ws, 'MMM d')} – ${showDate(we, 'd, yyyy')}`
  return `Week ${n}, ${dates}`
}

/** Total paid hours = what payroll pays: regular and overtime paid (worked + banked used − banked this week) + stat + vacation + sick. */
const totalPaid = (r: WeekRow) => r2(r.paid_regular + r.paid_overtime + r.stat + r.vacation + r.sick)

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const t = document.createElement('textarea')
    t.value = text
    t.style.position = 'fixed'
    t.style.opacity = '0'
    document.body.appendChild(t)
    t.select()
    document.execCommand('copy')
    t.remove()
  }
}

/**
 * The weekly payroll report: one row per employee for one pay week (last
 * week by default), the hours payroll needs, a totals row, copy buttons for
 * the payroll app, export and print. Selecting an employee shows their days;
 * missing days, weeks not approved and weeks over the overtime threshold are
 * flagged.
 */
export default function WeeklyPayroll({ employees, dept, employee }: { employees: Employee[]; dept: string; employee: string }) {
  const [params, setParams] = useSearchParams()
  const settings = usePayrollSettings()
  const today = todayISO()
  const lastWeek = weekStartOf(addDaysISO(today, -7), settings.week_start)
  const ws = weekStartOf(params.get('week') || lastWeek, settings.week_start)
  const we = addDaysISO(ws, 6)
  const [rows, setRows] = useState<WeekRow[] | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [open, setOpen] = useState<string | null>(null)

  const setWeek = (d: string) => {
    const p = Object.fromEntries(params)
    const w = weekStartOf(d, settings.week_start)
    if (w === lastWeek) delete p.week
    else p.week = w
    setParams(p, { replace: true })
    setOpen(null)
  }

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'scheduling')
      .maybeSingle()
      .then(({ data }) => {
        const days = (data?.value as { working_days?: number[] } | null)?.working_days
        if (Array.isArray(days) && days.length) setWorkingDays(days.map(Number))
      })
  }, [])

  useEffect(() => {
    if (!supabase) return
    let gone = false
    Promise.all([
      loadWeekRows(ws, ws),
      supabase
        .from('time_entries')
        .select('employee_id, work_date, kind, start_time, end_time, break_minutes, hours, notes, needs_review')
        .gte('work_date', ws)
        .lte('work_date', we)
        .order('work_date')
        .order('start_time'),
      supabase.rpc('holiday_off_dates', { p_from: ws, p_to: we }),
    ])
      .then(([weekRows, te, hol]) => {
        if (gone) return
        if (te.error) throw te.error
        setRows(weekRows)
        setEntries(((te.data as Entry[]) ?? []).map((e) => ({ ...e, hours: Number(e.hours) })))
        setHolidays(((hol.data as Holiday[]) ?? []).map((h) => ({ ...h, day: String(h.day).slice(0, 10) })))
      })
      .catch((e) => {
        if (!gone) toast.error(friendlyError(e))
      })
    return () => {
      gone = true
    }
  }, [ws, we])

  const empById = new Map(employees.map((e) => [e.id, e]))
  const holidayOn = new Map(holidays.map((h) => [h.day, h.name]))
  const days = weekDays(ws)

  /** Working days up to today, while employed, not a company day off, with nothing entered. */
  const missingDays = (r: WeekRow) => {
    if (r.pay_type === 'salaried') return []
    const e = empById.get(r.employee_id)
    return days.filter(
      (d) =>
        d <= today &&
        workingDays.includes(isoDow(d)) &&
        !holidayOn.has(d) &&
        (!e?.start_date || d >= e.start_date) &&
        (!e?.end_date || d <= e.end_date) &&
        !entries.some((x) => x.employee_id === r.employee_id && x.work_date === d),
    )
  }

  const payRows: PayRow[] = (rows ?? [])
    .filter((r) => (!dept || r.department_id === dept) && (!employee || r.employee_id === employee))
    .map((r) => {
      const missing = missingDays(r)
      const flags: Flag[] = []
      if (missing.length) flags.push({ key: 'missing', text: `${missing.length} missing day${missing.length === 1 ? '' : 's'}`, tone: 'bg-red-100 text-red-800' })
      if (r.status !== 'approved' && (r.entries > 0 || missing.length > 0)) flags.push({ key: 'open', text: 'Not approved', tone: 'bg-amber-100 text-amber-900' })
      if (r.worked + r.banked_used > r.threshold) flags.push({ key: 'over', text: `Over ${showHours(r.threshold)} hours`, tone: 'bg-purple-100 text-purple-900' })
      if (r.needs_review) flags.push({ key: 'review', text: 'Needs review', tone: 'bg-amber-100 text-amber-900' })
      return {
        row: r,
        name: r.employee_name,
        flags,
        missing,
        worked: r.worked,
        banked_used: r.banked_used,
        stat: r.stat,
        vacation: r.vacation,
        sick: r.sick,
        total: totalPaid(r),
        overtime: r.overtime,
        banked_earned: r2(r.earned_regular + r.earned_overtime),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const totals = Object.fromEntries(PAY_COLS.map(([k]) => [k, r2(payRows.reduce((s, p) => s + p[k], 0))])) as Record<ColKey, number>
  const flagged = payRows.filter((p) => p.flags.length > 0).length
  const label = weekLabel(ws)

  async function copy(text: string, what: string) {
    await copyText(text)
    toast.success(`${what} copied.`)
  }
  const allTotals = () => payRows.map((p) => `${p.name}\t${showHours(p.total)}`).join('\n')

  const header = ['Employee', ...PAY_COLS.map(([, l]) => l), 'Approved', 'Check']
  const exportRows = () => [
    ...payRows.map((p) => [p.name, ...PAY_COLS.map(([k]) => p[k]), p.row.status === 'approved' ? 'Yes' : 'No', p.flags.map((f) => f.text).join('; ')]),
    ['Total', ...PAY_COLS.map(([k]) => totals[k]), '', ''],
  ]
  const fileName = `payroll-hours-week-${getISOWeek(new Date(`${addDaysISO(ws, 3)}T12:00:00`))}-${ws}`

  return (
    <div className="space-y-3">
      {/* Week chooser */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondaryButtonClass} onClick={() => setWeek(addDaysISO(ws, -7))} aria-label="Previous week">
          ← Previous Week
        </button>
        <h2 className="order-first w-full min-w-0 text-lg font-semibold sm:order-none sm:w-auto" aria-live="polite">
          {label}
        </h2>
        <button type="button" className={secondaryButtonClass} onClick={() => setWeek(addDaysISO(ws, 7))} aria-label="Next week">
          Next Week →
        </button>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <span>Go to date</span>
          <input type="date" className={`${narrowInputClass} py-1`} value={ws} onChange={(e) => e.target.value && setWeek(e.target.value)} />
        </label>
        {ws !== lastWeek && (
          <button type="button" className="text-sm text-slate-700 underline" onClick={() => setWeek(lastWeek)}>
            Last Week
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2" data-print="hide">
        <Can permission="timesheets.reports.copy">
          <button type="button" className={secondaryButtonClass} disabled={payRows.length === 0} onClick={() => copy(allTotals(), 'All totals')}>
            <Icon name="copy" /> Copy All Totals
          </button>
        </Can>
        <Can permission="timesheets.reports.export">
          <button type="button" className={secondaryButtonClass} disabled={payRows.length === 0} onClick={() => downloadCsv(`${fileName}.csv`, header, exportRows())}>
            Export CSV
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={payRows.length === 0}
            onClick={() => downloadXlsx(`${fileName}.xlsx`, `Week ${ws}`, header, exportRows()).catch((e) => toast.error(friendlyError(e)))}
          >
            Export Excel
          </button>
        </Can>
        <Can permission="timesheets.print">
          <PrintButton title="Payroll Hours" subtitle={label} />
        </Can>
        <span className="text-sm text-slate-600">
          {rows === null ? 'Loading…' : `${payRows.length} employee${payRows.length === 1 ? '' : 's'}${flagged ? ` · ${flagged} to check` : ' · nothing to check'}`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white" data-print-section="Payroll hours">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className={th}>Employee</th>
              {PAY_COLS.map(([k, l]) => (
                <th key={k} className={`${th} text-right ${k === 'total' ? 'bg-blue-50 text-slate-800' : ''}`}>
                  {l}
                </th>
              ))}
              <th className={th}>Check</th>
            </tr>
          </thead>
          <tbody>
            {rows !== null && payRows.length === 0 && (
              <tr>
                <td className={`${td} text-slate-500`} colSpan={PAY_COLS.length + 2}>
                  No employees with hours in this week.
                </td>
              </tr>
            )}
            {payRows.map((p) => {
              const id = p.row.employee_id
              const isOpen = open === id
              return (
                <Fragment key={id}>
                  <tr className={`border-t border-slate-100 ${isOpen ? 'bg-slate-50' : 'hover:bg-slate-50'}`}>
                    <td className={td}>
                      <button type="button" className="flex items-center gap-1 text-left font-medium hover:underline" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>
                        <span className="text-xs text-slate-500" aria-hidden="true">
                          {isOpen ? '▾' : '▸'}
                        </span>
                        {p.name}
                        {p.row.pay_type === 'salaried' && <span className="ml-1 rounded bg-slate-100 px-1 text-xs font-normal text-slate-600">Salaried</span>}
                      </button>
                    </td>
                    {PAY_COLS.map(([k]) =>
                      k === 'total' ? (
                        <td key={k} className={`${num} bg-blue-50 font-semibold`}>
                          <span className="inline-flex items-center justify-end gap-1">
                            {showHours(p.total)}
                            <Can permission="timesheets.reports.copy">
                              <button
                                type="button"
                                className="rounded p-0.5 text-slate-500 hover:bg-white hover:text-slate-900"
                                aria-label={`Copy ${p.name}'s total paid hours`}
                                title="Copy"
                                onClick={() => copy(showHours(p.total), `${p.name}'s total`)}
                              >
                                <Icon name="copy" className="h-3.5 w-3.5" />
                              </button>
                            </Can>
                          </span>
                        </td>
                      ) : (
                        <td key={k} className={`${num} ${p[k] === 0 ? 'text-slate-400' : ''}`}>
                          {showHours(p[k])}
                        </td>
                      ),
                    )}
                    <td className={`${td} text-xs`}>
                      <span className="flex flex-wrap gap-1">
                        {p.flags.length === 0 ? (
                          <span className="text-green-800">
                            <Icon name="check" className="h-3.5 w-3.5" /> Ready
                          </span>
                        ) : (
                          p.flags.map((f) => (
                            <span key={f.key} className={`whitespace-nowrap rounded px-1.5 py-0.5 ${f.tone}`}>
                              {f.text}
                            </span>
                          ))
                        )}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50">
                      <td colSpan={PAY_COLS.length + 2} className="px-2 pb-3">
                        <EmployeeDays p={p} days={days} entries={entries.filter((e) => e.employee_id === id)} holidayOn={holidayOn} workingDays={workingDays} today={today} ws={ws} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          {payRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className={td}>Total</td>
                {PAY_COLS.map(([k]) => (
                  <td key={k} className={`${num} ${k === 'total' ? 'bg-blue-50' : ''}`}>
                    {showHours(totals[k])}
                  </td>
                ))}
                <td className={td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Total paid hours = worked + banked used + stat holiday + vacation + sick − banked earned (hours put in the bank are paid later, when used). Overtime is included in the total; pay it at the overtime
        rate. Weeks over {showHours(settings.overtime_weekly_hours)} hours, weeks not approved and working days without hours (up to today) are flagged.
      </p>
    </div>
  )
}

/** One employee's days of the week, with missing days marked. */
function EmployeeDays({
  p,
  days,
  entries,
  holidayOn,
  workingDays,
  today,
  ws,
}: {
  p: PayRow
  days: string[]
  entries: Entry[]
  holidayOn: Map<string, string>
  workingDays: number[]
  today: string
  ws: string
}) {
  const r = p.row
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">{p.name}</span>
        <span className="text-slate-600">{r.status === 'approved' ? `Approved${r.approved_by_name ? ` by ${r.approved_by_name}` : ''}` : 'Not approved yet'}</span>
        {r.worked + r.banked_used > r.threshold && (
          <span className="text-purple-900">
            {showHours(r.worked + r.banked_used)} hours counted (over {showHours(r.threshold)})
            {r.over_by_banked > 0 && r.ot_choice ? `; banked time over the limit paid as ${r.ot_choice === 'regular' ? 'regular pay' : 'overtime'}` : ''}
          </span>
        )}
        <Can permission="timesheets">
          <Link to={`/timesheets/employee/${r.employee_id}?week=${ws}`} className="ml-auto text-slate-700 underline" data-print="hide">
            Open Timesheet
          </Link>
        </Can>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-600">
          <tr>
            <th className={th}>Day</th>
            <th className={th}>Type</th>
            <th className={th}>Time</th>
            <th className={`${th} text-right`}>Break</th>
            <th className={`${th} text-right`}>Hours</th>
            <th className={th}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const list = entries.filter((e) => e.work_date === d)
            const holiday = holidayOn.get(d)
            const dayText = showDate(d, 'EEE MMM d')
            if (list.length === 0) {
              const missing = p.missing.includes(d)
              const note = holiday
                ? `Company day off: ${holiday}`
                : missing
                  ? 'No hours entered'
                  : !workingDays.includes(Number(new Date(`${d}T12:00:00Z`).getUTCDay() || 7))
                    ? 'Not a working day'
                    : d > today
                      ? 'Still to come'
                      : 'No hours'
              return (
                <tr key={d} className={`border-t border-slate-100 ${missing ? 'bg-red-50' : ''}`}>
                  <td className={`${td} whitespace-nowrap`}>{dayText}</td>
                  <td className={`${td} ${missing ? 'font-medium text-red-800' : 'text-slate-500'}`} colSpan={5}>
                    {missing && <Icon name="alert" className="mr-1 h-3.5 w-3.5" />}
                    {note}
                  </td>
                </tr>
              )
            }
            return list.map((e, i) => (
              <tr key={`${d}-${i}`} className="border-t border-slate-100">
                <td className={`${td} whitespace-nowrap`}>{i === 0 ? dayText : ''}</td>
                <td className={td}>
                  {kindLabel(e.kind)}
                  {e.needs_review && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-900">Needs review</span>}
                </td>
                <td className={`${td} whitespace-nowrap`}>{e.start_time && e.end_time ? `${clockText(e.start_time.slice(0, 5))} – ${clockText(e.end_time.slice(0, 5))}` : '—'}</td>
                <td className={`${td} text-right tabular-nums`}>{e.break_minutes ? `${e.break_minutes} min` : '—'}</td>
                <td className={`${td} text-right tabular-nums`}>{showHours(e.hours)}</td>
                <td className={`${td} text-xs text-slate-600`}>{e.notes}</td>
              </tr>
            ))
          })}
        </tbody>
      </table>
    </div>
  )
}
