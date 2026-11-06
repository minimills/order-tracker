import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { inputClass } from '../components/form'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { addDays, STEP_LABEL, STEPS, type StepKey } from '../lib/schedule'
import { supabase } from '../lib/supabase'
import { BOARD_STAGES, type OrderSummaryRow } from '../lib/types'

type Dept = StepKey | 'shipping'
const DEPTS: Dept[] = [...STEPS.map((s) => s.key), 'shipping']
type Result = { dept: Dept; due_on: string; done_on: string; days_late: number }
type Open = { order_id: string; machine_id: string; step: StepKey; due_on: string }
type Done = { machine_id: string; step: StepKey }
type Ship = Pick<OrderSummaryRow, 'id' | 'stage' | 'archived' | 'expected_ship_date' | 'actual_ship_date' | 'delay_days'>

const PERIODS = [
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
]

function summarize(rows: Result[]) {
  const late = rows.filter((r) => r.days_late > 0)
  return {
    count: rows.length,
    onTime: rows.length ? Math.round(((rows.length - late.length) / rows.length) * 100) : null,
    avgLate: late.length ? Math.round((late.reduce((a, r) => a + r.days_late, 0) / late.length) * 10) / 10 : null,
  }
}

/** Reports → Department delays: on-time %, average days late, by month. */
export default function DepartmentDelaysPage() {
  const [params, setParams] = useSearchParams()
  const period = PERIODS.some((p) => p.value === params.get('months')) ? params.get('months')! : '12'
  const [results, setResults] = useState<Result[]>([])
  const [overdue, setOverdue] = useState<Open[]>([])
  const [loading, setLoading] = useState(true)
  const today = todayISO()

  useEffect(() => {
    if (!supabase) return
    Promise.all([
      fetchAll<Omit<Result, 'dept'> & { step: StepKey }>(() => supabase!.from('deadline_results').select('step, due_on, done_on, days_late').order('machine_id').order('step')),
      fetchAll<Ship>(() =>
        supabase!.from('order_summary').select('id, stage, archived, expected_ship_date, actual_ship_date, delay_days').eq('archived', false).order('id'),
      ),
      fetchAll<Open>(() => supabase!.from('order_deadlines').select('order_id, machine_id, step, due_on').lt('due_on', today).order('machine_id').order('step')),
      fetchAll<Done>(() => supabase!.from('machine_steps').select('machine_id, step').order('machine_id').order('step')),
    ]).then(([r, o, d, done]) => {
      const err = r.error ?? o.error ?? d.error ?? done.error
      if (err) toast.error(friendlyError(err))
      const ships: Result[] = o.data
        .filter((x) => x.actual_ship_date && x.expected_ship_date && x.delay_days !== null)
        .map((x) => ({ dept: 'shipping', due_on: x.expected_ship_date!, done_on: x.actual_ship_date!, days_late: x.delay_days! }))
      setResults([...r.data.map((x) => ({ ...x, dept: x.step as Dept })), ...ships])
      const onBoard = new Set(o.data.filter((x) => BOARD_STAGES.includes(x.stage)).map((x) => x.id))
      const doneSet = new Set(done.data.map((x) => `${x.machine_id}:${x.step}`))
      setOverdue(d.data.filter((x) => onBoard.has(x.order_id) && !doneSet.has(`${x.machine_id}:${x.step}`)))
      setLoading(false)
    })
  }, [today])

  const from = period === 'all' ? '' : addDays(today, -Math.round(Number(period) * 30.44))
  const shown = useMemo(() => results.filter((r) => r.done_on >= from), [results, from])
  const months = useMemo(() => [...new Set(shown.map((r) => r.done_on.slice(0, 7)))].sort().reverse(), [shown])

  return (
    <Can permission="reports.department_delays">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Department delays</h1>
            <p className="text-sm text-slate-600">
              How often each department finishes by its deadline. A step counts when it is ticked done on the Order page;
              Shipping compares the actual ship date with the expected one.
            </p>
          </div>
          <Can permission="reports.department_delays.period">
            <select
              aria-label="Period"
              className={`${inputClass} w-44`}
              value={period}
              onChange={(e) => setParams((p) => {
                p.set('months', e.target.value)
                return p
              }, { replace: true })}
            >
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Can>
        </div>

        {loading ? (
          <p className="text-center text-slate-500">Loading…</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-normal">Department</th>
                    <th className="px-3 py-2 text-right font-normal">Finished</th>
                    <th className="px-3 py-2 text-right font-normal">On time</th>
                    <th className="px-3 py-2 text-right font-normal">Average days late (when late)</th>
                    <th className="px-3 py-2 text-right font-normal">Overdue now</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {DEPTS.map((d) => {
                    const sum = summarize(shown.filter((r) => r.dept === d))
                    const open = d === 'shipping' ? 0 : overdue.filter((o) => o.step === d).length
                    return (
                      <tr key={d}>
                        <td className="px-3 py-2 font-medium">{STEP_LABEL[d]}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{sum.count}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${sum.onTime !== null && sum.onTime < 80 ? 'font-medium text-red-700' : ''}`}>
                          {sum.onTime === null ? '—' : `${sum.onTime}%`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{sum.avgLate === null ? '—' : sum.avgLate}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${open ? 'font-medium text-red-700' : 'text-slate-400'}`}>{d === 'shipping' ? '' : open}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">
              Days are calendar days. “Overdue now” = deadlines already passed on orders in the shop queue, not yet ticked
              done. {from && `Showing work finished since ${showDate(from)}.`}
            </p>

            <Can permission="reports.department_delays.by_month">
              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="mb-2 font-semibold">By month (on time %, how many finished)</h2>
                {months.length === 0 ? (
                  <p className="text-sm text-slate-500">Nothing finished in this period yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="text-left text-xs text-slate-500">
                        <tr>
                          <th className="py-1 pr-3 font-normal">Month</th>
                          {DEPTS.map((d) => (
                            <th key={d} className="px-2 py-1 text-right font-normal">
                              {STEP_LABEL[d]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {months.map((m) => (
                          <tr key={m}>
                            <td className="py-1.5 pr-3">{showDate(`${m}-01`, 'MMM yyyy')}</td>
                            {DEPTS.map((d) => {
                              const sum = summarize(shown.filter((r) => r.dept === d && r.done_on.startsWith(m)))
                              return (
                                <td key={d} className="px-2 py-1.5 text-right tabular-nums">
                                  {sum.onTime === null ? (
                                    <span className="text-slate-300">—</span>
                                  ) : (
                                    <span title={sum.avgLate !== null ? `Average ${sum.avgLate} days late when late` : 'All on time'}>
                                      <span className={sum.onTime < 80 ? 'font-medium text-red-700' : ''}>{sum.onTime}%</span>
                                      <span className="text-xs text-slate-500"> ({sum.count})</span>
                                    </span>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </Can>
          </>
        )}
      </div>
    </Can>
  )
}
