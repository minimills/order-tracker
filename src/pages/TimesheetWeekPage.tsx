import { currentLang, tr } from '../i18n'
// @permission-scope timesheets
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../components/form'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { askText, confirmAction } from '../lib/confirm'
import { addDaysISO, showDate, todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import {
  hoursFrom,
  KINDS,
  kindLabel,
  loadBalances,
  loadWeekRows,
  previewWeek,
  showHours,
  clockText,
  usePayrollSettings,
  weekDays,
  weekStartOf,
  type Balances,
  type Employee,
  type WeekRow,
} from '../lib/timesheets'
import { ACTION } from '../lib/wording'
import PrintButton from '../components/print/PrintButton'

type Draft = {
  key: string
  id?: string
  work_date: string
  kind: string
  start_time: string
  end_time: string
  break_minutes: string
  hours: string
  notes: string
  source?: string
  needs_review?: boolean
  review_note?: string | null
}
type Banked = { id: string; work_date: string; source: string; hours: number; credited: number; note: string | null; created_by_name: string | null; needs_review: boolean }
type Event = { id: string; action: string; detail: Record<string, unknown>; note: string | null; by_name: string | null; at: string }

let seq = 0
const newKey = () => `n${++seq}`
const cell = 'px-2 py-1'
const small = `${narrowInputClass} px-2 py-1`

const EVENT_WORDS: Record<string, string> = {
  get entered() {
    return tr("Hours saved")
  },
  get approved() {
    return tr("Approved and locked")
  },
  unlocked: 'Unlocked',
  get ot_choice() {
    return tr("Hours over the threshold")
  },
  get banked() {
    return tr("Hours banked")
  },
  get bank_removed() {
    return tr("Banked hours removed")
  },
  get reviewed() {
    return tr("Imported hours reviewed")
  },
  imported: 'Imported',
  get time_off() {
    return tr("Approved time off added")
  },
}

function eventText(e: Event) {
  const d = e.detail ?? {}
  if (e.action === 'ot_choice') {
    return tr("{{showHours}} hours ({{showHours2}} worked + {{showHours3}} banked): {{value}}", { showHours: showHours(Number(d.total)), showHours2: showHours(Number(d.worked)), showHours3: showHours(Number(d.banked)), value: d.choice === 'regular' ? tr("all paid as regular pay") : tr("{{showHours}} hours paid as overtime", { showHours: showHours(Number(d.overtime)) }) })
  }
  if (e.action === 'banked') return tr("{{showHours}} {{source}} hours on {{showDate}} (bank +{{showHours2}})", { showHours: showHours(Number(d.hours)), source: d.source, showDate: showDate(String(d.day), 'EEE MMM d'), showHours2: showHours(Number(d.credited)) })
  if (e.action === 'entered') return tr("{{showHours}} worked, {{showHours2}} overtime", { showHours: showHours(Number(d.worked)), showHours2: showHours(Number(d.overtime)) })
  if (e.action === 'time_off') return tr("{{kindLabel}} {{showHours}} hours on {{showDate}}", { kindLabel: kindLabel(String(d.kind)), showHours: showHours(Number(d.hours)), showDate: showDate(String(d.day), 'EEE MMM d') })
  if (e.action === 'imported') return String(d.file ?? '')
  return ''
}

/** One employee's pay week: hours per day (start, end, unpaid break or a total), banked hours, approval and history. */
export default function TimesheetWeekPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const settings = usePayrollSettings()
  const { can } = usePermissions()
  const ws = weekStartOf(params.get('week') || todayISO(), settings.week_start)
  const days = weekDays(ws)
  const [emp, setEmp] = useState<Employee | null>(null)
  const [week, setWeek] = useState<WeekRow | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loadedJson, setLoadedJson] = useState('[]')
  const [banked, setBanked] = useState<Banked[]>([])
  const [events, setEvents] = useState<Event[]>([])
  const [balances, setBalances] = useState<Balances | null>(null)
  const [busy, setBusy] = useState(false)
  const [banking, setBanking] = useState(false)
  const [choosing, setChoosing] = useState<{ total: number; worked: number; banked: number; extra: number; resolve: (c: 'overtime' | 'regular' | null) => void } | null>(null)
  useBreadcrumbs(emp && [{ get label() {
    return tr("Timesheets")
  }, to: `/timesheets?week=${ws}` }, { label: emp.name }])

  const load = useCallback(async () => {
    if (!supabase || !id) return
    const [e, entries, rows, b] = await Promise.all([
      supabase.from('employees').select('id, user_email, name, pay_type, department_id, start_date, end_date, hours_per_day, import_names, notes, archived').eq('id', id).maybeSingle(),
      supabase.from('time_entries').select('id, work_date, kind, start_time, end_time, break_minutes, hours, notes, source, needs_review, review_note').eq('employee_id', id).gte('work_date', ws).lte('work_date', addDaysISO(ws, 6)).order('work_date').order('start_time'),
      loadWeekRows(ws, ws, id).catch(() => [] as WeekRow[]),
      supabase.from('banked_hours').select('id, work_date, source, hours, credited, note, created_by_name, needs_review').eq('employee_id', id).neq('kind', 'adjust').gte('work_date', ws).lte('work_date', addDaysISO(ws, 6)).order('work_date'),
    ])
    setEmp((e.data as Employee | null) ?? null)
    const d: Draft[] = ((entries.data as Record<string, unknown>[]) ?? []).map((r) => ({
      key: String(r.id),
      id: String(r.id),
      work_date: String(r.work_date),
      kind: String(r.kind),
      start_time: r.start_time ? String(r.start_time).slice(0, 5) : '',
      end_time: r.end_time ? String(r.end_time).slice(0, 5) : '',
      break_minutes: r.break_minutes ? String(r.break_minutes) : '',
      hours: showHours(Number(r.hours)),
      notes: (r.notes as string) ?? '',
      source: String(r.source),
      needs_review: Boolean(r.needs_review),
      review_note: (r.review_note as string | null) ?? null,
    }))
    setDrafts(d)
    setLoadedJson(JSON.stringify(d))
    const w = rows.find((r) => r.week_start === ws) ?? null
    setWeek(w)
    setBanked(((b.data as Banked[]) ?? []).map((x) => ({ ...x, hours: Number(x.hours), credited: Number(x.credited) })))
    if (w?.week_id) {
      const ev = await supabase.from('timesheet_week_events').select('id, action, detail, note, by_name, at').eq('week_id', w.week_id).order('at', { ascending: false })
      setEvents((ev.data as Event[]) ?? [])
    } else setEvents([])
    setBalances(await loadBalances(id, Number(ws.slice(0, 4))))
  }, [id, ws])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const locked = week?.status === 'approved'
  const editable = can('timesheets.enter', 'edit') && !locked
  const dirty = JSON.stringify(drafts) !== loadedJson
  const rowHours = (r: Draft) => {
    const h = hoursFrom(r.start_time, r.end_time, Number(r.break_minutes) || 0)
    return h ?? (Number(r.hours) || 0)
  }
  const preview = previewWeek(drafts.map((r) => ({ kind: r.kind, hours: rowHours(r) })), settings.overtime_weekly_hours, emp?.pay_type ?? 'hourly', week?.ot_choice ?? null)

  const setRow = (key: string, patch: Partial<Draft>) => setDrafts((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const addRow = (day: string, kind = 'work') =>
    setDrafts((list) => [...list, { key: newKey(), work_date: day, kind, start_time: '', end_time: '', break_minutes: '', hours: kind === 'work' ? '' : String(emp?.hours_per_day ?? settings.hours_per_day), notes: '' }])
  const fillWeek = () =>
    setDrafts((list) => [
      ...list,
      ...days
        .filter((d) => [1, 2, 3, 4, 5].includes(new Date(`${d}T12:00:00Z`).getUTCDay()) && !list.some((r) => r.work_date === d))
        .map((d) => ({ key: newKey(), work_date: d, kind: 'work', start_time: settings.fill_start ?? '08:00', end_time: settings.fill_end ?? '16:30', break_minutes: String(settings.fill_break_minutes ?? 30), hours: '', notes: '' })),
    ])

  function askChoice(total: number, worked: number, bankedUsed: number, extra: number) {
    return new Promise<'overtime' | 'regular' | null>((resolve) => setChoosing({ total, worked, banked: bankedUsed, extra, resolve }))
  }

  async function save() {
    if (!supabase || !emp) return
    const loaded = previewWeek(
      (JSON.parse(loadedJson) as Draft[]).map((r) => ({ kind: r.kind, hours: rowHours(r) })),
      settings.overtime_weekly_hours,
      emp.pay_type,
      week?.ot_choice ?? null,
    )
    let choice: 'overtime' | 'regular' | null = null
    if (preview.extra > 0 && (week?.ot_choice == null || loaded.total !== preview.total || loaded.banked !== preview.banked)) {
      const go = await confirmAction(
        tr("This week will be {{showHours}} hours: {{showHours2}} worked + {{showHours3}} banked. That is more than {{showHours4}} hours.", { showHours: showHours(preview.total), showHours2: showHours(preview.worked), showHours3: showHours(preview.banked), showHours4: showHours(settings.overtime_weekly_hours) }),
        { get confirmLabel() {
    return tr("Continue")
  } },
      )
      if (!go) return
      choice = await askChoice(preview.total, preview.worked, preview.banked, preview.extra)
      if (!choice) return
    }
    setBusy(true)
    const payload = drafts.map((r) => ({
      id: r.id ?? null,
      work_date: r.work_date,
      kind: r.kind,
      start_time: r.start_time || null,
      end_time: r.end_time || null,
      break_minutes: Number(r.break_minutes) || 0,
      hours: r.start_time && r.end_time ? null : Number(r.hours) || 0,
      notes: r.notes,
    }))
    const { error } = await supabase.rpc('save_timesheet_week', { p_employee: emp.id, p_week_start: ws, p_entries: payload, p_ot_choice: choice })
    setBusy(false)
    if (error) return toast.error(friendlyError(error), { duration: 10000 })
    toast.success(tr("Hours saved."))
    load()
  }

  async function rpc(name: string, args: Record<string, unknown>, ok: string) {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc(name, args)
    setBusy(false)
    if (error) return toast.error(friendlyError(error), { duration: 10000 })
    toast.success(ok)
    load()
  }
  async function approve() {
    if (dirty) return toast.error(tr("Save the changes first."))
    if (!(await confirmAction(tr("Approve the week of {{showDate}} for {{value}}? The week is locked once approved.", { showDate: showDate(ws), value: emp?.name }), { get confirmLabel() {
    return tr("Approve Week")
  } }))) return
    rpc('approve_timesheet_week', { p_employee: id, p_week_start: ws, p_note: null }, 'Week approved and locked.')
  }
  async function unlock() {
    const reason = await askText(tr("Why does this week need to change?"), { get label() {
    return tr("Reason")
  }, get confirmLabel() {
    return tr("Unlock Week")
  } })
    if (reason) rpc('unlock_timesheet_week', { p_employee: id, p_week_start: ws, p_reason: reason }, 'Week unlocked.')
  }
  async function removeBanked(b: Banked) {
    if (!(await confirmAction(tr("Remove the {{showHours}} banked hours of {{showDate}}?", { showHours: showHours(b.hours), showDate: showDate(b.work_date, 'EEE MMM d') }), { danger: true, confirmLabel: ACTION.remove }))) return
    rpc('remove_banked_hours', { p_id: b.id }, 'Banked hours removed.')
  }

  if (!emp) return <p className="text-sm text-slate-500">{tr("Loading…")}</p>
  const needsReview = drafts.some((r) => r.needs_review) || banked.some((b) => b.needs_review)
  const go = (d: string) => setParams({ week: d }, { replace: true })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold">{emp.name}</h1>
            <Can permission="timesheets.print">
              <PrintButton title={tr("Timesheet – {{name}}", { name: emp.name })} subtitle={tr("Week of {{showDate}}", { showDate: showDate(ws, 'MMMM d, yyyy') })} />
            </Can>
          </div>
          <p className="text-sm text-slate-600">
            {emp.pay_type === 'hourly' ? tr("Hourly") : tr("Salaried")} {tr("· week of")} {showDate(ws, 'EEE MMM d')} {tr("to")} {showDate(addDaysISO(ws, 6), 'EEE MMM d, yyyy')}
            {locked && tr(" · Approved by {{value}}", { value: week?.approved_by_name ?? '—' })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => go(addDaysISO(ws, -7))} aria-label={tr("Previous week")}>
            ←
          </button>
          <input type="date" aria-label={tr("Choose a week")} className={narrowInputClass} value={ws} onChange={(e) => e.target.value && go(e.target.value)} />
          <button type="button" className={secondaryButtonClass} onClick={() => go(addDaysISO(ws, 7))} aria-label={tr("Next week")}>
            →
          </button>
        </div>
      </div>

      {locked && <p className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900">{tr("This week is approved and locked.")}</p>}
      {needsReview && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span>{tr("Some hours were imported and need review (marked below). Check them, correct them if needed, then mark them as reviewed.")}</span>
          <Can permission="timesheets.enter" level="edit">
            {!locked && (
              <button type="button" className={secondaryButtonClass} disabled={busy || dirty} onClick={() => rpc('review_timesheet_week', { p_employee: id, p_week_start: ws, p_note: null }, 'Marked as reviewed.')}>
                {tr("Mark as Reviewed")}
              </button>
            )}
          </Can>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{tr("Hours")}</h2>
              <Can permission="timesheets.enter" level="edit">
                {editable && (
                  <button type="button" className={secondaryButtonClass} onClick={fillWeek}>
                    {tr("Fill Weekdays (")}{clockText(settings.fill_start ?? '08:00')} {tr("to")} {clockText(settings.fill_end ?? '16:30')})
                  </button>
                )}
              </Can>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className={cell}>{tr("Day")}</th>
                    <th className={cell}>{tr("Type")}</th>
                    <th className={cell}>{tr("Start")}</th>
                    <th className={cell}>{tr("End")}</th>
                    <th className={cell}>{tr("Unpaid break (min)")}</th>
                    <th className={cell}>{tr("Hours")}</th>
                    <th className={cell}>{tr("Notes")}</th>
                    <th className={cell} />
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => {
                    const rows = drafts.filter((r) => r.work_date === day)
                    const total = rows.reduce((s, r) => s + rowHours(r), 0)
                    return (
                      <Fragment key={day}>
                        {rows.map((r, i) => {
                          const auto = hoursFrom(r.start_time, r.end_time, Number(r.break_minutes) || 0)
                          return (
                            <tr key={r.key} className={`border-t border-slate-100 ${r.needs_review ? 'bg-amber-50' : ''}`}>
                              <td className={`${cell} whitespace-nowrap`}>{i === 0 ? showDate(day, 'EEE MMM d') : ''}</td>
                              <td className={cell}>
                                <select aria-label={tr("Type of hours")} className={small} disabled={!editable} value={r.kind} onChange={(e) => setRow(r.key, { kind: e.target.value })}>
                                  {KINDS.map((k) => (
                                    <option key={k.key} value={k.key}>
                                      {k.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className={cell}>
                                <input type="time" aria-label={tr("Start")} className={`${small} w-28`} disabled={!editable} value={r.start_time} onChange={(e) => setRow(r.key, { start_time: e.target.value })} />
                              </td>
                              <td className={cell}>
                                <input type="time" aria-label={tr("End")} className={`${small} w-28`} disabled={!editable} value={r.end_time} onChange={(e) => setRow(r.key, { end_time: e.target.value })} />
                              </td>
                              <td className={cell}>
                                <input inputMode="numeric" aria-label={tr("Unpaid break in minutes")} className={`${small} w-20`} disabled={!editable} value={r.break_minutes} onChange={(e) => setRow(r.key, { break_minutes: e.target.value.replace(/[^0-9]/g, '') })} />
                              </td>
                              <td className={cell}>
                                {auto != null ? (
                                  <span className="tabular-nums" title={tr("Worked out from the start, end and break")}>
                                    {showHours(auto)}
                                  </span>
                                ) : (
                                  <input inputMode="decimal" aria-label={tr("Hours")} className={`${small} w-20`} disabled={!editable} value={r.hours} onChange={(e) => setRow(r.key, { hours: e.target.value.replace(/[^0-9.]/g, '') })} />
                                )}
                              </td>
                              <td className={cell}>
                                <input aria-label={tr("Notes")} className={`${small} w-full min-w-40`} disabled={!editable} value={r.notes} onChange={(e) => setRow(r.key, { notes: e.target.value })} />
                                {r.needs_review && <p className="mt-0.5 text-xs text-amber-800">{tr("Imported – needs review")}{r.review_note ? `: ${r.review_note}` : ''}</p>}
                              </td>
                              <td className={cell}>
                                {editable && (
                                  <button type="button" className="text-slate-500 hover:text-red-700" aria-label={tr("Remove this row")} onClick={() => setDrafts((l) => l.filter((x) => x.key !== r.key))}>
                                    ✕
                                  </button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                        <tr className={rows.length ? '' : 'border-t border-slate-100'}>
                          <td className={`${cell} whitespace-nowrap`}>{rows.length === 0 ? showDate(day, 'EEE MMM d') : ''}</td>
                          <td className={cell} colSpan={7}>
                            {editable ? (
                              <button type="button" className="text-xs text-blue-700 underline" onClick={() => addRow(day)}>
                                {tr("+ Add Hours")}
                              </button>
                            ) : (
                              rows.length === 0 && <span className="text-xs text-slate-400">{tr("No hours.")}</span>
                            )}
                            {rows.length > 0 && <span className="float-right text-xs text-slate-500">{tr("Day total")} {showHours(total)}</span>}
                          </td>
                        </tr>
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Can permission="timesheets.enter" level="edit">
              {editable && (
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <button type="button" className={secondaryButtonClass} disabled={!dirty || busy} onClick={() => load()}>
                    {ACTION.cancel}
                  </button>
                  <button type="button" className={buttonClass} disabled={!dirty || busy} onClick={save}>
                    {busy ? ACTION.saving : ACTION.save}
                  </button>
                </div>
              )}
            </Can>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{tr("Banked This Week")}</h2>
              <Can permission="timesheets.enter" level="edit">
                {editable && (
                  <button type="button" className={secondaryButtonClass} disabled={dirty} title={dirty ? tr("Save the hours first") : undefined} onClick={() => setBanking(true)}>
                    {tr("Bank Hours")}
                  </button>
                )}
              </Can>
            </div>
            {banked.length === 0 ? (
              <p className="text-slate-500">{tr("No hours banked this week.")}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {banked.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="w-24">{showDate(b.work_date, 'EEE MMM d')}</span>
                    <span>
                      {showHours(b.hours)} {b.source} {tr("hours → bank +")}{showHours(b.credited)}
                    </span>
                    {b.note && <span className="text-slate-500">· {b.note}</span>}
                    {b.needs_review && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-900">{tr("Imported – needs review")}</span>}
                    <Can permission="timesheets.enter" level="edit">
                      {editable && (
                        <button type="button" className="ml-auto text-xs text-red-700 underline" onClick={() => removeBanked(b)}>
                          {ACTION.remove}
                        </button>
                      )}
                    </Can>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Can permission="timesheets.history">
            <section className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <h2 className="mb-2 font-semibold">{tr("Week History")}</h2>
              {events.length === 0 ? (
                <p className="text-slate-500">{tr("Nothing recorded for this week yet.")}</p>
              ) : (
                <ul className="space-y-1.5">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="font-medium">{EVENT_WORDS[e.action] ?? e.action}</span>
                      {eventText(e) && <span>: {eventText(e)}</span>}
                      {e.note && <span className="text-slate-600"> – “{e.note}”</span>}
                      <span className="text-xs text-slate-500">
                        {' '}
                        · {e.by_name ?? '—'}, {showDate(e.at.slice(0, 10), 'MMM d')} {new Date(e.at).toLocaleTimeString(currentLang(), { hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Can>
        </div>

        <aside className="w-full space-y-4 lg:w-80">
          <section className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <h2 className="mb-2 font-semibold">{tr("Week Totals")}</h2>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt>{tr("Worked")}</dt>
              <dd className="text-right tabular-nums">{showHours(preview.worked)}</dd>
              <dt>{tr("Banked time used")}</dt>
              <dd className="text-right tabular-nums">{showHours(preview.banked)}</dd>
              <dt className="font-medium">{tr("Counted for overtime")}</dt>
              <dd className="text-right font-medium tabular-nums">{showHours(preview.total)}</dd>
              <dt>{tr("Regular")}</dt>
              <dd className="text-right tabular-nums">{showHours(preview.regular)}</dd>
              <dt>{tr("Overtime")}</dt>
              <dd className="text-right tabular-nums">{showHours(preview.overtime)}</dd>
              <dt>{tr("Vacation")}</dt>
              <dd className="text-right tabular-nums">{showHours(preview.vacation)}</dd>
              <dt>{tr("Sick")}</dt>
              <dd className="text-right tabular-nums">{showHours(preview.sick)}</dd>
              <dt>{tr("Unpaid time off")}</dt>
              <dd className="text-right tabular-nums">{showHours(preview.unpaid)}</dd>
              <dt>{tr("Statutory holiday")}</dt>
              <dd className="text-right tabular-nums">{showHours(week?.stat ?? 0)}</dd>
              <dt>{tr("Banked this week (not paid now)")}</dt>
              <dd className="text-right tabular-nums">{showHours((week?.earned_regular ?? 0) + (week?.earned_overtime ?? 0))}</dd>
            </dl>
            <p className="mt-2 text-xs text-slate-500">
              {tr("Overtime: hours over")} {showHours(settings.overtime_weekly_hours)} {tr("a week")}{emp.pay_type === 'salaried' ? tr(" (not for salaried employees)") : ''}.
              {week?.ot_choice && preview.extra > 0 && (
                <> {tr("Hours over the threshold because of banked time:")} {week.ot_choice === 'regular' ? tr("paid as regular pay") : tr("paid as overtime")} ({week.ot_choice_by_name}).</>
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!locked && (
                <button type="button" className={buttonClass} disabled={busy} onClick={approve}>
                  {tr("Approve Week")}
                </button>
              )}
              <Can permission="timesheets.unlock" level="edit">
                {locked && (
                  <button type="button" className={secondaryButtonClass} disabled={busy} onClick={unlock}>
                    {tr("Unlock Week")}
                  </button>
                )}
              </Can>
            </div>
            {!locked && <p className="mt-1 text-xs text-slate-500">{tr("Approval is for the employee’s department manager (or people allowed to approve timesheets).")}</p>}
          </section>

          {balances && (
            <section className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <h2 className="mb-2 font-semibold">{tr("Balances")} {balances.year}</h2>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                <dt>{tr("Banked hours balance")}</dt>
                <dd className="text-right tabular-nums">{showHours(balances.banked.balance)}</dd>
                <dt>{tr("Vacation days left")}</dt>
                <dd className="text-right tabular-nums">
                  {showHours(balances.vacation.left)} {tr("of")} {showHours(balances.vacation.entitlement)}
                </dd>
                <dt>{tr("Sick days left")}</dt>
                <dd className="text-right tabular-nums">
                  {showHours(balances.sick.left)} {tr("of")} {showHours(balances.sick.entitlement)}
                </dd>
              </dl>
              <Link to={`/timesheets?tab=reports&employee=${emp.id}`} className="mt-2 inline-block text-xs text-blue-700 underline">
                {tr("Open the reports for")} {emp.name}
              </Link>
            </section>
          )}
        </aside>
      </div>

      {banking && (
        <BankDialog
          days={days}
          onClose={() => setBanking(false)}
          credit={settings.banked_overtime_credit}
          maxOvertime={Math.max(0, (week?.overtime ?? 0) - (week?.earned_overtime ?? 0))}
          maxRegular={Math.max(0, (week?.regular ?? 0) - (week?.banked_used ?? 0) - (week?.earned_regular ?? 0))}
          onSave={async (day, hours, source, note) => {
            await rpc('bank_hours', { p_employee: id, p_day: day, p_hours: hours, p_source: source, p_note: note }, 'Hours banked.')
            setBanking(false)
          }}
        />
      )}
      {choosing && (
        <Modal title={tr("How Should the Extra Hours Be Paid?")} onClose={() => (choosing.resolve(null), setChoosing(null))} footer={null}>
          <p className="text-sm">
            {tr("This week will be")} {showHours(choosing.total)} hours: {showHours(choosing.worked)} {tr("worked +")} {showHours(choosing.banked)} {tr("banked. Choose how to pay the")}{' '}
            {showHours(choosing.extra)} {tr("hours over")} {showHours(settings.overtime_weekly_hours)} {tr("that the banked time adds.")}
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button type="button" className={buttonClass} onClick={() => (choosing.resolve('overtime'), setChoosing(null))}>
              {tr("Overtime")}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => (choosing.resolve('regular'), setChoosing(null))}>
              {tr("Regular Pay")}
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {tr("Overtime puts the extra hours in overtime. Regular pay puts all")} {showHours(choosing.total)} {tr("hours in regular hours. The choice and who made it are saved in the week’s history and shown in the payroll reports.")}
          </p>
          <div className="mt-3 text-right">
            <button type="button" className={secondaryButtonClass} onClick={() => (choosing.resolve(null), setChoosing(null))}>
              {ACTION.cancel}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function BankDialog({
  days,
  credit,
  maxOvertime,
  maxRegular,
  onClose,
  onSave,
}: {
  days: string[]
  credit: number
  maxOvertime: number
  maxRegular: number
  onClose: () => void
  onSave: (day: string, hours: number, source: 'regular' | 'overtime', note: string) => Promise<void>
}) {
  const [day, setDay] = useState(days[0])
  const [hours, setHours] = useState('')
  const [source, setSource] = useState<'regular' | 'overtime'>(maxOvertime > 0 ? 'overtime' : 'regular')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const h = Number(hours) || 0
  return (
    <Modal
      title={tr("Bank Hours")}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || h <= 0}
            onClick={async () => {
              setBusy(true)
              await onSave(day, h, source, note)
              setBusy(false)
            }}
          >
            {tr("Bank Hours")}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">{tr("The employee keeps these hours in the bank instead of being paid for them now, and uses them later for a full day or some hours.")}</p>
        <Field label={tr("Day")} htmlFor="bank-day">
          <select id="bank-day" className={inputClass} value={day} onChange={(e) => setDay(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>
                {showDate(d, 'EEEE MMM d')}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr("Hours")} htmlFor="bank-hours" hint={tr("A full day or part of a day.")}>
          <input id="bank-hours" inputMode="decimal" className={inputClass} value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ''))} />
        </Field>
        <fieldset>
          <legend className="mb-1 font-medium">{tr("From")}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="bank-source" checked={source === 'regular'} onChange={() => setSource('regular')} />
            {tr("Regular hours (up to")} {showHours(maxRegular)} {tr("this week; the bank gets the same hours)")}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="bank-source" checked={source === 'overtime'} disabled={maxOvertime <= 0} onChange={() => setSource('overtime')} />
            {tr("Overtime hours (up to")} {showHours(maxOvertime)} {tr("this week; the bank gets")} {credit}{tr("× the hours)")}
          </label>
        </fieldset>
        {h > 0 && <p>{tr("The bank balance goes up by")} {showHours(source === 'overtime' ? h * credit : h)} hours.</p>}
        <Field label={tr("Note (optional)")} htmlFor="bank-note">
          <input id="bank-note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
