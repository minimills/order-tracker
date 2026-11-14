// Times on the Technician Calendar are always shown and entered in Halifax time.

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Halifax',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function read(ms: number) {
  const p: Record<string, string> = {}
  for (const x of parts.formatToParts(new Date(ms))) p[x.type] = x.value
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute }
}

/** The Halifax day (YYYY-MM-DD) and minutes after midnight of a moment. */
export function hfxParts(iso: string) {
  const t = read(new Date(iso).getTime())
  return { date: `${t.y}-${String(t.mo).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`, minutes: t.h * 60 + t.mi }
}

/** Halifax minus UTC, in minutes, at a moment. */
function offset(ms: number) {
  const t = read(ms)
  return (Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi) - Math.floor(ms / 60000) * 60000) / 60000
}

/** The moment of a Halifax day + minutes after midnight (minutes may be 1440 or more). */
export function hfxToIso(date: string, minutes: number) {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 0, minutes)
  let t = guess - offset(guess) * 60000
  const again = guess - offset(t) * 60000
  if (again !== t) t = again
  return new Date(t).toISOString()
}

/** "13:30" for an <input type="time"> from minutes after midnight. */
export const minutesToInput = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
export const inputToMinutes = (v: string) => {
  const [h, m] = v.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** "9 a.m.", "1:30 p.m." */
export function minutesLabel(m: number) {
  const h = Math.floor(m / 60) % 24
  const mi = m % 60
  const suffix = h < 12 ? 'a.m.' : 'p.m.'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return mi ? `${h12}:${String(mi).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`
}
