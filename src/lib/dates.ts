import { format, parseISO, type Locale } from 'date-fns'
import { de, enCA, es, frCA, ru } from 'date-fns/locale'
import { currentLang } from '../i18n'

const DATE_LOCALES: Record<string, Locale> = { 'en-CA': enCA, 'fr-CA': frCA, es, ru, de }

/** date-fns format in the language people chose ("Feb 1, 2027" / "1 févr. 2027"). */
export function formatDate(date: Date | number, pattern: string) {
  return format(date, pattern, { locale: DATE_LOCALES[currentLang()] ?? enCA })
}

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
  return iso ? formatDate(parseISO(iso), pattern) : '—'
}
