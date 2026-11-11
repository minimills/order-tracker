import { addDaysISO, showDate, todayISO } from './dates'
import { showTime } from './service'
import { supabase } from './supabase'

export type Rsvp = 'going' | 'not_going' | 'maybe'
export type EventColour = 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'teal' | 'slate'
/** One event as my_company_events() returns it. */
export type CompanyEvent = {
  id: string
  title: string
  description: string
  description_text: string
  location: string | null
  all_day: boolean
  starts_at: string | null
  ends_at: string | null
  start_date: string
  end_date: string
  colour: EventColour | null
  audience_everyone: boolean
  rsvp_enabled: boolean
  remind_minutes: number[]
  organizer_email: string | null
  organizer_name: string | null
  edited_at: string | null
  archived: boolean
  created_at: string
  going: number
  maybe: number
  not_going: number
  my_response: Rsvp | null
  can_manage: boolean
}
export type RsvpRow = { email: string; name: string; response: Rsvp | null; responded_at: string | null }

/** Category colours (a stripe on the left of the event). */
export const EVENT_COLOURS: { value: EventColour; label: string; stripe: string }[] = [
  { value: 'blue', label: 'Blue', stripe: '#2a78d6' },
  { value: 'green', label: 'Green', stripe: '#2f9e5b' },
  { value: 'amber', label: 'Amber', stripe: '#d99a12' },
  { value: 'red', label: 'Red', stripe: '#d64545' },
  { value: 'purple', label: 'Purple', stripe: '#7c5cd6' },
  { value: 'teal', label: 'Teal', stripe: '#1f9aa3' },
  { value: 'slate', label: 'Grey', stripe: '#64748b' },
]
export const stripeOf = (c: EventColour | null) => EVENT_COLOURS.find((x) => x.value === c)?.stripe ?? '#cbd5e1'

export const RSVP_LABEL: Record<Rsvp, string> = { going: 'Going', maybe: 'Maybe', not_going: 'Not going' }

/** Reminder choices (minutes before the start). */
export const REMINDER_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 10080, label: '1 week before' },
  { minutes: 2880, label: '2 days before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 15, label: '15 minutes before' },
]

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)

/** "Today 2:00 p.m.", "Tomorrow 9:00 a.m.", "in 5 days", "Now, until Nov 18". `today` = on today. */
export function countdown(e: Pick<CompanyEvent, 'all_day' | 'starts_at' | 'start_date' | 'end_date'>, today = todayISO()) {
  const time = !e.all_day && e.starts_at ? ` ${showTime(e.starts_at)}` : ''
  if (e.start_date <= today && e.end_date >= today) {
    if (e.start_date === today) return { text: `Today${time}`, today: true }
    return { text: `Now, until ${showDate(e.end_date, 'MMM d')}`, today: true }
  }
  const n = dayDiff(today, e.start_date)
  if (n === 1) return { text: `Tomorrow${time}`, today: false }
  if (n < 0) return { text: showDate(e.start_date, 'MMM d, yyyy'), today: false }
  return { text: `in ${n} days`, today: false }
}

/** "Thu, Nov 12, 2:00 – 4:00 p.m." / "Mon, Nov 16 – Wed, Nov 18" / "Fri, Nov 20 (all day)". */
export function whenText(e: Pick<CompanyEvent, 'all_day' | 'starts_at' | 'ends_at' | 'start_date' | 'end_date'>) {
  const day = (iso: string) => showDate(iso, 'EEE, MMM d')
  if (e.all_day) return e.start_date === e.end_date ? `${day(e.start_date)} (all day)` : `${day(e.start_date)} – ${day(e.end_date)}`
  const start = `${day(e.start_date)}, ${showTime(e.starts_at!)}`
  if (!e.ends_at) return start
  return e.start_date === e.end_date ? `${start} – ${showTime(e.ends_at)}` : `${start} – ${day(e.end_date)}, ${showTime(e.ends_at)}`
}

/** My events: upcoming (not over, not cancelled) or past (Archive). */
export async function loadEvents(past: boolean) {
  if (!supabase) return [] as CompanyEvent[]
  const { data, error } = await supabase.rpc('my_company_events', { p_past: past })
  if (error) throw error
  return (data as CompanyEvent[]) ?? []
}

// ---------------------------------------------------------------------------
// Add to my calendar
// ---------------------------------------------------------------------------
const utc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const compact = (d: string) => d.replace(/-/g, '')
/** Text for a calendar file field (commas, semicolons and new lines escaped; lines folded). */
function icsText(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}
function fold(line: string) {
  const out: string[] = []
  let rest = line
  while (rest.length > 74) {
    out.push(rest.slice(0, 74))
    rest = ' ' + rest.slice(74)
  }
  out.push(rest)
  return out.join('\r\n')
}

/** A calendar file (.ics) for one event: opens in Apple Calendar and Outlook. */
export function eventIcs(e: CompanyEvent, company: string) {
  const end = e.ends_at ?? (e.starts_at ? new Date(Date.parse(e.starts_at) + 3_600_000).toISOString() : null)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${icsText(company)}//Order Tracker//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${e.id}@order-tracker`,
    `DTSTAMP:${utc(new Date().toISOString())}`,
    ...(e.all_day
      ? [`DTSTART;VALUE=DATE:${compact(e.start_date)}`, `DTEND;VALUE=DATE:${compact(addDaysISO(e.end_date, 1))}`]
      : [`DTSTART:${utc(e.starts_at!)}`, `DTEND:${utc(end!)}`]),
    `SUMMARY:${icsText(e.title)}`,
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    ...(e.description_text ? [`DESCRIPTION:${icsText(e.description_text)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** Saves the calendar file (the computer opens it with its calendar app). */
export function downloadIcs(e: CompanyEvent, company: string) {
  const blob = new Blob([eventIcs(e, company)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${e.title.replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'event'}.ics`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A Google Calendar "add this event" address. */
export function googleCalendarUrl(e: CompanyEvent) {
  const end = e.ends_at ?? (e.starts_at ? new Date(Date.parse(e.starts_at) + 3_600_000).toISOString() : null)
  const dates = e.all_day ? `${compact(e.start_date)}/${compact(addDaysISO(e.end_date, 1))}` : `${utc(e.starts_at!)}/${utc(end!)}`
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates, details: e.description_text, location: e.location ?? '', ctz: 'America/Halifax' })
  return `https://calendar.google.com/calendar/render?${q}`
}
