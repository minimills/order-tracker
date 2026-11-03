import { format, parseISO } from 'date-fns'

/** Today's date in Halifax time, as YYYY-MM-DD. */
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax' }).format(new Date())
}

/** YYYY-MM-DD date `days` after (or before, if negative) the given one. */
export function addDaysISO(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** "Feb 1, 2027", or a dash when empty. */
export function showDate(iso: string | null | undefined, pattern = 'MMM d, yyyy') {
  return iso ? format(parseISO(iso), pattern) : '—'
}
