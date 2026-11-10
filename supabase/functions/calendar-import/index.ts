// Supabase Edge Function "calendar-import": reads each technician's own phone
// calendar link (iCal / ICS, for example an Apple iCloud public calendar or a
// Google Calendar "Secret address in iCal format") and hands the entries to the
// database (apply_phone_events), which adds, updates or removes them in the
// app's technician calendar as "From phone".
//
// Actions (POST JSON { action }):
//   sync_all  – every linked calendar; called every 15 minutes by the database
//               scheduler with the x-dispatch-key header (Admin → Email →
//               Turn On Automatic Sending also starts this job)
//   sync_mine – the signed-in technician's own link ("Sync Now" in Settings)
//
// "Verify JWT" must be OFF: the scheduler has no login (the function checks
// every caller itself). SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. No other secrets.
// One-way only: nothing is ever written to the phone calendar.
import { createClient } from 'npm:@supabase/supabase-js@2'
import ICAL from 'npm:ical.js@2.2.1'

// deno-lint-ignore no-explicit-any
type Any = any
type Env = (key: string) => string | undefined
export type PhoneEvent = {
  key: string
  title: string
  location: string | null
  description: string | null
  all_day: boolean
  start_at: string | null
  start_date: string
  end_date: string
}
export type Deps = {
  env: Env
  makeClient: (url: string, key: string, options?: Any) => Any
  fetch?: typeof fetch
  now?: () => Date
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const MAX_BYTES = 5 * 1024 * 1024
const BACK_DAYS = 120
const AHEAD_DAYS = 400
const MAX_REPEATS = 500
const halifaxDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax' })
const pad = (n: number) => String(n).padStart(2, '0')

/** The calendar day of an iCal time: all-day and "floating" times as written, others in Halifax time. */
function dayOf(t: Any): string {
  if (t.isDate || !t.zone || t.zone.tzid === 'floating') return `${t.year}-${pad(t.month)}-${pad(t.day)}`
  return halifaxDay.format(t.toJSDate())
}

/** One occurrence → the row the database expects. End dates are inclusive (iCal's end is exclusive). */
function toRow(key: string, item: Any, start: Any, end: Any | null): PhoneEvent {
  const allDay = Boolean(start.isDate)
  const startDate = dayOf(start)
  let endDate = startDate
  if (end) {
    const e = end.clone()
    if (allDay) e.adjust(-1, 0, 0, 0)
    else e.adjust(0, 0, 0, -1)
    endDate = dayOf(e)
    if (endDate < startDate) endDate = startDate
  }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    key,
    title: text(item.summary) ?? '(no title)',
    location: text(item.location),
    description: text(item.description),
    all_day: allDay,
    start_at: allDay ? null : start.zone?.tzid === 'floating' ? null : start.toJSDate().toISOString(),
    start_date: startDate,
    end_date: endDate,
  }
}

/** Reads an iCal file: single and repeating events in the window, cancelled ones left out. */
export function readCalendar(text: string, now: Date): PhoneEvent[] {
  const root = new ICAL.Component(ICAL.parse(text))
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz)
    } catch {
      // a broken time zone block: its events are read as written
    }
  }
  const from = ICAL.Time.fromJSDate(new Date(now.getTime() - BACK_DAYS * 86_400_000), true)
  const to = ICAL.Time.fromJSDate(new Date(now.getTime() + AHEAD_DAYS * 86_400_000), true)
  const all = root.getAllSubcomponents('vevent').map((c: Any) => new ICAL.Event(c))
  const masters = new Map<string, Any>()
  for (const ev of all) if (!ev.isRecurrenceException()) masters.set(ev.uid, ev)
  for (const ev of all) if (ev.isRecurrenceException() && masters.has(ev.uid)) masters.get(ev.uid).relateException(ev)

  const out: PhoneEvent[] = []
  const cancelled = (c: Any) => String(c.getFirstPropertyValue?.('status') ?? '').toUpperCase() === 'CANCELLED'
  for (const ev of all) {
    if (!ev.uid || !ev.startDate) continue
    if (ev.isRecurrenceException()) {
      // An edited repeat whose series is not in the file: keep it as a single entry.
      if (masters.has(ev.uid) || cancelled(ev.component)) continue
      if (ev.startDate.compare(to) > 0 || (ev.endDate ?? ev.startDate).compare(from) < 0) continue
      out.push(toRow(`${ev.uid}|${ev.recurrenceId.toString()}`, ev, ev.startDate, ev.endDate))
      continue
    }
    if (cancelled(ev.component)) continue
    if (!ev.isRecurring()) {
      if (ev.startDate.compare(to) > 0 || (ev.endDate ?? ev.startDate).compare(from) < 0) continue
      out.push(toRow(ev.uid, ev, ev.startDate, ev.endDate))
      continue
    }
    const it = ev.iterator()
    let n = 0
    for (let next = it.next(); next && n < MAX_REPEATS; next = it.next()) {
      if (next.compare(to) > 0) break
      const d = ev.getOccurrenceDetails(next)
      if (d.endDate.compare(from) < 0) continue
      if (cancelled(d.item.component)) continue
      n++
      out.push(toRow(`${ev.uid}|${d.recurrenceId.toString()}`, d.item, d.startDate, d.endDate))
    }
  }
  return out
}

/** Plain-words reason when a link cannot be read (shown to the technician in Settings). */
function problem(status: number) {
  if (status === 404 || status === 410) {
    return 'The calendar link no longer works. The calendar may have been deleted, made private, or its link reset. Copy the link again and paste it in Settings → Calendar.'
  }
  if (status === 401 || status === 403) {
    return 'The calendar is no longer shared. Turn sharing on again (Apple: Public Calendar; Google: copy the secret address again) and paste the new link.'
  }
  return `The calendar could not be read (the calendar service answered with error ${status}). It will be tried again in 15 minutes.`
}

/** Fetches and reads one link; returns the events, or a plain-words error. */
export async function readLink(url: string, deps: Deps): Promise<{ events: PhoneEvent[] } | { error: string }> {
  const f = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await f(url, { headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'OrderTracker-Calendar/1.0' }, signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) return { error: problem(res.status) }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) return { error: 'The calendar is too large to read (over 5 MB). Use a separate calendar just for work.' }
    const text = new TextDecoder().decode(buf)
    if (!/^\s*BEGIN:VCALENDAR/i.test(text)) return { error: 'This link does not lead to a calendar file. Copy the calendar link again (Apple: Share Link; Google: Secret address in iCal format).' }
    try {
      return { events: readCalendar(text, (deps.now ?? (() => new Date()))()) }
    } catch {
      return { error: 'The calendar file could not be read. Try copying the link again.' }
    }
  } catch (e) {
    return {
      error:
        (e as Error).name === 'AbortError'
          ? 'The calendar service did not answer in time. It will be tried again in 15 minutes.'
          : 'The calendar link could not be reached. Check that the whole link was copied. It will be tried again in 15 minutes.',
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const url = deps.env('SUPABASE_URL')
  const anonKey = deps.env('SUPABASE_ANON_KEY')
  const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return reply(500, { error: 'The function is missing its Supabase settings.' })
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const db = deps.makeClient(url, serviceKey, noSession)
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    return reply(400, { error: 'Bad request.' })
  }

  let only: string | null = null
  if (body.action === 'sync_all') {
    const { data } = await db.rpc('check_dispatch_key', { p_key: req.headers.get('x-dispatch-key') ?? '' })
    if (data !== true) return reply(401, { error: 'Unknown dispatch key.' })
  } else if (body.action === 'sync_mine') {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return reply(401, { error: 'Please sign in again.' })
    const caller = deps.makeClient(url, anonKey, { ...noSession, global: { headers: { Authorization: auth } } })
    const { data: who, error } = await caller.auth.getUser(auth.slice(7))
    if (error || !who?.user?.email) return reply(401, { error: 'Please sign in again.' })
    const { data: allowed } = await caller.rpc('has_perm', { p_key: 'service.calendar.import', p_level: 'edit' })
    if (allowed !== true) return reply(403, { error: 'You do not have permission to link a phone calendar.' })
    only = String(who.user.email).toLowerCase()
  } else {
    return reply(400, { error: 'Unknown action.' })
  }

  const { data: due, error: dueError } = await db.rpc('calendar_imports_due', { p_email: only })
  if (dueError) return reply(500, { error: 'The linked calendars could not be loaded.' })
  const results: Record<string, unknown>[] = []
  for (const row of (due ?? []) as { user_email: string; url: string }[]) {
    const r = await readLink(row.url, deps)
    const { data } = await db.rpc('apply_phone_events', {
      p_email: row.user_email,
      p_url: row.url,
      p_events: 'events' in r ? r.events : null,
      p_error: 'error' in r ? r.error : null,
    })
    results.push({ user: row.user_email, ...(data ?? {}), ...('events' in r ? { events: r.events.length } : {}) })
  }
  if (only) {
    const mine = results[0]
    if (!mine) return reply(404, { error: 'No phone calendar is linked yet.' })
    if (mine.error) return reply(502, { error: String(mine.error) })
    return reply(200, { ok: true, message: `Phone calendar read: ${mine.events ?? 0} entries.` })
  }
  return reply(200, { ok: true, calendars: results.length, results })
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno
if (D?.serve) {
  const env: Env = (k) => D.env.get(k)
  D.serve((req: Request) => handle(req, { env, makeClient: createClient }))
}
