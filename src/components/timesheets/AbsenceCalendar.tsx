// @permission-scope timesheets.absences
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { secondaryButtonClass } from '../form'
import { addDaysISO, showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { isoDow, showHours, timeOffLabel } from '../../lib/timesheets'
import { tr } from '../../i18n'

type Absence = { employee_id: string; name: string; department_id: string | null; kind: string; start_date: string; end_date: string; hours: number | null; status: string; request_id: string | null; source: string }

// Colour-blind checked palette (the chart colours), plus a pattern for waiting requests.
const COLOURS: Record<string, string> = { vacation: '#2a78d6', sick: '#eb6834', banked: '#1baf7a', unpaid: '#6250d6' }

/** Absence Calendar: who is off on which day of a month (managers: their departments). */
export default function AbsenceCalendar() {
  const [params, setParams] = useSearchParams()
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : todayISO().slice(0, 7)
  const first = `${month}-01`
  const days = useMemo(() => {
    const out: string[] = []
    for (let d = first; d.slice(0, 7) === month; d = addDaysISO(d, 1)) out.push(d)
    return out
  }, [first, month])
  const last = days[days.length - 1]
  const [rows, setRows] = useState<Absence[]>([])
  const [holidays, setHolidays] = useState<{ day: string; name: string }[]>([])

  useEffect(() => {
    if (!supabase) return
    supabase.rpc('absence_calendar', { p_from: first, p_to: last }).then(({ data, error }) => {
      if (error) toast.error(friendlyError(error))
      setRows((data as Absence[]) ?? [])
    })
    supabase.rpc('holiday_off_dates', { p_from: first, p_to: last }).then(({ data }) => setHolidays((data as { day: string; name: string }[]) ?? []))
  }, [first, last])

  const people = [...new Map(rows.map((r) => [r.employee_id, r.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const holidayOn = new Map(holidays.map((h) => [h.day, h.name]))
  const today = todayISO()
  const shift = (n: number) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(Date.UTC(y, m - 1 + n, 1))
    setParams({ ...Object.fromEntries(params), month: d.toISOString().slice(0, 7) }, { replace: true })
  }
  const cellFor = (emp: string, day: string) => rows.filter((r) => r.employee_id === emp && day >= r.start_date && day <= r.end_date)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondaryButtonClass} onClick={() => shift(-1)} aria-label={tr("Previous month")}>
          ←
        </button>
        <h2 className="w-40 text-center font-semibold">{showDate(first, 'MMMM yyyy')}</h2>
        <button type="button" className={secondaryButtonClass} onClick={() => shift(1)} aria-label={tr("Next month")}>
          →
        </button>
        <div className="ml-auto flex flex-wrap gap-3 text-xs">
          {Object.entries(COLOURS).map(([k, c]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: c }} />
              {timeOffLabel(k)}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-sm border border-slate-400" style={{ background: 'repeating-linear-gradient(45deg,#cbd5e1 0 2px,transparent 2px 5px)' }} />
            {tr("Waiting for a decision")}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-36 bg-white px-2 py-1 text-left">{tr("Employee")}</th>
              {days.map((d) => (
                <th key={d} className={`w-7 px-0.5 py-1 text-center font-normal ${[6, 7].includes(isoDow(d)) ? 'bg-slate-50 text-slate-400' : ''} ${d === today ? 'font-bold text-blue-700' : ''}`} title={holidayOn.get(d)}>
                  <div>{showDate(d, 'EEEEE')}</div>
                  <div>{Number(d.slice(8))}</div>
                  {holidayOn.has(d) && <div className="text-[0.625rem] text-red-700">{tr("Hol")}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.length === 0 && (
              <tr>
                <td className="px-2 py-3 text-slate-500" colSpan={days.length + 1}>
                  {tr("Nobody is off this month.")}
                </td>
              </tr>
            )}
            {people.map(([emp, name]) => (
              <tr key={emp} className="border-t border-slate-100">
                <td className="sticky left-0 z-10 bg-white px-2 py-1 whitespace-nowrap">{name}</td>
                {days.map((d) => {
                  const here = cellFor(emp, d)
                  const a = here[0]
                  const label = here.map((x) => `${timeOffLabel(x.kind)}${x.hours ? ` ${showHours(x.hours)} h` : ''}${x.status === 'pending' ? ' (waiting for a decision)' : ''}`).join(', ')
                  return (
                    <td key={d} className={`h-7 p-0.5 ${[6, 7].includes(isoDow(d)) ? 'bg-slate-50' : ''}`} title={a ? `${name}: ${label}` : undefined}>
                      {a &&
                        (a.request_id ? (
                          <Link
                            to={`/time-off?request=${a.request_id}`}
                            aria-label={`${name}, ${showDate(d)}: ${label}`}
                            className="block h-full w-full rounded-sm"
                            style={a.status === 'pending' ? { background: `repeating-linear-gradient(45deg,${COLOURS[a.kind]} 0 2px,transparent 2px 5px)`, border: `1px solid ${COLOURS[a.kind]}` } : { background: COLOURS[a.kind] }}
                          />
                        ) : (
                          <span aria-label={`${name}, ${showDate(d)}: ${label}`} className="block h-full w-full rounded-sm" style={{ background: COLOURS[a.kind] }} />
                        ))}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">{tr("Approved and waiting requests, plus leave entered or imported in the timesheets. Select a coloured day to open the request.")}</p>
    </div>
  )
}
