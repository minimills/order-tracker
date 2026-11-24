/**
 * Import of the old timesheet spreadsheets (Admin → Timesheets → Import).
 * The file is read in the browser with SheetJS and never stored or uploaded:
 * only the cleaned rows are sent to `import_timesheet_rows()`.
 */
import { hoursFrom, type Employee } from './timesheets'
import { tr } from '../i18n'

/** One cell: its value, the text Excel shows, and a date / time when the cell holds one. */
export type RawCell = { v: string | number | boolean | null; w: string; date?: string; time?: string }
export type RawSheet = { name: string; rows: RawCell[][] }

export const FIELDS = [
  { key: 'ignore', get label() {
    return tr("Ignore")
  } },
  { key: 'employee', get label() {
    return tr("Employee")
  } },
  { key: 'date', get label() {
    return tr("Date")
  } },
  { key: 'start', get label() {
    return tr("Start")
  } },
  { key: 'end', get label() {
    return tr("End")
  } },
  { key: 'break_min', get label() {
    return tr("Break (minutes)")
  } },
  { key: 'break_hours', get label() {
    return tr("Break (hours)")
  } },
  { key: 'total', get label() {
    return tr("Total hours")
  } },
  { key: 'banked_earned', get label() {
    return tr("Banked (hours put in)")
  } },
  { key: 'banked_used', get label() {
    return tr("Banked (hours used)")
  } },
  { key: 'vacation_hours', get label() {
    return tr("Vacation (hours)")
  } },
  { key: 'vacation_days', get label() {
    return tr("Vacation (days)")
  } },
  { key: 'sick_hours', get label() {
    return tr("Sick (hours)")
  } },
  { key: 'sick_days', get label() {
    return tr("Sick (days)")
  } },
  { key: 'notes', get label() {
    return tr("Notes")
  } },
] as const
export type FieldKey = (typeof FIELDS)[number]['key']

/** How one tab is read. `fields` is keyed by the column's heading (or "col:C" when it has none). */
export type TabLayout = { include: boolean; header_row: number; employee_id: string | null; fields: Record<string, FieldKey> }
export type LayoutConfig = { tabs: Record<string, TabLayout>; byHeading: Record<string, FieldKey> }

export const colLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)))
const pad = (n: number) => String(n).padStart(2, '0')

function serialParts(v: number) {
  // to the nearest minute (Excel keeps times as fractions of a day: 15:30 = 0.6458333…)
  const ms = Math.round(((v - 25569) * 86400000) / 60000) * 60000
  const d = new Date(ms)
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }
}

/** Reads every tab of an .xlsx / .xls / .csv file (in the browser only). */
export async function readSheets(file: File): Promise<RawSheet[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false, cellNF: true })
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    const rows: RawCell[][] = []
    if (!ws['!ref']) return { name, rows }
    const range = XLSX.utils.decode_range(ws['!ref'])
    for (let R = 0; R <= Math.min(range.e.r, 20000); R++) {
      const row: RawCell[] = []
      for (let C = 0; C <= Math.min(range.e.c, 60); C++) {
        const c = ws[XLSX.utils.encode_cell({ r: R, c: C })] as { t?: string; v?: unknown; z?: string; w?: string } | undefined
        if (!c || c.v == null || c.v === '') {
          row.push({ v: null, w: '' })
          continue
        }
        const cell: RawCell = { v: c.v as RawCell['v'], w: String(c.w ?? c.v) }
        if (c.t === 'n' && typeof c.z === 'string' && XLSX.SSF.is_date(c.z)) {
          const v = Number(c.v)
          const p = serialParts(v)
          if (v >= 1) cell.date = p.date
          if (v % 1 !== 0 || /h|s/i.test(c.z.replace(/"[^"]*"/g, ''))) cell.time = p.time
        }
        row.push(cell)
      }
      rows.push(row)
    }
    while (rows.length && rows[rows.length - 1].every((c) => c.v == null)) rows.pop()
    return { name, rows }
  })
}

/** A sensible guess of what a column is from its heading. */
export function guessField(heading: string): FieldKey {
  const h = heading.toLowerCase().trim()
  if (!h) return 'ignore'
  if (/bank/.test(h)) return /use|taken|out/.test(h) ? 'banked_used' : 'banked_earned'
  if (/vac/.test(h)) return /day/.test(h) ? 'vacation_days' : 'vacation_hours'
  if (/sick/.test(h)) return /day/.test(h) ? 'sick_days' : 'sick_hours'
  if (/break|lunch/.test(h)) return /hour|hrs/.test(h) ? 'break_hours' : 'break_min'
  if (/name|employee|worker|staff/.test(h)) return 'employee'
  if (/start|time in|^in$|clock in/.test(h)) return 'start'
  if (/end|finish|time out|^out$|clock out/.test(h)) return 'end'
  if (/date|^day$/.test(h)) return 'date'
  if (/total|hours|hrs/.test(h)) return 'total'
  if (/note|comment|remark/.test(h)) return 'notes'
  return 'ignore'
}

export const headingKey = (heading: string, col: number) => (heading.trim() ? heading.trim().toLowerCase() : `col:${colLetter(col)}`)

/** The first row with at least two text cells (the headings), 1-based. */
export function guessHeaderRow(sheet: RawSheet) {
  const i = sheet.rows.slice(0, 15).findIndex((r) => r.filter((c) => typeof c.v === 'string' && c.v.trim()).length >= 2)
  return i < 0 ? 1 : i + 1
}

export function defaultTabLayout(sheet: RawSheet, byHeading: Record<string, FieldKey>): TabLayout {
  const header_row = guessHeaderRow(sheet)
  const head = sheet.rows[header_row - 1] ?? []
  const fields: Record<string, FieldKey> = {}
  head.forEach((c, i) => {
    const k = headingKey(c.w, i)
    fields[k] = byHeading[k] ?? guessField(c.w)
  })
  return { include: sheet.rows.length > header_row, header_row, employee_id: null, fields }
}

// ---------------------------------------------------------------------------
// Reading values (messy data welcome)
// ---------------------------------------------------------------------------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A date from a cell: real dates, 2025-03-04, 3/4/2025, 3/4/25, Mar 4 2025, 4-Mar-25, "Mon Mar 4" (year from the tab name or the file). */
export function readDate(c: RawCell | undefined, yearHint: number): string | null {
  if (!c || c.v == null) return null
  if (c.date) return c.date
  if (typeof c.v === 'number' && c.v > 20000 && c.v < 80000) return serialParts(c.v).date
  const s = String(c.v).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1')
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s)
  if (m) return valid(+m[1], +m[2], +m[3])
  m = /(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/.exec(s)
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : yearHint
    return valid(y, +m[1], +m[2]) ?? valid(y, +m[2], +m[1])
  }
  m = /([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?/.exec(s)
  if (m && MONTHS.includes(m[1])) return valid(m[3] ? +m[3] : yearHint, MONTHS.indexOf(m[1]) + 1, +m[2])
  m = /(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s-]?(\d{2,4})?/.exec(s)
  if (m && MONTHS.includes(m[2])) return valid(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : yearHint, MONTHS.indexOf(m[2]) + 1, +m[1])
  return null
}
function valid(y: number, mo: number, d: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCMonth() === mo - 1 ? `${y}-${pad(mo)}-${pad(d)}` : null
}

/** A time of day: real times, 7:30, 7:30 AM, 3:30pm, 0730, 7.5 (= 7:30), 15. */
export function readTime(c: RawCell | undefined): string | null {
  if (!c || c.v == null) return null
  if (c.time) return c.time
  if (typeof c.v === 'number') {
    if (c.v > 0 && c.v < 1) return serialParts(c.v).time
    if (c.v >= 0 && c.v < 24) return `${pad(Math.floor(c.v))}:${pad(Math.round((c.v % 1) * 60))}`
    if (c.v >= 100 && c.v <= 2359 && c.v % 100 < 60) return `${pad(Math.floor(c.v / 100))}:${pad(c.v % 100)}`
    return null
  }
  const s = String(c.v).trim().toLowerCase().replace(/\s+/g, '')
  // 15.5 = 15:30 (one decimal is a part of an hour); 7.30 = 7:30
  const dec = /^(\d{1,2})\.(\d)$/.exec(s)
  if (dec && +dec[1] < 24) return `${pad(+dec[1])}:${pad(Math.round(+dec[2] * 6))}`
  const m = /^(\d{1,2})(?::|\.|h)?(\d{2})?(am|pm|a|p)?$/.exec(s)
  if (!m) return null
  let h = +m[1]
  const min = m[2] ? +m[2] : 0
  if (m[3]?.startsWith('p') && h < 12) h += 12
  if (m[3]?.startsWith('a') && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return `${pad(h)}:${pad(min)}`
}

/** A number of hours: 8, 7.5, "7,5", "8h", "7:30" (= 7.5), a time cell (duration). */
export function readHours(c: RawCell | undefined): number | null {
  if (!c || c.v == null || c.v === '') return null
  if (typeof c.v === 'number') {
    if (c.time && c.v < 1) return Math.round(c.v * 24 * 100) / 100
    return c.v
  }
  if (typeof c.v === 'boolean') return null
  const s = String(c.v).trim().toLowerCase()
  const t = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (t) return +t[1] + +t[2] / 60
  const n = Number(s.replace(',', '.').replace(/[^0-9.-]/g, ''))
  return s.replace(/[^0-9]/g, '') === '' || Number.isNaN(n) ? null : n
}

// ---------------------------------------------------------------------------
// Rows to import
// ---------------------------------------------------------------------------
export type Action = 'import' | 'keep' | 'skip'
export type Draft = {
  key: string
  tab: string
  row: number
  employeeText: string
  employee_id: string
  date: string
  start: string
  end: string
  breakMin: string
  total: string
  bankedEarned: string
  bankedUsed: string
  vacation: string
  sick: string
  notes: string
  action: Action
  /** Set by the person in the preview (otherwise worked out from the problems). */
  actionChosen: boolean
  problems: { level: 'error' | 'warning' | 'info'; text: string }[]
  importKey: string
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The employee a name in the sheet means (name or one of the other spellings). */
export function matchEmployee(text: string, employees: Employee[]) {
  const t = norm(text)
  if (!t) return ''
  const hit = employees.find((e) => norm(e.name) === t || e.import_names.some((n) => norm(n) === t))
  if (hit) return hit.id
  const first = employees.filter((e) => norm(e.name.split(' ')[0]) === t)
  return first.length === 1 ? first[0].id : ''
}

const yearFrom = (s: string) => Number(/(20\d{2})/.exec(s)?.[1] ?? 0)
const fix = (n: number | null) => (n == null ? '' : String(Math.round(n * 100) / 100))

/** Turns the tabs into rows to import, using the matching chosen for each tab. */
export function buildDrafts(sheets: RawSheet[], layouts: Record<string, TabLayout>, employees: Employee[], fileName: string, hoursPerDay: (employeeId: string) => number): Draft[] {
  const out: Draft[] = []
  const fileYear = yearFrom(fileName) || new Date().getFullYear()
  for (const sheet of sheets) {
    const L = layouts[sheet.name]
    if (!L?.include) continue
    const head = sheet.rows[L.header_row - 1] ?? []
    const colOf: Partial<Record<FieldKey, number>> = {}
    head.forEach((c, i) => {
      const f = L.fields[headingKey(c.w, i)]
      if (f && f !== 'ignore' && colOf[f] === undefined) colOf[f] = i
    })
    // a column that has no heading but was matched
    for (const [k, f] of Object.entries(L.fields)) if (k.startsWith('col:') && f !== 'ignore' && colOf[f] === undefined) colOf[f] = [...Array(80).keys()].find((i) => colLetter(i) === k.slice(4))
    const yearHint = yearFrom(sheet.name) || fileYear
    const get = (r: RawCell[], f: FieldKey) => (colOf[f] === undefined ? undefined : r[colOf[f]!])
    for (let i = L.header_row; i < sheet.rows.length; i++) {
      const r = sheet.rows[i]
      if (r.every((c) => c.v == null)) continue
      const text = r.map((c) => c.w).join(' ').toLowerCase()
      if (/\b(total|totals|week total|sum)\b/.test(text) && !readTime(get(r, 'start'))) continue // total lines of the sheet
      const empText = L.employee_id ? '' : (get(r, 'employee')?.w ?? '').trim()
      const empId = L.employee_id ?? matchEmployee(empText, employees)
      const dateCell = get(r, 'date')
      const date = readDate(dateCell, yearHint) ?? ''
      const brkH = readHours(get(r, 'break_hours'))
      const brkM = readHours(get(r, 'break_min'))
      const hpd = hoursPerDay(empId)
      const vacD = readHours(get(r, 'vacation_days'))
      const sickD = readHours(get(r, 'sick_days'))
      out.push({
        key: `${sheet.name}:${i + 1}`,
        tab: sheet.name,
        row: i + 1,
        employeeText: L.employee_id ? employees.find((e) => e.id === L.employee_id)?.name ?? '' : empText,
        employee_id: empId,
        date,
        start: readTime(get(r, 'start')) ?? '',
        end: readTime(get(r, 'end')) ?? '',
        breakMin: brkH != null ? fix(brkH * 60) : brkM != null ? fix(brkM < 5 && brkM > 0 && !Number.isInteger(brkM) ? brkM * 60 : brkM) : '',
        total: fix(readHours(get(r, 'total'))),
        bankedEarned: fix(readHours(get(r, 'banked_earned'))),
        bankedUsed: fix(readHours(get(r, 'banked_used'))),
        vacation: fix(readHours(get(r, 'vacation_hours')) ?? (vacD != null ? vacD * hpd : null)),
        sick: fix(readHours(get(r, 'sick_hours')) ?? (sickD != null ? sickD * hpd : null)),
        notes: (get(r, 'notes')?.w ?? '').trim(),
        action: 'import',
        actionChosen: false,
        problems: [],
        importKey: '',
      })
    }
  }
  return out
}

/** FNV-1a: a short, stable fingerprint of a row (same row in a later import = already imported). */
function fingerprint(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export const rowHours = (d: Draft) => hoursFrom(d.start, d.end, Number(d.breakMin) || 0)
const has = (s: string) => s.trim() !== '' && Number(s) > 0

/**
 * Checks every row again (after each edit): missing dates, unknown employees,
 * totals that do not add up, nothing to import, duplicates in the file,
 * rows already imported, days that already have hours.
 */
export function validate(drafts: Draft[], existingKeys: Set<string>, daysWithHours: Map<string, string[]>): Draft[] {
  const seen = new Map<string, string>()
  return drafts.map((d) => {
    const p: Draft['problems'] = []
    const computed = rowHours(d)
    const importKey = `ts-${fingerprint([d.employee_id, d.date, d.start, d.end, d.breakMin, d.total, d.bankedEarned, d.bankedUsed, d.vacation, d.sick].join('|'))}`
    if (!d.employee_id) p.push({ level: 'error', text: d.employeeText ? `Unknown employee “${d.employeeText}”` : 'No employee' })
    if (!d.date) p.push({ level: 'error', get text() {
    return tr("Missing date")
  } })
    if ((d.start && !d.end) || (!d.start && d.end)) p.push({ level: 'warning', get text() {
    return tr("Only a start or an end time")
  } })
    if (d.start && d.end && computed == null) p.push({ level: 'error', get text() {
    return tr("The break is longer than the time worked")
  } })
    if (computed != null && has(d.total) && Math.abs(computed - Number(d.total)) > 0.05) {
      p.push({ level: 'warning', text: `Total does not add up: the sheet says ${d.total}, start, end and break give ${computed}` })
    }
    if (computed != null && computed > 16) p.push({ level: 'warning', text: `${computed} hours in one day` })
    const nothing = computed == null && !has(d.total) && !has(d.bankedEarned) && !has(d.bankedUsed) && !has(d.vacation) && !has(d.sick)
    if (nothing) p.push({ level: 'info', get text() {
    return tr("No hours on this row")
  } })
    if (existingKeys.has(importKey)) p.push({ level: 'info', get text() {
    return tr("Already imported")
  } })
    else if (seen.has(importKey)) p.push({ level: 'warning', text: `The same as row ${seen.get(importKey)}` })
    else if (d.employee_id && d.date && daysWithHours.get(`${d.employee_id}|${d.date}`)?.some((s) => s !== 'import')) {
      p.push({ level: 'warning', get text() {
    return tr("This day already has hours entered in the app")
  } })
    }
    seen.set(importKey, `${d.tab} ${d.row}`)
    let action = d.action
    if (!d.actionChosen) {
      if (nothing || existingKeys.has(importKey)) action = 'skip'
      else if (p.some((x) => x.level === 'error')) action = 'skip'
      else if (p.some((x) => x.level === 'warning')) action = 'keep'
      else action = 'import'
    }
    return { ...d, problems: p, importKey, action }
  })
}

/** The row as the database wants it. Rows kept as-is with a total that does not add up keep the sheet's total (the times go in the notes). */
export function toPayload(d: Draft) {
  const computed = rowHours(d)
  const mismatch = computed != null && has(d.total) && Math.abs(computed - Number(d.total)) > 0.05
  const useTotal = d.action === 'keep' && mismatch
  const keepTimes = d.start && d.end && computed != null && !useTotal
  return {
    row: `${d.tab} ${d.row}`,
    employee_id: d.employee_id,
    work_date: d.date,
    start_time: keepTimes ? d.start : null,
    end_time: keepTimes ? d.end : null,
    break_minutes: keepTimes ? Number(d.breakMin) || 0 : 0,
    hours: keepTimes ? null : Number(d.total) || computed || 0,
    banked_earned: Number(d.bankedEarned) || 0,
    banked_used: Number(d.bankedUsed) || 0,
    vacation_hours: Number(d.vacation) || 0,
    sick_hours: Number(d.sick) || 0,
    notes: [d.notes, useTotal ? `Sheet times ${d.start}–${d.end}, break ${d.breakMin || 0} min` : ''].filter(Boolean).join(' · '),
    needs_review: d.action === 'keep',
    review_note: d.action === 'keep' ? d.problems.filter((p) => p.level !== 'info').map((p) => p.text).join('; ') : null,
    import_key: d.importKey,
  }
}
