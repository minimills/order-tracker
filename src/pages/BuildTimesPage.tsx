import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import Icon from '../components/Icon'
import { narrowInputClass } from '../components/form'
import { formatDuration } from '../lib/boards'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { addDays } from '../lib/schedule'
import { supabase } from '../lib/supabase'

type StepRow = {
  id: string
  step: string
  machine_type_id: string
  machine_type: string
  serial_number: string | null
  order_code: string
  started_at: string
  finished_at: string
  auto_started: boolean
  auto_finished: boolean
  seconds: number
  working_days: number | null
}
type TaskRow = {
  id: string
  machine_type_id: string
  machine_type: string
  step: string
  section: string
  item_text: string
  template_item_id: string
  started_at: string
  finished_at: string
  seconds: number
}

const STEP_NAMES: Record<string, string> = {
  fabrication: 'Fabrication',
  pickup: 'Ready for pick up',
  sandblasting: 'Sandblasting',
  powder_coating: 'Powder coating',
  assembly: 'Assembly',
  final_check: 'Final check',
  crating: 'Crating',
  shipping: 'Shipping',
}
const STEP_ORDER = Object.keys(STEP_NAMES)

const PERIODS = [
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
]

const halifaxDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Halifax',
})
const day = (ts: string) => halifaxDay.format(new Date(ts))
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const oneDecimal = (n: number | null) => (n === null ? '—' : String(Math.round(n * 10) / 10))

/** Reports → Build times: real time per machine type and step, per task, and the trend by month. */
export default function BuildTimesPage() {
  const [params, setParams] = useSearchParams()
  const period = PERIODS.some((p) => p.value === params.get('months')) ? params.get('months')! : '12'
  const typeFilter = params.get('type') ?? ''
  const [steps, setSteps] = useState<StepRow[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [loading, setLoading] = useState(true)
  const today = todayISO()

  useEffect(() => {
    if (!supabase) return
    Promise.all([
      fetchAll<StepRow>(() => supabase!.from('production_step_times').select('*').order('finished_at').order('id')),
      fetchAll<TaskRow>(() => supabase!.from('production_task_times').select('*').order('finished_at').order('id')),
    ]).then(([s, t]) => {
      if (s.error) toast.error(friendlyError(s.error))
      setSteps(s.data)
      setTasks(t.error ? [] : t.data)
      setLoading(false)
    })
  }, [])

  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace: true },
    )

  const from = period === 'all' ? '' : addDays(today, -Math.round(Number(period) * 30.44))
  const types = useMemo(
    () =>
      [...new Map(steps.concat(tasks as unknown as StepRow[]).map((r) => [r.machine_type_id, r.machine_type])).entries()].sort((a, b) =>
        a[1].localeCompare(b[1]),
      ),
    [steps, tasks],
  )
  const inPeriod = <T extends { finished_at: string; machine_type_id: string }>(rows: T[]) =>
    rows.filter((r) => day(r.finished_at) >= from && (!typeFilter || r.machine_type_id === typeFilter))
  const shownSteps = inPeriod(steps)
  const shownTasks = inPeriod(tasks)

  // Machine type × step.
  const byType = useMemo(() => {
    const map = new Map<string, { type: string; steps: Map<string, StepRow[]> }>()
    for (const r of shownSteps) {
      const t = map.get(r.machine_type_id) ?? {
        type: r.machine_type,
        steps: new Map(),
      }
      t.steps.set(r.step, [...(t.steps.get(r.step) ?? []), r])
      map.set(r.machine_type_id, t)
    }
    return [...map.values()].sort((a, b) => a.type.localeCompare(b.type))
  }, [shownSteps])
  const usedSteps = STEP_ORDER.filter((s) => shownSteps.some((r) => r.step === s))

  // Per task (same build checklist item).
  const byTask = useMemo(() => {
    const map = new Map<string, TaskRow[]>()
    for (const r of shownTasks) map.set(r.template_item_id, [...(map.get(r.template_item_id) ?? []), r])
    return [...map.values()]
      .map((rows) => ({
        first: rows[0],
        count: rows.length,
        avg: avg(rows.map((r) => r.seconds)),
        min: Math.min(...rows.map((r) => r.seconds)),
        max: Math.max(...rows.map((r) => r.seconds)),
      }))
      .sort(
        (a, b) =>
          a.first.machine_type.localeCompare(b.first.machine_type) ||
          STEP_ORDER.indexOf(a.first.step) - STEP_ORDER.indexOf(b.first.step) ||
          a.first.section.localeCompare(b.first.section) ||
          a.first.item_text.localeCompare(b.first.item_text),
      )
  }, [shownTasks])

  // Trend: average working days per step, by month the step finished.
  const months = [...new Set(shownSteps.map((r) => day(r.finished_at).slice(0, 7)))].sort().reverse()

  /* @rendered-inside-can */
  const cell = (rows: StepRow[] | undefined) => {
    if (!rows?.length) return <span className="text-slate-300">—</span>
    const days = avg(rows.filter((r) => r.working_days !== null).map((r) => r.working_days!))
    const auto = rows.filter((r) => r.auto_started || r.auto_finished).length
    return (
      <span
        title={`${rows.length} build${rows.length === 1 ? '' : 's'}; average ${formatDuration(avg(rows.map((r) => r.seconds)))} on the clock${auto ? `; ${auto} timed automatically when the card moved` : ''}`}
      >
        {oneDecimal(days)} <span className="text-xs text-slate-500">({rows.length})</span>
      </span>
    )
  }

  return (
    <Can permission="reports.build_times">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Build Times</h1>
            <p className="text-sm text-slate-600">
              How long each step really takes, from the production boards. A step starts when Start Stage is pressed (or when the card arrives in the stage) and
              ends when Finish Stage is pressed (or when the card moves on).
            </p>
            <Can permission="reports.department_delays">
              <p className="text-sm">
                <Link to="/reports/department-delays" className="text-blue-700 underline">
                  See department delays against deadlines
                </Link>
              </p>
            </Can>
            <Can permission="admin.machine_types" level="edit">
              <Link to="/admin/machine-types?find=build-times" className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
                <Icon name="pencil" /> Edit Build Times
              </Link>
            </Can>
          </div>
          <Can permission="reports.build_times.filters">
            <div className="flex flex-wrap gap-2">
              <select aria-label="Machine type" className={`${narrowInputClass} w-52`} value={typeFilter} onChange={(e) => set('type', e.target.value)}>
                <option value="">All machine types</option>
                {types.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <select aria-label="Period" className={`${narrowInputClass} w-44`} value={period} onChange={(e) => set('months', e.target.value)}>
                {PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </Can>
        </div>

        {loading ? (
          <p className="text-center text-slate-500">Loading…</p>
        ) : (
          <>
            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="mb-1 font-semibold">Average Working Days per Step</h2>
              <p className="mb-3 text-xs text-slate-500">
                Number of builds in brackets. Point at a number to see the time on the clock. These real times also feed the build-time averages used by the
                schedule (after 3 builds of a type).
                {from && ` Showing steps finished since ${showDate(from)}.`}
              </p>
              {byType.length === 0 ? (
                <p className="text-sm text-slate-500">No steps were finished on production boards in this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs text-slate-500">
                      <tr>
                        <th className="py-1 pr-3 font-normal">Machine type</th>
                        {usedSteps.map((s) => (
                          <th key={s} className="px-2 py-1 text-right font-normal">
                            {STEP_NAMES[s]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {byType.map((t) => (
                        <tr key={t.type}>
                          <td className="py-1.5 pr-3 font-medium">{t.type}</td>
                          {usedSteps.map((s) => (
                            <td key={s} className="px-2 py-1.5 text-right tabular-nums">
                              {cell(t.steps.get(s))}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <Can permission="reports.build_times.trend">
              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="mb-1 font-semibold">Trend by Month</h2>
                <p className="mb-3 text-xs text-slate-500">Average working days per step, by the month the step was finished.</p>
                {months.length === 0 ? (
                  <p className="text-sm text-slate-500">No steps were finished in this period.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="text-left text-xs text-slate-500">
                        <tr>
                          <th className="py-1 pr-3 font-normal">Month</th>
                          {usedSteps.map((s) => (
                            <th key={s} className="px-2 py-1 text-right font-normal">
                              {STEP_NAMES[s]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {months.map((m) => (
                          <tr key={m}>
                            <td className="py-1.5 pr-3">{showDate(`${m}-01`, 'MMM yyyy')}</td>
                            {usedSteps.map((s) => (
                              <td key={s} className="px-2 py-1.5 text-right tabular-nums">
                                {cell(shownSteps.filter((r) => r.step === s && day(r.finished_at).startsWith(m)))}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </Can>

            <Can permission="reports.build_times.tasks">
              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="mb-1 font-semibold">Time per Task</h2>
                <p className="mb-3 text-xs text-slate-500">
                  Build checklist tasks where both Start and Finish were pressed. Time on the clock between the two.
                </p>
                {byTask.length === 0 ? (
                  <p className="text-sm text-slate-500">No timed tasks in this period.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="text-left text-xs text-slate-500">
                        <tr>
                          <th className="py-1 pr-3 font-normal">Machine type</th>
                          <th className="px-2 py-1 font-normal">Step</th>
                          <th className="px-2 py-1 font-normal">Task</th>
                          <th className="px-2 py-1 text-right font-normal">Times</th>
                          <th className="px-2 py-1 text-right font-normal">Average</th>
                          <th className="px-2 py-1 text-right font-normal">Fastest</th>
                          <th className="px-2 py-1 text-right font-normal">Slowest</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {byTask.map((t) => (
                          <tr key={t.first.template_item_id}>
                            <td className="py-1.5 pr-3">{t.first.machine_type}</td>
                            <td className="px-2 py-1.5">{STEP_NAMES[t.first.step] ?? t.first.step}</td>
                            <td className="px-2 py-1.5">
                              <span className="text-slate-500">{t.first.section}: </span>
                              {t.first.item_text}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{t.count}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{formatDuration(t.avg)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{formatDuration(t.min)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{formatDuration(t.max)}</td>
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
