import { addDays, addMonths, addWeeks, differenceInCalendarDays, endOfMonth, endOfWeek, format, parseISO, startOfMonth, startOfWeek } from 'date-fns'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { buttonClass, narrowInputClass, secondaryButtonClass } from '../components/form'
import Icon from '../components/Icon'
import CalendarEntryDialog, { type EntryPreset, type ManualEntry } from '../components/service/CalendarEntryDialog'
import { MiniMonth, MonthView, TimeGridView, type ViewProps } from '../components/service/CalendarViews'
import { endOf, isTimed, iso, PX_PER_MIN, rowKey } from '../lib/calendarView'
import PhoneCalendarSync from '../components/service/PhoneCalendarSync'
import PhoneEventDialog from '../components/service/PhoneEventDialog'
import CalendarImportSettings from '../components/settings/CalendarImportSettings'
import { useAuth } from '../lib/auth'
import { hfxParts, hfxToIso } from '../lib/calendarTime'
import { addDaysISO, todayISO } from '../lib/dates'
import { callFunction } from '../lib/edgeFunction'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { CALENDAR_KINDS, type CalendarKind, type CalendarRow } from '../lib/service'
import { supabase } from '../lib/supabase'

type View = 'day' | 'week' | 'month'
type Drag = {
  key: string
  row: CalendarRow | null // null = choosing a time for a new entry
  mode: 'move' | 'resize' | 'create'
  allowed: boolean
  touch: boolean
  active: boolean // touch: after holding still for a moment
  x0: number
  y0: number
  day0: string
  min0: number
  dDays: number
  dMin: number
  moved: boolean
}
type Change = { start_date: string; end_date: string; start_at: string | null; end_at: string | null }
type ImportStatus = { status: 'pending' | 'ok' | 'error'; last_error: string | null; last_synced_at: string | null }

const snap = (m: number, step = 15) => Math.round(m / step) * step
const clampMin = (m: number) => Math.max(0, Math.min(1440, m))
const when = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Where an entry ends up after a drag (also used to draw it while dragging). */
function moved(r: CalendarRow, d: Drag): Change {
  if (isTimed(r)) {
    const s = hfxParts(r.start_at!)
    const e = hfxParts(endOf(r))
    const minutes = d.mode === 'move' ? d.dMin : 0
    if (d.mode === 'resize') {
      const sMs = new Date(r.start_at!).getTime()
      const endIso = hfxToIso(addDaysISO(e.date, d.dDays), e.minutes + d.dMin)
      const end = new Date(endIso).getTime() < sMs + 15 * 60_000 ? new Date(sMs + 15 * 60_000).toISOString() : endIso
      return { start_date: r.start_date, end_date: hfxParts(new Date(new Date(end).getTime() - 60_000).toISOString()).date, start_at: r.start_at, end_at: end }
    }
    const start = hfxToIso(addDaysISO(s.date, d.dDays), s.minutes + minutes)
    const end = hfxToIso(addDaysISO(e.date, d.dDays), e.minutes + minutes)
    return { start_date: hfxParts(start).date, end_date: hfxParts(new Date(new Date(end).getTime() - 60_000).toISOString()).date, start_at: start, end_at: end }
  }
  if (d.mode === 'resize') {
    const end = addDaysISO(r.end_date, d.dDays)
    return { start_date: r.start_date, end_date: end < r.start_date ? r.start_date : end, start_at: null, end_at: null }
  }
  return { start_date: addDaysISO(r.start_date, d.dDays), end_date: addDaysISO(r.end_date, d.dDays), start_at: null, end_at: null }
}

/** Technician calendar: day, week and month views like a phone calendar; training visits, service calls, travel days and own entries. */
export default function CalendarPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { can, canAny } = usePermissions()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const seesAll = can('service.calendar.all')
  const manage = can('service.calendar.manage', 'edit')
  const canAdd = canAny(['service.calendar.add', 'service.calendar.manage'], 'edit')
  // Phones open on one day; the choice is kept in the address.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640
  const v = params.get('view')
  const view: View = v === 'day' || v === 'week' || v === 'month' ? v : narrow ? 'day' : 'month'
  const anchorISO = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : todayISO()
  const anchor = useMemo(() => parseISO(anchorISO), [anchorISO])
  const tech = seesAll ? (params.get('tech') ?? '') : me // '' = all technicians
  const [rows, setRows] = useState<CalendarRow[]>([])
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ entry: ManualEntry | null; preset: EntryPreset | null } | null>(null)
  const [phoneEntry, setPhoneEntry] = useState<CalendarRow | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Calendar Connection: open from the address (settings search, Settings page link).
  const find = params.get('find')
  const [connection, setConnection] = useState(() => !!params.get('connection') || find === 'calendar-import' || find === 'calendar-feed')
  const [openPart, setOpenPart] = useState<'import' | 'feed' | null>(() => (find === 'calendar-import' ? 'import' : find === 'calendar-feed' ? 'feed' : null))
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
  const [importVersion, setImportVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const mayImport = can('service.calendar.import', 'edit')

  const loadImport = useCallback(async () => {
    if (!supabase || !me || !mayImport) return
    const { data } = await supabase.from('calendar_imports').select('status, last_error, last_synced_at').eq('user_email', me).maybeSingle()
    setImportStatus((data as ImportStatus | null) ?? null)
  }, [me, mayImport])
  useEffect(() => {
    // loadImport() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    loadImport()
  }, [loadImport])

  const [from, to] = useMemo(() => {
    if (view === 'day') return [anchor, anchor]
    if (view === 'week') return [startOfWeek(anchor, { weekStartsOn: 1 }), endOfWeek(anchor, { weekStartsOn: 1 })]
    return [startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }), endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 })]
  }, [view, anchor])

  const set = useCallback(
    (patch: Record<string, string>) =>
      setParams(
        (p) => {
          for (const [k, val] of Object.entries(patch)) {
            if (val) p.set(k, val)
            else p.delete(k)
          }
          return p
        },
        { replace: true },
      ),
    [setParams],
  )

  const load = useCallback(async () => {
    if (!supabase || (!tech && !seesAll && !me)) return
    setLoading(true)
    // The mini month needs the whole month around the date too.
    const a = iso(from < startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }) ? from : startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }))
    const b = iso(to > endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 }) ? to : endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 }))
    const { data, error } = await supabase.rpc('calendar_entries', { p_from: a, p_to: b, p_tech: tech || null })
    setLoading(false)
    if (error) return toast.error(friendlyError(error))
    setRows((data as CalendarRow[] | null) ?? [])
  }, [from, to, anchor, tech, seesAll, me])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  useEffect(() => {
    supabase?.rpc('technician_choices').then(({ data }) => setPeople((data as { email: string; name: string }[] | null) ?? []))
  }, [])

  async function refreshPhone() {
    setRefreshing(true)
    const r = await callFunction<{ message?: string }>('calendar-import', { action: 'sync_mine' })
    setRefreshing(false)
    if (!r.ok) toast.error(r.message)
    else toast.success(r.message || 'Phone calendar read.')
    setImportVersion((n) => n + 1)
    loadImport()
    load()
  }

  // ---------- Who may change what ----------
  const canDrag = useCallback(
    (r: CalendarRow) => {
      if (r.source === 'manual') return manage || (r.tech_email === me && can('service.calendar.add', 'edit'))
      if (r.source === 'service_call') return can('service.calls.edit', 'edit')
      if (r.source === 'training') return can('order.field.service_dates', 'edit')
      return false
    },
    [manage, me, can],
  )

  async function openRow(r: CalendarRow) {
    if (!supabase) return
    if (r.source === 'phone') return setPhoneEntry(r)
    if (r.source === 'manual') {
      const { data, error } = await supabase.from('tech_calendar_entries').select('*').eq('id', r.source_id).maybeSingle()
      if (error || !data) return toast.error(error ? friendlyError(error) : 'That entry could not be found.')
      return setEditing({ entry: data as ManualEntry, preset: null })
    }
    if (r.link) navigate(r.link)
  }

  async function save(r: CalendarRow, c: Change) {
    if (!supabase) return
    // Show it in the new place at once; the database answer follows.
    setRows((list) => list.map((x) => (rowKey(x) === rowKey(r) ? { ...x, ...c } : x)))
    let error: { message: string } | null = null
    if (r.source === 'manual') {
      const patch = c.start_at ? { starts_at: c.start_at, ends_at: c.end_at } : { start_date: c.start_date, end_date: c.end_date }
      ;({ error } = await supabase.from('tech_calendar_entries').update(patch).eq('id', r.source_id))
    } else if (r.source === 'service_call') {
      ;({ error } = await supabase.rpc('update_service_call', { p_card: r.source_id, p: { planned_start: c.start_date, planned_end: c.end_date } }))
    } else if (r.source === 'training') {
      ;({ error } = await supabase.from('orders').update({ service_start: c.start_date, service_end: c.end_date }).eq('id', r.source_id))
    }
    if (error) toast.error(friendlyError(error))
    else toast.success(r.source === 'training' ? 'Training dates changed.' : r.source === 'service_call' ? 'Service call dates changed.' : 'Calendar entry changed.')
    load()
  }

  // ---------- Pointer: click, drag to move, drag the edge, drag on an empty time ----------
  const dragRef = useRef<Drag | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const suppressClick = useRef(false)
  const holdTimer = useRef<number | null>(null)

  const under = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const cell = el?.closest<HTMLElement>('[data-day]')
    if (!cell) return null
    const rect = cell.getBoundingClientRect()
    return { day: cell.dataset.day!, time: cell.dataset.area === 'time', minutes: (y - rect.top) / PX_PER_MIN }
  }

  const finish = useCallback(() => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
    dragRef.current = null
    setDrag(null)
  }, [])

  const onMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const far = Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6
    if (d.touch && !d.active) {
      // A finger moving before the hold = scrolling the page.
      if (far) {
        if (holdTimer.current) window.clearTimeout(holdTimer.current)
        dragRef.current = null
      }
      return
    }
    if (!d.allowed || (!far && !d.moved)) return
    // Near the top or bottom of the hours box: scroll it.
    const box = document.querySelector<HTMLElement>('[data-cal-scroll]')
    if (box) {
      const r = box.getBoundingClientRect()
      if (e.clientY > r.bottom - 28) box.scrollTop += 16
      else if (e.clientY < r.top + 28 && e.clientY > r.top - 60) box.scrollTop -= 16
    }
    const h = under(e.clientX, Math.min(e.clientY, window.innerHeight - 2))
    const next: Drag = { ...d, moved: true }
    if (h) {
      next.dDays = differenceInCalendarDays(parseISO(h.day), parseISO(d.day0))
      next.dMin = h.time && d.min0 >= 0 ? snap(clampMin(h.minutes)) - snap(d.min0) : 0
      if (d.mode === 'create' && !h.time) next.dMin = 0
    }
    dragRef.current = next
    setDrag(next)
  }, [])

  const onUp = useCallback(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    const d = dragRef.current
    finish()
    if (!d || !d.moved || !d.allowed) return
    suppressClick.current = true
    window.setTimeout(() => (suppressClick.current = false), 0)
    if (d.mode === 'create') {
      // A chosen time range (same day) for a new entry.
      const a = snap(d.min0, 30)
      const b = snap(clampMin(d.min0 + d.dMin))
      const [s, e] = b >= a ? [a, Math.max(b, a + 15)] : [b, a]
      setEditing({ entry: null, preset: { start_date: d.day0, end_date: d.day0, all_day: false, start_min: s, end_min: Math.min(e, 1439) } })
      return
    }
    if (d.row && (d.dDays || d.dMin)) save(d.row, moved(d.row, d))
    // save() is defined in the component and only reads stable setters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [onMove, finish])

  const start = (e: ReactPointerEvent, base: Omit<Drag, 'x0' | 'y0' | 'touch' | 'active' | 'dDays' | 'dMin' | 'moved'>) => {
    if (e.button !== 0) return
    const touch = e.pointerType === 'touch'
    const d: Drag = { ...base, x0: e.clientX, y0: e.clientY, touch, active: !touch, dDays: 0, dMin: 0, moved: false }
    dragRef.current = d
    if (touch && d.allowed) {
      holdTimer.current = window.setTimeout(() => {
        if (dragRef.current === d) {
          d.active = true
          navigator.vibrate?.(10)
          setDrag({ ...d })
        }
      }, 350)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // While dragging with a finger, the page must not scroll.
  useEffect(() => {
    const stop = (e: TouchEvent) => {
      if (dragRef.current?.active && dragRef.current.allowed) e.preventDefault()
    }
    document.addEventListener('touchmove', stop, { passive: false })
    return () => document.removeEventListener('touchmove', stop)
  }, [])

  const viewProps: ViewProps = {
    rows: rows.map((r) => (drag && drag.row && drag.moved && rowKey(r) === drag.key ? { ...r, ...moved(r, drag) } : r)),
    showTech: !tech,
    draggingKey: drag?.moved && drag.row ? drag.key : null,
    canDrag,
    canCreate: canAdd,
    onChipPointerDown: (e, r, mode) => {
      const h = under(e.clientX, e.clientY)
      start(e, { key: rowKey(r), row: r, mode, allowed: canDrag(r), day0: h?.day ?? r.start_date, min0: h?.time ? h.minutes : -1 })
    },
    onChipClick: (r) => {
      if (suppressClick.current) return
      openRow(r)
    },
    onEmptyPointerDown: (e, day, minutes) => {
      if (minutes === null) return
      start(e, { key: 'new', row: null, mode: 'create', allowed: canAdd, day0: day, min0: minutes })
    },
    onEmptyClick: (day, minutes) => {
      if (suppressClick.current || !canAdd) return
      if (minutes === null) return setEditing({ entry: null, preset: { start_date: day, end_date: day, all_day: true } })
      const s = Math.min(Math.floor(minutes / 30) * 30, 23 * 60)
      setEditing({ entry: null, preset: { start_date: day, end_date: day, all_day: false, start_min: s, end_min: s + 60 } })
    },
  }
  const createGhost =
    drag && drag.mode === 'create' && drag.moved
      ? (() => {
          const a = snap(drag.min0, 30)
          const b = snap(clampMin(drag.min0 + drag.dMin))
          return { day: drag.day0, from: Math.min(a, b), to: Math.max(a + 15, b) }
        })()
      : null

  // ---------- Toolbar ----------
  const step = (dir: -1 | 1) => set({ date: iso(view === 'day' ? addDays(anchor, dir) : view === 'week' ? addWeeks(anchor, dir) : addMonths(anchor, dir)) })
  const title =
    view === 'day'
      ? format(anchor, 'EEEE, MMMM d, yyyy')
      : view === 'week'
        ? `${format(from, 'MMM d')} – ${format(to, 'MMM d, yyyy')}`
        : format(anchor, 'MMMM yyyy')
  const days = useMemo(() => {
    const out: string[] = []
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(iso(d))
    return out
  }, [from, to])
  const marked = useMemo(() => {
    const s = new Set<string>()
    for (const r of rows) for (let d = r.start_date; d <= r.end_date && s.size < 2000; d = addDaysISO(d, 1)) s.add(d)
    return s
  }, [rows])
  const pick = (day: string) => {
    set({ date: day === todayISO() ? '' : day })
    setPickerOpen(false)
  }
  const goDay = (day: string) => {
    if (can('service.calendar.navigate')) set({ view: 'day', date: day })
  }

  const legend = (
    <Can permission="service.calendar">
    <ul className="space-y-1.5 text-xs" aria-label="Colours">
      {(Object.keys(CALENDAR_KINDS) as CalendarKind[]).map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span className={`h-3 w-3 rounded-full ${CALENDAR_KINDS[k].dot}`} aria-hidden="true" />
          {CALENDAR_KINDS[k].label}
        </li>
      ))}
      <li className="flex items-center gap-1.5 text-slate-600">
        <Icon name="phone" className="h-3.5 w-3.5" /> From the technician’s phone calendar
      </li>
      {!tech && <li className="text-slate-500">Initials = technician</li>}
    </ul>
    </Can>
  )

  return (
    <Can permission="service.calendar">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Link to="/service" className="text-sm text-slate-600 underline">
              ← Service / Training
            </Link>
            <h1 className="mt-1 text-2xl font-semibold">Technician Calendar</h1>
            <p className="text-sm text-slate-600">
              Click an empty time or day to add an entry, click an entry to open it, drag it to move it or drag its edge to change its length.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Can anyOf={['service.calendar.sync', 'service.calendar.import']} level="edit">
              <button type="button" className={secondaryButtonClass} aria-expanded={connection} onClick={() => setConnection(!connection)}>
                <Icon name="phone" className="mr-1 inline h-4 w-4 align-[-3px]" />
                Calendar Connection
              </button>
            </Can>
            <Can anyOf={['service.calendar.add', 'service.calendar.manage']} level="edit">
              <button type="button" className={buttonClass} onClick={() => setEditing({ entry: null, preset: { start_date: anchorISO, end_date: anchorISO, all_day: true } })}>
                Add Entry
              </button>
            </Can>
          </div>
        </div>

        {importStatus && (
          <Can permission="service.calendar.import" level="edit">
            <div
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm ${importStatus.status === 'error' ? 'border-red-300 bg-red-50 text-red-900' : 'border-slate-200 bg-white text-slate-700'}`}
              role={importStatus.status === 'error' ? 'alert' : 'status'}
            >
              <Icon name="phone" className="h-4 w-4" />
              <span className="min-w-0">
                {importStatus.status === 'error'
                  ? `Your phone calendar is not being read: ${importStatus.last_error ?? 'the link stopped working.'}`
                  : `Phone calendar last synced ${importStatus.last_synced_at ? when.format(new Date(importStatus.last_synced_at)) : 'not yet'} · checked every 5 minutes`}
              </span>
              <button type="button" className="font-medium underline" disabled={refreshing} onClick={refreshPhone}>
                {refreshing ? 'Reading…' : 'Refresh Now'}
              </button>
              {importStatus.status === 'error' && (
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => {
                    setConnection(true)
                    setOpenPart('import')
                  }}
                >
                  Open Calendar Connection
                </button>
              )}
            </div>
          </Can>
        )}

        {connection && (
          <Can anyOf={['service.calendar.sync', 'service.calendar.import']} level="edit">
            <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-4" aria-label="Calendar connection">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold">Calendar Connection</h2>
                  <p className="text-sm text-slate-600">Connect this calendar with the calendar app on your phone or computer. Open a part to see its link and steps.</p>
                </div>
                <button type="button" className="text-lg leading-none text-slate-500" aria-label="Close" onClick={() => setConnection(false)}>
                  ✕
                </button>
              </div>
              <Can permission="service.calendar.import" level="edit">
                <div data-setting="calendar-import" className="rounded-md border border-slate-200">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                    aria-expanded={openPart === 'import'}
                    onClick={() => setOpenPart(openPart === 'import' ? null : 'import')}
                  >
                    <span className="min-w-0">
                      <span className="font-semibold">{openPart === 'import' ? '▾' : '▸'} From your phone to the app</span>
                      <span className="block text-xs text-slate-600">
                        {!importStatus
                          ? 'Not linked yet.'
                          : importStatus.status === 'error'
                            ? 'The link is not working.'
                            : `Linked · last synced ${importStatus.last_synced_at ? when.format(new Date(importStatus.last_synced_at)) : 'not yet'}`}
                      </span>
                    </span>
                  </button>
                  {openPart === 'import' && (
                    <div className="border-t border-slate-200 p-3">
                      <CalendarImportSettings
                        version={importVersion}
                        onSynced={() => {
                          loadImport()
                          load()
                        }}
                      />
                    </div>
                  )}
                </div>
              </Can>
              <Can permission="service.calendar.sync" level="edit">
                <div data-setting="calendar-feed" className="rounded-md border border-slate-200">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
                    aria-expanded={openPart === 'feed'}
                    onClick={() => setOpenPart(openPart === 'feed' ? null : 'feed')}
                  >
                    <span className="min-w-0">
                      <span className="font-semibold">{openPart === 'feed' ? '▾' : '▸'} From the app to your phone</span>
                      <span className="block text-xs text-slate-600">Your private link that shows these entries in Apple Calendar, Google Calendar or Outlook.</span>
                    </span>
                  </button>
                  {openPart === 'feed' && (
                    <div className="border-t border-slate-200 p-3">
                      <PhoneCalendarSync />
                    </div>
                  )}
                </div>
              </Can>
            </section>
          </Can>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Can permission="service.calendar.navigate">
            <button type="button" className={secondaryButtonClass} onClick={() => set({ date: '' })}>
              Today
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => step(-1)} aria-label="Previous">
              ←
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => step(1)} aria-label="Next">
              →
            </button>
          </Can>
          <h2 className="ml-1 min-w-0 text-lg font-semibold">{title}</h2>
          {loading && <span className="text-xs text-slate-500">Loading…</span>}
          <span className="flex-1" />
          <Can permission="service.calendar.navigate">
            <button type="button" className={`${secondaryButtonClass} lg:hidden`} aria-expanded={pickerOpen} onClick={() => setPickerOpen(!pickerOpen)}>
              Choose a Date
            </button>
            <div className="flex rounded-md border border-slate-300 bg-white p-0.5" role="tablist" aria-label="View">
              {(['day', 'week', 'month'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={view === k}
                  className={`rounded px-3 py-1 text-sm ${view === k ? 'bg-slate-900 text-white' : ''}`}
                  onClick={() => set({ view: k })}
                >
                  {k === 'day' ? 'Day' : k === 'week' ? 'Week' : 'Month'}
                </button>
              ))}
            </div>
          </Can>
          <Can permission="service.calendar.all" fallback={<span className="text-sm text-slate-600">Your calendar</span>}>
            <select aria-label="Technician" className={`${narrowInputClass} w-full sm:w-56`} value={tech} onChange={(e) => set({ tech: e.target.value })}>
              <option value="">All technicians</option>
              {people.map((pp) => (
                <option key={pp.email} value={pp.email}>
                  {pp.name}
                </option>
              ))}
            </select>
          </Can>
        </div>

        {pickerOpen && (
          <Can permission="service.calendar.navigate">
            <div className="max-w-xs lg:hidden">
              <MiniMonth selected={anchorISO} onPick={pick} marked={marked} />
            </div>
          </Can>
        )}

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <aside className="hidden w-60 shrink-0 space-y-4 empty:hidden lg:block">
            <Can permission="service.calendar.navigate">
              <MiniMonth selected={anchorISO} onPick={pick} marked={marked} />
            </Can>
            {legend}
          </aside>
          <div className="min-w-0 flex-1">
            {view === 'month' ? (
              <MonthView anchor={anchor} p={viewProps} onMore={goDay} />
            ) : (
              <TimeGridView days={days} p={viewProps} onDayTitle={goDay} createGhost={createGhost} />
            )}
          </div>
          <div className="lg:hidden">{legend}</div>
        </div>

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
            entry={editing.entry}
            preset={editing.preset}
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
