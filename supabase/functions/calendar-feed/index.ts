// Supabase Edge Function "calendar-feed": a technician's private calendar link.
//
//   GET …/functions/v1/calendar-feed?token=<the private token>
//
// Answers with an iCal (.ics) calendar of the technician's training visits,
// service calls, travel days and own entries (120 days back, 400 days ahead).
// Apple Calendar, Google Calendar and Outlook subscribe to this link and
// refresh it by themselves. It is one-way: changes made in the phone calendar
// do not come back to the app.
//
// "Verify JWT" must be OFF: calendar apps cannot sign in. The token is the
// only key; it is checked by the database (calendar_feed()), and a technician
// can reset it in the app (the old link then stops working).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Optional secret APP_URL (default https://order.minimills.net) for links in the events.
import { createClient } from 'npm:@supabase/supabase-js@2'

// deno-lint-ignore no-explicit-any
type Any = any
type Env = (key: string) => string | undefined
export type Row = {
  source: string
  source_id: string
  tech_email: string
  tech_name: string | null
  kind: string
  start_date: string
  end_date: string
  title: string
  customer: string | null
  country: string | null
  notes: string | null
  link: string | null
}

const KIND_WORD: Record<string, string> = { training: 'Training visit', service: 'Service call', travel: 'Travel day', onsite: 'On site' }

/** Text value escaping (RFC 5545 3.3.11). */
export const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** Lines longer than 75 bytes are folded (continuation lines start with a space). */
export function fold(line: string) {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const out: string[] = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  out.push(current)
  return out.join('\r\n ')
}

const day = (iso: string) => iso.replace(/-/g, '')
function nextDay(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** The whole calendar. All-day events; the end date is the day after (iCal rule). */
export function buildIcs(rows: Row[], o: { calendarName: string; appUrl: string; now: Date }) {
  const stamp = o.now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Belfast Mini Mills//Order Tracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(o.calendarName)}`,
    'X-WR-TIMEZONE:America/Halifax',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ]
  for (const r of rows) {
    const description = [
      KIND_WORD[r.kind] ?? r.kind,
      r.customer ? `Customer: ${r.customer}` : '',
      r.notes ? `Notes: ${r.notes}` : '',
      r.link ? `Open in the Order Tracker: ${o.appUrl}/#${r.link}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.source}-${r.source_id}@order-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(r.start_date)}`,
      `DTEND;VALUE=DATE:${day(nextDay(r.end_date))}`,
      `SUMMARY:${icsText(r.title)}`,
      `DESCRIPTION:${icsText(description)}`,
      ...(r.country ? [`LOCATION:${icsText(r.country)}`] : []),
      ...(r.link ? [`URL:${o.appUrl}/#${r.link}`] : []),
      `CATEGORIES:${icsText(KIND_WORD[r.kind] ?? r.kind)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

export async function handle(req: Request, deps: { env: Env; makeClient: (url: string, key: string, options?: Any) => Any; now?: () => Date }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Use GET.', { status: 405 })
  const url = deps.env('SUPABASE_URL')
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return new Response('The calendar is not set up.', { status: 500 })
  const token = new URL(req.url).searchParams.get('token') ?? ''
  if (!/^[a-f0-9]{32,128}$/.test(token)) return new Response('This calendar link is not valid.', { status: 404 })
  const db = deps.makeClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await db.rpc('calendar_feed', { p_token: token })
  if (error) return new Response('The calendar could not be loaded. Try again later.', { status: 503 })
  const rows = (data ?? []) as Row[]
  if (!rows.length) {
    // Unknown link (or reset): say so plainly; a valid link with no entries still gets an empty calendar.
    const { data: known } = await db.from('calendar_feeds').select('user_email').eq('token', token).maybeSingle()
    if (!known) return new Response('This calendar link is not valid. It may have been reset in the Order Tracker.', { status: 404 })
  }
  const { data: company } = await db.from('app_settings').select('value').eq('key', 'company').maybeSingle()
  const name = (company?.value?.name as string) || 'Belfast Mini Mills'
  const who = rows[0]?.tech_name
  const ics = buildIcs(rows, {
    calendarName: who ? `${name} – ${who}` : name,
    appUrl: (deps.env('APP_URL') || 'https://order.minimills.net').replace(/\/+$/, ''),
    now: (deps.now ?? (() => new Date()))(),
  })
  return new Response(req.method === 'HEAD' ? null : ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="order-tracker.ics"',
      'Cache-Control': 'private, max-age=900',
    },
  })
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno
if (D?.serve) {
  const env: Env = (k) => D.env.get(k)
  D.serve((req: Request) => handle(req, { env, makeClient: createClient }))
}
