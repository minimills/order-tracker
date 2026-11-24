// @permission-scope timesheets.time_off
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { confirmAction } from '../lib/confirm'
import { addDaysISO, showDate, todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import { isoDow, showHours, STATUS_WORDS, TIME_OFF_KINDS, timeOffLabel, useTsPeople, type Balances } from '../lib/timesheets'
import { ACTION } from '../lib/wording'
import PrintButton from '../components/print/PrintButton'
import { tr } from '../i18n'

type Request = {
  id: string
  employee_id: string
  user_email: string | null
  kind: string
  start_date: string
  end_date: string
  hours: number | null
  note: string | null
  status: string
  decided_by_name: string | null
  decided_at: string | null
  decision_comment: string | null
  created_by_name: string | null
  created_at: string
  work_changes: { title: string; action: string; to: string | null; new_date: string | null; by: string }[]
  employees: { name: string } | null
}
type Work = { item_type: string; item_id: string; title: string; context: string; start_date: string; end_date: string; link: string; can_reassign: boolean; can_move: boolean }

const datesText = (r: { start_date: string; end_date: string; hours: number | null }) =>
  `${r.start_date === r.end_date ? showDate(r.start_date, 'EEE MMM d, yyyy') : `${showDate(r.start_date, 'EEE MMM d')} to ${showDate(r.end_date, 'EEE MMM d, yyyy')}`}${r.hours ? tr(" ({{showHours}} hours a day)", { showHours: showHours(r.hours) }) : ''}`
/** The next weekday after a date (holidays are checked by the database when anything is saved). */
const nextWeekday = (iso: string) => {
  let d = addDaysISO(iso, 1)
  while (isoDow(d) > 5) d = addDaysISO(d, 1)
  return d
}

/** Time Off: request vacation, sick, banked or unpaid time off; managers approve or decline and deal with the work that falls during it. */
export default function TimeOffPage() {
  const [params, setParams] = useSearchParams()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase()
  const [requests, setRequests] = useState<Request[]>([])
  const [asking, setAsking] = useState(params.get('new') === '1')
  const [deciding, setDeciding] = useState<{ r: Request; decision: 'approved' | 'declined' } | null>(null)
  const [work, setWork] = useState<{ r: Request; items: Work[] } | null>(null)
  const highlight = params.get('request')

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('time_off_requests').select('*, employees(name)').order('start_date', { ascending: false }).limit(300)
    if (error) toast.error(friendlyError(error))
    setRequests((data as Request[]) ?? [])
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  useEffect(() => {
    if (highlight) document.getElementById(`req-${highlight}`)?.scrollIntoView({ block: 'center' })
  }, [highlight, requests])

  const mine = requests.filter((r) => r.user_email === me)
  const toDecide = requests.filter((r) => r.user_email !== me && r.status === 'pending')
  const decided = requests.filter((r) => r.user_email !== me && r.status !== 'pending').slice(0, 60)
  const name = (r: Request) => r.employees?.name ?? r.user_email ?? '—'

  async function cancel(r: Request) {
    if (!supabase) return
    if (!(await confirmAction(tr("Cancel the request for {{value}} on {{datesText}}?", { value: timeOffLabel(r.kind).toLowerCase(), datesText: datesText(r) }), { get confirmLabel() {
    return tr("Cancel Request")
  }, danger: true }))) return
    const { error } = await supabase.rpc('cancel_time_off', { p_request: r.id })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Request cancelled."))
    load()
  }
  async function openWork(r: Request) {
    if (!supabase) return
    const { data, error } = await supabase.rpc('time_off_affected_work', { p_request: r.id })
    if (error) return toast.error(friendlyError(error))
    const items = (data as Work[]) ?? []
    if (items.length === 0) toast.success(tr("Nothing is assigned to {{name}} during this time off.", { name: name(r) }))
    else setWork({ r, items })
  }

  const card = (r: Request, actions: React.ReactNode) => (
    <li id={`req-${r.id}`} key={r.id} className={`rounded-lg border bg-white p-3 text-sm ${highlight === r.id ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {name(r)}: {timeOffLabel(r.kind)}
          </p>
          <p>{datesText(r)}</p>
          {r.note && <p className="text-slate-600">“{r.note}”</p>}
          <p className="text-xs text-slate-500">
            {STATUS_WORDS[r.status] ?? r.status}
            {r.decided_by_name && ` · ${r.decided_by_name}, ${showDate(r.decided_at?.slice(0, 10))}`}
            {r.decision_comment && `: “${r.decision_comment}”`}
            {tr(" · asked {{showDate}}", { showDate: showDate(r.created_at.slice(0, 10)) })}
          </p>
          {r.work_changes?.length > 0 && (
            <ul className="mt-1 text-xs text-slate-600">
              {r.work_changes.map((c, i) => (
                <li key={i}>
                  {c.title}: {c.action === 'reassign' ? tr("reassigned to {{to}}", { to: c.to }) : tr("moved to {{showDate}}", { showDate: showDate(c.new_date) })} ({c.by})
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
    </li>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold">{tr("Time Off")}</h1>
            <Can permission="timesheets.time_off.print">
              <PrintButton title={tr("Time Off")} />
            </Can>
          </div>
          <p className="text-sm text-slate-600">{tr("Requests go to the department manager, who approves or declines them. Approved days are added to the timesheet.")}</p>
        </div>
        <Can permission="timesheets.time_off.request" level="edit">
          <button type="button" className={buttonClass} onClick={() => setAsking(true)}>
            {tr("Request Time Off")}
          </button>
        </Can>
      </div>

      {toDecide.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">{tr("Waiting for Your Decision")}</h2>
          <ul className="space-y-2">
            {toDecide.map((r) =>
              card(
                r,
                <>
                  <button type="button" className={buttonClass} onClick={() => setDeciding({ r, decision: 'approved' })}>
                    {tr("Approve")}
                  </button>
                  <button type="button" className={secondaryButtonClass} onClick={() => setDeciding({ r, decision: 'declined' })}>
                    {tr("Decline")}
                  </button>
                </>,
              ),
            )}
          </ul>
        </section>
      )}

      <Can permission="timesheets.time_off.request" level="edit">
        <section className="space-y-2">
          <h2 className="font-semibold">{tr("My Requests")}</h2>
          {mine.length === 0 ? (
            <p className="text-sm text-slate-500">{tr("You have not asked for time off yet.")}</p>
          ) : (
            <ul className="space-y-2">
              {mine.map((r) =>
                card(
                  r,
                  r.status === 'pending' && (
                    <button type="button" className={secondaryButtonClass} onClick={() => cancel(r)}>
                      {tr("Cancel Request")}
                    </button>
                  ),
                ),
              )}
            </ul>
          )}
        </section>
      </Can>

      {decided.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">{tr("Decided Requests")}</h2>
          <ul className="space-y-2">
            {decided.map((r) =>
              card(
                r,
                r.status === 'approved' && r.end_date >= todayISO() && (
                  <>
                    <button type="button" className={secondaryButtonClass} onClick={() => openWork(r)}>
                      {tr("Work During This Time")}
                    </button>
                    <button type="button" className={secondaryButtonClass} onClick={() => cancel(r)}>
                      {tr("Cancel Time Off")}
                    </button>
                  </>
                ),
              ),
            )}
          </ul>
        </section>
      )}

      {asking && (
        <RequestDialog
          onClose={() => {
            setAsking(false)
            if (params.get('new')) setParams({}, { replace: true })
          }}
          onDone={() => {
            setAsking(false)
            load()
          }}
        />
      )}
      {deciding && (
        <DecideDialog
          r={deciding.r}
          who={name(deciding.r)}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
          onDone={(approved) => {
            const r = deciding.r
            setDeciding(null)
            load()
            if (approved) openWork(r)
          }}
        />
      )}
      {work && (
        <WorkDialog
          r={work.r}
          who={name(work.r)}
          items={work.items}
          onClose={() => setWork(null)}
          onDone={() => {
            setWork(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function RequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState('vacation')
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [partial, setPartial] = useState(false)
  const [hours, setHours] = useState('4')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [bal, setBal] = useState<Balances | null>(null)
  useEffect(() => {
    supabase?.rpc('my_timesheet', { p_year: Number(from.slice(0, 4)) }).then(({ data }) => setBal(((data as { balances?: Balances } | null)?.balances as Balances) ?? null))
  }, [from])

  async function send() {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('request_time_off', {
      p: { kind, start_date: from, end_date: to < from ? from : to, hours: partial ? Number(hours) || null : null, note },
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Request sent to your manager."))
    onDone()
  }

  return (
    <Modal
      title={tr("Request Time Off")}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={send}>
            {tr("Send Request")}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label={tr("Type")} htmlFor="to-kind">
          <select id="to-kind" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
            {TIME_OFF_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        {bal && (
          <p className="text-slate-600">
            {kind === 'vacation' && tr("Vacation days left in {{year}}: {{showHours}}.", { year: bal.year, showHours: showHours(bal.vacation.left) })}
            {kind === 'sick' && tr("Paid sick days left in {{year}}: {{showHours}}.", { year: bal.year, showHours: showHours(bal.sick.left) })}
            {kind === 'banked' && tr("Banked hours balance: {{showHours}} ({{showHours2}} days).", { showHours: showHours(bal.banked.balance), showHours2: showHours(bal.banked.balance / (bal.hours_per_day || 8)) })}
            {kind === 'unpaid' && tr("Unpaid time off is not paid.")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr("First day")} htmlFor="to-from">
            <input id="to-from" type="date" className={inputClass} value={from} onChange={(e) => (setFrom(e.target.value), to < e.target.value && setTo(e.target.value))} />
          </Field>
          <Field label={tr("Last day")} htmlFor="to-to">
            <input id="to-to" type="date" className={inputClass} min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
          {tr("Only some hours a day")}
        </label>
        {partial && (
          <Field label={tr("Hours a day")} htmlFor="to-hours">
            <input id="to-hours" inputMode="decimal" className={`${narrowInputClass} w-24`} value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ''))} />
          </Field>
        )}
        <Field label={tr("Note (optional)")} htmlFor="to-note">
          <textarea id="to-note" rows={2} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="text-xs text-slate-500">{tr("Weekends and company holidays are not counted.")}</p>
      </div>
    </Modal>
  )
}

function DecideDialog({ r, who, decision, onClose, onDone }: { r: Request; who: string; decision: 'approved' | 'declined'; onClose: () => void; onDone: (approved: boolean) => void }) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('decide_time_off', { p_request: r.id, p_decision: decision, p_comment: comment })
    setBusy(false)
    if (error) return toast.error(friendlyError(error), { duration: 10000 })
    const res = data as { days_written: number; skipped_days: string[] } | null
    toast.success(
      decision === 'approved'
        ? tr("Approved. {{days}} added to the timesheet.{{value3}}", { days: tr("{{count}} day", { count: res?.days_written ?? 0 }), value3: res?.skipped_days?.length ? tr(" Not added (week already approved): {{value}}.", { value: res.skipped_days.join(', ') }) : '' })
        : tr("Declined."),
      { duration: 8000 },
    )
    onDone(decision === 'approved')
  }
  return (
    <Modal
      title={decision === 'approved' ? tr("Approve Time Off") : tr("Decline Time Off")}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={go}>
            {decision === 'approved' ? tr("Approve") : tr("Decline")}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          {who}: {timeOffLabel(r.kind)}, {datesText(r)}
        </p>
        <Field label={tr("Comment for the employee (optional)")} htmlFor="decide-comment">
          <textarea id="decide-comment" rows={2} className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        {decision === 'approved' && <p className="text-xs text-slate-500">{tr("Next you see the cards, tasks and visits that fall during this time off, to reassign or move them.")}</p>}
      </div>
    </Modal>
  )
}

const TYPE_WORDS: Record<string, string> = { card: 'Card', get service_call() {
    return tr("Service call")
  }, get training() {
    return tr("Training visit")
  } }

function WorkDialog({ r, who, items, onClose, onDone }: { r: Request; who: string; items: Work[]; onClose: () => void; onDone: () => void }) {
  const people = useTsPeople().filter((p) => p.email !== r.user_email)
  const [choice, setChoice] = useState<Record<string, { action: '' | 'reassign' | 'move'; to: string; date: string }>>(() =>
    Object.fromEntries(items.map((i) => [`${i.item_type}:${i.item_id}`, { action: '' as const, to: '', date: nextWeekday(r.end_date) }])),
  )
  const [busy, setBusy] = useState(false)
  const chosen = items.filter((i) => choice[`${i.item_type}:${i.item_id}`].action)

  async function apply() {
    if (!supabase) return
    const changes = chosen.map((i) => {
      const c = choice[`${i.item_type}:${i.item_id}`]
      return { item_type: i.item_type, item_id: i.item_id, action: c.action, to_email: c.to, new_date: c.date }
    })
    if (!(await confirmAction(tr("Apply {{count}} change?", { count: changes.length }), { get confirmLabel() {
    return tr("Apply Changes")
  } }))) return
    setBusy(true)
    const { error } = await supabase.rpc('apply_time_off_changes', { p_request: r.id, p_changes: changes })
    setBusy(false)
    if (error) return toast.error(friendlyError(error), { duration: 10000 })
    toast.success(tr("Changes applied."))
    onDone()
  }

  return (
    <Modal
      title={tr("Work During This Time Off")}
      wide
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {tr("Leave Everything as It Is")}
          </button>
          <button type="button" className={buttonClass} disabled={busy || chosen.length === 0} onClick={apply}>
            {tr("Apply Changes (")}{chosen.length})
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        {who} {tr("is off")} {datesText(r)}{tr(". These are assigned to them during that time. Choose what to do with each one; nothing changes until you select Apply Changes.")}
      </p>
      <ul className="space-y-2">
        {items.map((i) => {
          const k = `${i.item_type}:${i.item_id}`
          const c = choice[k]
          const setC = (p: Partial<typeof c>) => setChoice({ ...choice, [k]: { ...c, ...p } })
          return (
            <li key={k} className="rounded-md border border-slate-200 p-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <span className="mr-1 rounded bg-slate-100 px-1.5 text-xs">{TYPE_WORDS[i.item_type] ?? i.item_type}</span>
                  <Link to={i.link} className="font-medium text-blue-700 underline" target="_blank" rel="noreferrer">
                    {i.title}
                  </Link>
                  {i.context && <span className="text-slate-500"> · {i.context}</span>}
                </div>
                <span className="text-xs text-slate-600">{i.start_date === i.end_date ? tr("Due {{showDate}}", { showDate: showDate(i.start_date) }) : tr("{{showDate}} to {{showDate2}}", { showDate: showDate(i.start_date), showDate2: showDate(i.end_date) })}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select aria-label={tr("What to do")} className={narrowInputClass} value={c.action} onChange={(e) => setC({ action: e.target.value as typeof c.action })}>
                  <option value="">{tr("Leave as it is")}</option>
                  {i.can_reassign && <option value="reassign">{tr("Reassign")}</option>}
                  {i.can_move && <option value="move">{tr("Move the date")}</option>}
                </select>
                {c.action === 'reassign' && (
                  <select aria-label={tr("Reassign to")} className={narrowInputClass} value={c.to} onChange={(e) => setC({ to: e.target.value })}>
                    <option value="">{tr("Choose a person")}</option>
                    {people.map((p) => (
                      <option key={p.email} value={p.email}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                {c.action === 'move' && <input type="date" aria-label={tr("New date")} className={narrowInputClass} value={c.date} onChange={(e) => setC({ date: e.target.value })} />}
                {!i.can_reassign && !i.can_move && <span className="text-xs text-slate-500">{tr("You cannot change this one; ask someone who can open it.")}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </Modal>
  )
}
