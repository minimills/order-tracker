import { addDays, addMonths, addWeeks, endOfMonth, endOfWeek, format, isSameMonth, parseISO, startOfMonth, startOfWeek } from 'date-fns'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { buttonClass, narrowInputClass, secondaryButtonClass } from '../components/form'
import CalendarEntryDialog, { type ManualEntry } from '../components/service/CalendarEntryDialog'
import PhoneEventDialog from '../components/service/PhoneEventDialog'
import Icon from '../components/Icon'
import PhoneCalendarSync from '../components/service/PhoneCalendarSync'
import { useAuth } from '../lib/auth'
import { todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { CALENDAR_KINDS, showTime, type CalendarKind, type CalendarRow } from '../lib/service'
import { supabase } from '../lib/supabase'

const iso = (d: Date) => format(d, 'yyyy-MM-dd')
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const initials = (name: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

/** One entry as a coloured chip; opens its order / call, or the edit box for own entries. */
/* @rendered-inside-can */
function Chip({ r, full, showTech, onManual }: { r: CalendarRow; full?: boolean; showTech: boolean; onManual: (r: CalendarRow) => void }) {
  const k = CALENDAR_KINDS[r.kind as CalendarKind] ?? CALENDAR_KINDS.onsite
  const time = r.start_at ? `${showTime(r.start_at)} ` : ''
  const text = (
    <>
      {r.from_phone && <Icon name="phone" className="mr-0.5 inline h-3 w-3 align-[-2px]" label="From phone" />}
      {`${showTech ? `${initials(r.tech_name)} · ` : ''}${time}${r.title}`}
    </>
  )
  const cls = `block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] ring-1 ${k.chip} ${full ? 'whitespace-normal' : ''}`
  const label = `${r.from_phone ? 'From phone · ' : ''}${k.label}: ${time}${r.title}${r.tech_name ? ` (${r.tech_name})` : ''}${r.notes ? ` – ${r.notes}` : ''}`
  if (r.source === 'manual' || r.source === 'phone')
    return (
      <button type="button" className={cls} title={label} onClick={() => onManual(r)}>
        {text}
      </button>
    )
  if (r.link)
    return (
      <Link to={r.link} className={cls} title={label}>
        {text}
      </Link>
    )
  return (
    <span className={cls} title={label}>
      {text}
    </span>
  )
}

/** Technician calendar: training visits, service calls, travel days and own entries. */
export default function CalendarPage() {
  const [params, setParams] = useSearchParams()
  const { can } = usePermissions()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const seesAll = can('service.calendar.all')
  // Phones open in week view (the month grid is narrow there); the choice is kept in the address.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640
  const view = (params.get('view') ?? (narrow ? 'week' : 'month')) === 'week' ? 'week' : 'month'
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? parseISO(params.get('date')!) : parseISO(todayISO())
  const tech = seesAll ? (params.get('tech') ?? '') : me // '' = all technicians
  const [rows, setRows] = useState<CalendarRow[]>([])
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ManualEntry | 'new' | null>(null)
  const [phoneEntry, setPhoneEntry] = useState<CalendarRow | null>(null)
  // My own linked phone calendar: warn here when it stopped working.
  const [linkProblem, setLinkProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!supabase || !me || !can('service.calendar.import', 'edit')) return
    supabase
      .from('calendar_imports')
      .select('status, last_error')
      .eq('user_email', me)
      .maybeSingle()
      .then(({ data }) => setLinkProblem(data?.status === 'error' ? ((data.last_error as string | null) ?? 'Your phone calendar link stopped working.') : null))
  }, [me, can])

  const [from, to] = useMemo(() => {
    if (view === 'week') return [startOfWeek(anchor, { weekStartsOn: 1 }), endOfWeek(anchor, { weekStartsOn: 1 })]
    return [startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }), endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 })]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, iso(anchor)])

  const set = (patch: Record<string, string>) =>
    setParams(
      (p) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v) p.set(k, v)
          else p.delete(k)
        }
        return p
      },
      { replace: true },
    )

  const load = useCallback(async () => {
    if (!supabase || (!tech && !seesAll && !me)) return
    setLoading(true)
    const { data, error } = await supabase.rpc('calendar_entries', { p_from: iso(from), p_to: iso(to), p_tech: tech || null })
    setLoading(false)
    if (error) return toast.error(friendlyError(error))
    setRows((data as CalendarRow[] | null) ?? [])
  }, [from, to, tech, seesAll, me])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  useEffect(() => {
    supabase?.rpc('technician_choices').then(({ data }) => setPeople((data as { email: string; name: string }[] | null) ?? []))
  }, [])

  const days = useMemo(() => {
    const out: Date[] = []
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
    return out
  }, [from, to])
  const onDay = (d: Date) => {
    const k = iso(d)
    return rows.filter((r) => r.start_date <= k && r.end_date >= k)
  }

  async function openManual(r: CalendarRow) {
    if (!supabase) return
    if (r.source === 'phone') return setPhoneEntry(r)
    const { data, error } = await supabase.from('tech_calendar_entries').select('*').eq('id', r.source_id).maybeSingle()
    if (error || !data) return toast.error(error ? friendlyError(error) : 'That entry could not be found.')
    setEditing(data as ManualEntry)
  }

  const step = (dir: -1 | 1) => set({ date: iso(view === 'week' ? addWeeks(anchor, dir) : addMonths(anchor, dir)) })
  const title = view === 'week' ? `${format(from, 'MMM d')} – ${format(to, 'MMM d, yyyy')}` : format(anchor, 'MMMM yyyy')
  const showTech = !tech

  return (
    <Can permission="service.calendar">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link to="/service" className="text-sm text-slate-600 underline">
              ← Service
            </Link>
            <h1 className="mt-1 text-2xl font-semibold">Technician Calendar</h1>
            <p className="text-sm text-slate-600">
              Training visits and service calls appear by themselves from their planned dates; travel days from the service log.
            </p>
          </div>
          <Can anyOf={['service.calendar.add', 'service.calendar.manage']} level="edit">
            <button type="button" className={buttonClass} onClick={() => setEditing('new')}>
              Add Entry
            </button>
          </Can>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Can permission="service.calendar.navigate">
            <div className="flex rounded-md border border-slate-300 bg-white p-0.5" role="tablist" aria-label="View">
              {(['month', 'week'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  className={`rounded px-3 py-1 text-sm ${view === v ? 'bg-slate-900 text-white' : ''}`}
                  onClick={() => set({ view: v })}
                >
                  {v === 'month' ? 'Month' : 'Week'}
                </button>
              ))}
            </div>
            <button type="button" className={secondaryButtonClass} onClick={() => step(-1)} aria-label="Previous">
              ←
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => set({ date: '' })}>
              Today
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => step(1)} aria-label="Next">
              →
            </button>
          </Can>
          <h2 className="ml-1 text-lg font-semibold">{title}</h2>
          <span className="flex-1" />
          <Can permission="service.calendar.all" fallback={<span className="text-sm text-slate-600">Your calendar</span>}>
            <select aria-label="Technician" className={`${narrowInputClass} w-56`} value={tech} onChange={(e) => set({ tech: e.target.value })}>
              <option value="">All technicians</option>
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </Can>
        </div>

        {linkProblem && (
          <Can permission="service.calendar.import" level="edit">
            <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">
              Your phone calendar is not being read: {linkProblem}{' '}
              <Link to="/settings" className="font-medium underline">
                Open Settings → Calendar
              </Link>
            </p>
          </Can>
        )}

        <ul className="flex flex-wrap gap-3 text-xs" aria-label="Colours">
          {(Object.keys(CALENDAR_KINDS) as CalendarKind[]).map((k) => (
            <li key={k} className="flex items-center gap-1.5">
              <span className={`h-3 w-3 rounded-full ${CALENDAR_KINDS[k].dot}`} aria-hidden="true" />
              {CALENDAR_KINDS[k].label}
            </li>
          ))}
          <li className="flex items-center gap-1.5 text-slate-600">
            <Icon name="phone" className="h-3.5 w-3.5" /> From the technician’s phone calendar
          </li>
          {showTech && <li className="text-slate-500">Initials = technician</li>}
        </ul>

        {loading && rows.length === 0 && <p className="text-sm text-slate-500">Loading…</p>}

        {view === 'month' ? (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-medium text-slate-600">
              {WEEKDAYS.map((d) => (
                <div key={d} className="py-1.5">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d) => {
                const list = onDay(d)
                const today = iso(d) === todayISO()
                return (
                  <div key={iso(d)} className={`min-h-24 border-r border-b border-slate-100 p-1 ${isSameMonth(d, anchor) ? '' : 'bg-slate-50 text-slate-400'}`}>
                    <div className={`mb-1 text-right text-xs ${today ? 'font-bold text-blue-700' : ''}`}>{format(d, 'd')}</div>
                    <div className="space-y-0.5">
                      {list.slice(0, 3).map((r) => (
                        <Chip key={`${r.source}-${r.source_id}`} r={r} showTech={showTech} onManual={openManual} />
                      ))}
                      {list.length > 3 && (
                        <Can permission="service.calendar.navigate" fallback={<span className="text-[11px] text-slate-600">+{list.length - 3} more</span>}>
                          <button type="button" className="text-[11px] text-slate-600 underline" onClick={() => set({ view: 'week', date: iso(d) })}>
                            +{list.length - 3} more
                          </button>
                        </Can>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-7">
            {days.map((d) => {
              const list = onDay(d)
              const today = iso(d) === todayISO()
              return (
                <section key={iso(d)} className={`min-h-32 rounded-lg border bg-white p-2 ${today ? 'border-blue-400' : 'border-slate-200'}`}>
                  <h3 className={`mb-2 text-sm ${today ? 'font-bold text-blue-700' : 'font-medium'}`}>{format(d, 'EEE MMM d')}</h3>
                  {list.length === 0 && <p className="text-xs text-slate-400">Nothing planned.</p>}
                  <div className="space-y-1">
                    {list.map((r) => (
                      <Chip key={`${r.source}-${r.source_id}`} r={r} full showTech={showTech} onManual={openManual} />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}

        <Can permission="service.calendar.sync" level="edit">
          <PhoneCalendarSync />
        </Can>

        {phoneEntry && (
          <PhoneEventDialog
            entry={phoneEntry}
            onClose={() => setPhoneEntry(null)}
            onSaved={() => {
              setPhoneEntry(null)
              load()
            }}
          />
        )}

        {editing && (
          <CalendarEntryDialog
            entry={editing === 'new' ? null : editing}
            people={people}
            defaultTech={tech || me}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              load()
            }}
          />
        )}
      </div>
    </Can>
  )
}
