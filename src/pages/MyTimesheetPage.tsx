// @permission-scope timesheets.mine
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Can from '../components/Can'
import { narrowInputClass, secondaryButtonClass } from '../components/form'
import { addDaysISO, showDate, todayISO } from '../lib/dates'
import { supabase } from '../lib/supabase'
import { kindLabel, showHours, toWeekRow, type Balances, type WeekRow } from '../lib/timesheets'

type Mine = {
  employee: { id: string; name: string; pay_type: string; start_date: string | null }
  balances: Balances
  weeks: Record<string, unknown>[]
  entries: { id: string; work_date: string; kind: string; start_time: string | null; end_time: string | null; break_minutes: number; hours: number; notes: string | null }[]
  bank: { id: string; work_date: string; kind: string; source: string | null; hours: number; change: number; note: string | null }[]
}
const th = 'px-2 py-1.5 text-left font-medium'
const td = 'px-2 py-1.5'
const BANK_WORDS: Record<string, string> = { earn: 'Banked', import: 'Banked (imported)', adjust: 'Correction', used: 'Used' }

/** My Timesheet: the signed-in employee's hours, banked hours, vacation and sick days. Read only. */
export default function MyTimesheetPage() {
  const [year, setYear] = useState(Number(todayISO().slice(0, 4)))
  const [mine, setMine] = useState<Mine | null | undefined>(undefined)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    supabase?.rpc('my_timesheet', { p_year: year }).then(({ data }) => setMine((data as Mine | null) ?? null))
  }, [year])

  if (mine === undefined) return <p className="text-sm text-slate-500">Loading…</p>
  if (mine === null)
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">My Timesheet</h1>
        <p className="text-sm text-slate-600">You are not set up as an employee yet. Ask the office to add you in Admin → Users → Employee Setup.</p>
      </div>
    )
  const b = mine.balances
  const weeks: WeekRow[] = mine.weeks.map(toWeekRow)
  const cards = [
    { title: 'Banked Hours', rows: [['Earned this year', b.banked.earned], ['Used this year', b.banked.used], ['Balance', b.banked.balance]] },
    { title: 'Vacation Days', rows: [['Entitlement', b.vacation.entitlement], ['Used or booked', b.vacation.used_days], ['Left', b.vacation.left]] },
    { title: 'Sick Days', rows: [['Paid sick days', b.sick.entitlement], ['Used', b.sick.used_days], ['Left', b.sick.left]] },
  ] as const

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">My Timesheet</h1>
          <p className="text-sm text-slate-600">
            {mine.employee.name} · {b.years_of_service} years of service by the end of {year}. Hours are entered by the office; ask your manager if something looks wrong.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Year" className={narrowInputClass} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {Array.from({ length: 4 }, (_, i) => Number(todayISO().slice(0, 4)) - i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <Can permission="timesheets.time_off.request" level="edit">
            <Link to="/time-off?new=1" className={secondaryButtonClass}>
              Request Time Off
            </Link>
          </Can>
        </div>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
        {cards.map((c) => (
          <section key={c.title} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <h2 className="mb-1 font-semibold">{c.title}</h2>
            <dl className="grid grid-cols-2 gap-y-0.5">
              {c.rows.map(([l, v]) => (
                <div key={l} className="contents">
                  <dt className="text-slate-600">{l}</dt>
                  <dd className="text-right font-medium tabular-nums">{showHours(Number(v))}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Weeks</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className={th}>Week of</th>
                <th className={`${th} text-right`}>Worked</th>
                <th className={`${th} text-right`}>Regular</th>
                <th className={`${th} text-right`}>Overtime</th>
                <th className={`${th} text-right`}>Banked used</th>
                <th className={`${th} text-right`}>Banked</th>
                <th className={`${th} text-right`}>Vacation</th>
                <th className={`${th} text-right`}>Sick</th>
                <th className={`${th} text-right`}>Stat holiday</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {weeks.length === 0 && (
                <tr>
                  <td className={`${td} text-slate-500`} colSpan={10}>
                    No hours in {year}.
                  </td>
                </tr>
              )}
              {weeks.map((w) => (
                <WeekLines key={w.week_start} w={w} open={open === w.week_start} onToggle={() => setOpen(open === w.week_start ? null : w.week_start)} entries={mine.entries.filter((e) => e.work_date >= w.week_start && e.work_date <= addDaysISO(w.week_start, 6))} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Banked Hours History</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[30rem] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className={th}>Date</th>
                <th className={th}>What</th>
                <th className={`${th} text-right`}>Hours</th>
                <th className={`${th} text-right`}>Bank change</th>
                <th className={th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {mine.bank.length === 0 && (
                <tr>
                  <td className={`${td} text-slate-500`} colSpan={5}>
                    No banked hours yet.
                  </td>
                </tr>
              )}
              {mine.bank.map((l) => (
                <tr key={`${l.kind}${l.id}`} className="border-t border-slate-100">
                  <td className={td}>{showDate(l.work_date)}</td>
                  <td className={td}>
                    {BANK_WORDS[l.kind] ?? l.kind}
                    {l.source ? ` (${l.source})` : ''}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{showHours(Number(l.hours))}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {Number(l.change) > 0 ? '+' : ''}
                    {showHours(Number(l.change))}
                  </td>
                  <td className={td}>{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function WeekLines({ w, open, onToggle, entries }: { w: WeekRow; open: boolean; onToggle: () => void; entries: Mine['entries'] }) {
  return (
    <>
      <tr className="border-t border-slate-100">
        <td className={td}>
          <button type="button" className="text-left text-blue-700 underline" aria-expanded={open} onClick={onToggle}>
            {open ? '▾' : '▸'} {showDate(w.week_start)}
          </button>
        </td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.worked)}</td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.regular)}</td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.overtime)}</td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.banked_used)}</td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.earned_regular + w.earned_overtime)}</td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.vacation)}</td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.sick)}</td>
        <td className={`${td} text-right tabular-nums`}>{showHours(w.stat)}</td>
        <td className={td}>{w.status === 'approved' ? 'Approved' : 'Not approved yet'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={10} className="bg-slate-50 px-4 py-2">
            {entries.length === 0 ? (
              <p className="text-xs text-slate-500">No daily hours (statutory holiday or banked only).</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {entries.map((e) => (
                  <li key={e.id}>
                    {showDate(e.work_date, 'EEE MMM d')}: {kindLabel(e.kind)} {showHours(Number(e.hours))} h
                    {e.start_time && e.end_time && ` (${e.start_time.slice(0, 5)}–${e.end_time.slice(0, 5)}${e.break_minutes ? `, ${e.break_minutes} min break` : ''})`}
                    {e.notes && ` · ${e.notes}`}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
