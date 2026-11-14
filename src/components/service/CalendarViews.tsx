// @permission-scope service.calendar, service.calendar.navigate
// The views of the Technician Calendar (only reachable from CalendarPage, which
// decides who may create, open, move and resize entries).
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, parseISO, startOfMonth, startOfWeek } from 'date-fns'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { hfxParts, minutesLabel } from '../../lib/calendarTime'
import { endOf, HOUR_PX, iso, isTimed, PX_PER_MIN, rowKey, WEEKDAYS } from '../../lib/calendarView'
import { todayISO } from '../../lib/dates'
import { CALENDAR_KINDS, type CalendarKind, type CalendarRow } from '../../lib/service'
import Icon from '../Icon'

const initials = (name: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

/** What the views need from the page. */
export type ViewProps = {
  rows: CalendarRow[]
  showTech: boolean
  /** Entry being dragged (drawn see-through, the pointer passes through it). */
  draggingKey: string | null
  canDrag: (r: CalendarRow) => boolean
  canCreate: boolean
  onChipPointerDown: (e: ReactPointerEvent, r: CalendarRow, mode: 'move' | 'resize') => void
  onChipClick: (r: CalendarRow) => void
  onEmptyPointerDown: (e: ReactPointerEvent, day: string, minutes: number | null) => void
  onEmptyClick: (day: string, minutes: number | null) => void
}

function label(r: CalendarRow) {
  const k = CALENDAR_KINDS[r.kind as CalendarKind] ?? CALENDAR_KINDS.onsite
  const time = r.start_at ? `${minutesLabel(hfxParts(r.start_at).minutes)} – ${minutesLabel(hfxParts(endOf(r)).minutes)} ` : ''
  return `${r.from_phone ? 'From phone · ' : ''}${k.label}: ${time}${r.title}${r.tech_name ? ` (${r.tech_name})` : ''}${r.notes ? ` – ${r.notes}` : ''}`
}

/** One entry. Click opens it; dragging moves it; the handle changes its length. */
function Chip({
  r,
  p,
  className = '',
  style,
  resizeEdge,
  timeText,
}: {
  r: CalendarRow
  p: ViewProps
  className?: string
  style?: React.CSSProperties
  resizeEdge?: 'right' | 'bottom' | null
  timeText?: string
}) {
  const k = CALENDAR_KINDS[r.kind as CalendarKind] ?? CALENDAR_KINDS.onsite
  const drag = p.canDrag(r)
  const dragging = p.draggingKey === rowKey(r)
  return (
    <div
      role="button"
      tabIndex={0}
      title={label(r)}
      aria-label={label(r)}
      data-entry={rowKey(r)}
      className={`group relative rounded px-1.5 py-0.5 text-left text-[11px] leading-tight ring-1 select-none [-webkit-touch-callout:none] ${k.chip} ${
        drag ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${dragging ? 'pointer-events-none opacity-60 shadow-lg' : ''} ${className}`}
      style={style}
      onPointerDown={(e) => {
        e.stopPropagation()
        p.onChipPointerDown(e, r, 'move')
      }}
      onClick={(e) => {
        e.stopPropagation()
        p.onChipClick(r)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          p.onChipClick(r)
        }
      }}
    >
      <span className="block truncate">
        {r.from_phone && <Icon name="phone" className="mr-0.5 inline h-3 w-3 align-[-2px]" label="From phone" />}
        {p.showTech && r.tech_name ? `${initials(r.tech_name)} · ` : ''}
        {timeText && <span className="font-medium">{timeText} </span>}
        {r.title}
      </span>
      {drag && resizeEdge && (
        <span
          aria-hidden="true"
          className={
            resizeEdge === 'right'
              ? 'absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r opacity-0 group-hover:bg-black/15 group-hover:opacity-100'
              : 'absolute inset-x-0 bottom-0 h-2 cursor-ns-resize rounded-b opacity-0 group-hover:bg-black/15 group-hover:opacity-100'
          }
          onPointerDown={(e) => {
            e.stopPropagation()
            p.onChipPointerDown(e, r, 'resize')
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  )
}

const covers = (r: CalendarRow, day: string) => r.start_date <= day && r.end_date >= day
const allDayOn = (rows: CalendarRow[], day: string) => rows.filter((r) => !isTimed(r) && covers(r, day))

/** Month: one cell per day; click an empty part of a day to add an all-day entry. */
export function MonthView({ anchor, p, onMore }: { anchor: Date; p: ViewProps; onMore: (day: string) => void }) {
  const days = useMemo(() => {
    const out: Date[] = []
    for (let d = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }); d <= endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 }); d = addDays(d, 1)) out.push(d)
    return out
  }, [anchor])
  const today = todayISO()
  return (
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
          const day = iso(d)
          const list = p.rows.filter((r) => covers(r, day)).sort((a, b) => Number(isTimed(a)) - Number(isTimed(b)) || (a.start_at ?? '').localeCompare(b.start_at ?? ''))
          return (
            <div
              key={day}
              data-day={day}
              data-area="days"
              className={`min-h-24 min-w-0 border-r border-b border-slate-100 p-1 ${isSameMonth(d, anchor) ? '' : 'bg-slate-50 text-slate-400'} ${p.canCreate ? 'cursor-pointer' : ''}`}
              onPointerDown={(e) => p.onEmptyPointerDown(e, day, null)}
              onClick={() => p.onEmptyClick(day, null)}
            >
              <div className={`mb-1 text-right text-xs ${day === today ? 'font-bold text-blue-700' : ''}`}>
                {day === today ? <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-white">{format(d, 'd')}</span> : format(d, 'd')}
              </div>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((r) => (
                  <Chip
                    key={rowKey(r)}
                    r={r}
                    p={p}
                    resizeEdge={!isTimed(r) && r.end_date === day ? 'right' : null}
                    timeText={r.start_at && hfxParts(r.start_at).date === day ? minutesLabel(hfxParts(r.start_at).minutes) : undefined}
                  />
                ))}
                {list.length > 3 && (
                  <button
                    type="button"
                    className="text-[11px] text-slate-600 underline"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onMore(day)
                    }}
                  >
                    +{list.length - 3} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type Placed = { r: CalendarRow; top: number; bottom: number; lane: number; lanes: number; endsHere: boolean; startsHere: boolean }

/** Timed entries of one day, side by side where they overlap. */
function placeDay(rows: CalendarRow[], day: string): Placed[] {
  const out: Placed[] = []
  for (const r of rows) {
    if (!isTimed(r)) continue
    const s = hfxParts(r.start_at!)
    const endIso = endOf(r)
    const e = hfxParts(endIso)
    const last = hfxParts(new Date(new Date(endIso).getTime() - 60_000).toISOString()).date
    // last = the day of the final minute (an entry ending at midnight ends the day before)
    if (day < s.date || day > last) continue
    const top = s.date === day ? s.minutes : 0
    let bottom = e.date === day ? e.minutes : 1440
    if (bottom <= top) bottom = Math.min(top + 15, 1440)
    out.push({ r, top, bottom, lane: 0, lanes: 1, endsHere: last === day, startsHere: s.date === day })
  }
  out.sort((a, b) => a.top - b.top || b.bottom - a.bottom)
  // Clusters of overlapping entries share the width.
  let cluster: Placed[] = []
  let clusterEnd = -1
  const flush = () => {
    const n = Math.max(1, ...cluster.map((c) => c.lane + 1))
    for (const c of cluster) c.lanes = n
    cluster = []
  }
  for (const pl of out) {
    if (pl.top >= clusterEnd && cluster.length) flush()
    const used = new Set(cluster.filter((c) => c.bottom > pl.top).map((c) => c.lane))
    let lane = 0
    while (used.has(lane)) lane++
    pl.lane = lane
    cluster.push(pl)
    clusterEnd = Math.max(clusterEnd, pl.bottom)
  }
  if (cluster.length) flush()
  return out
}

/** Day and week: all-day entries at the top, a timeline of hours below. */
export function TimeGridView({
  days,
  p,
  onDayTitle,
  createGhost,
}: {
  days: string[]
  p: ViewProps
  onDayTitle: (day: string) => void
  /** The time range being chosen with the pointer for a new entry. */
  createGhost: { day: string; from: number; to: number } | null
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const today = todayISO()
  const [nowMin, setNowMin] = useState(() => hfxParts(new Date().toISOString()).minutes)
  useEffect(() => {
    const t = window.setInterval(() => setNowMin(hfxParts(new Date().toISOString()).minutes), 60_000)
    return () => window.clearInterval(t)
  }, [])
  // Open at 7 a.m. (or a little before the first entry when it is earlier).
  const first = days.length
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX - 8
  }, [first])

  const cols = `3.25rem repeat(${days.length}, minmax(0, 1fr))`
  const wide = days.length > 1
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <div className={wide ? 'min-w-[44rem]' : ''}>
        {/* Day titles */}
        <div className="grid border-b border-slate-200 bg-slate-50" style={{ gridTemplateColumns: cols }}>
          <div />
          {days.map((day) => (
            <button
              key={day}
              type="button"
              className={`border-l border-slate-200 px-1 py-1.5 text-center text-xs ${day === today ? 'font-bold text-blue-700' : 'font-medium text-slate-700'}`}
              onClick={() => onDayTitle(day)}
            >
              {format(parseISO(day), wide ? 'EEE d' : 'EEEE, MMMM d')}
            </button>
          ))}
        </div>
        {/* All-day entries */}
        <div className="grid border-b border-slate-300" style={{ gridTemplateColumns: cols }}>
          <div className="px-1 py-1 text-right text-[10px] text-slate-500">All day</div>
          {days.map((day) => (
            <div
              key={day}
              data-day={day}
              data-area="days"
              className={`min-h-8 min-w-0 space-y-0.5 border-l border-slate-200 p-0.5 ${p.canCreate ? 'cursor-pointer' : ''}`}
              onPointerDown={(e) => p.onEmptyPointerDown(e, day, null)}
              onClick={() => p.onEmptyClick(day, null)}
            >
              {allDayOn(p.rows, day).map((r) => (
                <Chip key={rowKey(r)} r={r} p={p} resizeEdge={r.end_date === day ? 'right' : null} />
              ))}
            </div>
          ))}
        </div>
        {/* Hours */}
        <div ref={scroller} data-cal-scroll="" className="max-h-[65vh] overflow-y-auto">
          <div className="grid" style={{ gridTemplateColumns: cols }}>
            <div className="relative" style={{ height: 24 * HOUR_PX }}>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-slate-500" style={{ top: h * HOUR_PX }}>
                  {h === 0 ? '' : minutesLabel(h * 60)}
                </div>
              ))}
            </div>
            {days.map((day) => (
              <div
                key={day}
                data-day={day}
                data-area="time"
                className={`relative min-w-0 border-l border-slate-200 ${p.canCreate ? 'cursor-pointer' : ''}`}
                style={{
                  height: 24 * HOUR_PX,
                  backgroundImage: `repeating-linear-gradient(to bottom, rgb(148 163 184 / 0.35) 0 1px, transparent 1px ${HOUR_PX / 2}px, rgb(148 163 184 / 0.15) ${HOUR_PX / 2}px ${HOUR_PX / 2 + 1}px, transparent ${HOUR_PX / 2 + 1}px ${HOUR_PX}px)`,
                }}
                onPointerDown={(e) => {
                  const top = e.currentTarget.getBoundingClientRect().top
                  p.onEmptyPointerDown(e, day, (e.clientY - top) / PX_PER_MIN)
                }}
                onClick={(e) => {
                  const top = e.currentTarget.getBoundingClientRect().top
                  p.onEmptyClick(day, (e.clientY - top) / PX_PER_MIN)
                }}
              >
                {placeDay(p.rows, day).map((pl) => (
                  <Chip
                    key={rowKey(pl.r)}
                    r={pl.r}
                    p={p}
                    className="absolute overflow-hidden whitespace-normal"
                    style={{
                      top: pl.top * PX_PER_MIN + 1,
                      height: Math.max((pl.bottom - pl.top) * PX_PER_MIN - 2, 16),
                      left: `calc(${(pl.lane / pl.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / pl.lanes}% - 4px)`,
                    }}
                    resizeEdge={pl.endsHere ? 'bottom' : null}
                    timeText={pl.startsHere ? minutesLabel(pl.top) : undefined}
                  />
                ))}
                {createGhost && createGhost.day === day && (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 rounded bg-blue-500/25 px-1 text-[11px] text-blue-900 ring-1 ring-blue-500"
                    style={{ top: createGhost.from * PX_PER_MIN, height: Math.max((createGhost.to - createGhost.from) * PX_PER_MIN, 12) }}
                  >
                    {minutesLabel(createGhost.from)} – {minutesLabel(createGhost.to)}
                  </div>
                )}
                {day === today && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: nowMin * PX_PER_MIN }} aria-hidden="true">
                    <span className="absolute -top-1.5 -left-1 h-2.5 w-2.5 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** A small month for jumping to a date. Dots mark days with entries. */
export function MiniMonth({ selected, onPick, marked }: { selected: string; onPick: (day: string) => void; marked: Set<string> }) {
  const [month, setMonth] = useState(() => startOfMonth(parseISO(selected)))
  // Follow the calendar when it moves to another month.
  const [lastSelected, setLastSelected] = useState(selected)
  if (selected !== lastSelected) {
    setLastSelected(selected)
    if (!isSameMonth(parseISO(selected), month)) setMonth(startOfMonth(parseISO(selected)))
  }
  const today = todayISO()
  const days: Date[] = []
  for (let d = startOfWeek(month, { weekStartsOn: 1 }); d <= endOfWeek(endOfMonth(month), { weekStartsOn: 1 }); d = addDays(d, 1)) days.push(d)
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2 text-xs" aria-label="Choose a date">
      <div className="mb-1 flex items-center justify-between">
        <button type="button" className="rounded px-2 py-1 hover:bg-slate-100" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          ←
        </button>
        <span className="font-semibold">{format(month, 'MMMM yyyy')}</span>
        <button type="button" className="rounded px-2 py-1 hover:bg-slate-100" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          →
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] text-slate-500">
        {WEEKDAYS.map((d) => (
          <div key={d}>{d.slice(0, 2)}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center">
        {days.map((d) => {
          const day = iso(d)
          const sel = day === selected
          return (
            <button
              key={day}
              type="button"
              aria-label={format(d, 'EEEE, MMMM d, yyyy')}
              aria-pressed={sel}
              className={`relative m-0.5 rounded-full py-1 ${sel ? 'bg-slate-900 font-semibold text-white' : day === today ? 'font-bold text-blue-700' : isSameMonth(d, month) ? 'hover:bg-slate-100' : 'text-slate-400 hover:bg-slate-100'}`}
              onClick={() => onPick(day)}
            >
              {format(d, 'd')}
              {marked.has(day) && !sel && <span className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-blue-500" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
