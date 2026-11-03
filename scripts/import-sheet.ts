/**
 * Import the old Google Sheet (exported as .xlsx) into the database.
 *
 *   npm run import-sheet                      dry run: shows what would be imported and every problem
 *   npm run import-sheet -- --commit          really writes to the database (all or nothing)
 *
 * Options:
 *   --file import/orders.xlsx    which file (default: the newest .xlsx in /import)
 *   --sheet 2026                 which tab (default "2026")
 *   --usd-countries "USA,United States"   orders for these countries are imported in USD (default: all CAD)
 *   --keep-serials               keep every imported serial exactly where it is (as if typed by hand),
 *                                instead of letting unbuilt serials follow board order
 *   --payload-out file.json      also save exactly what would be sent to the database (for troubleshooting)
 *
 * Sheet layout (one order = a header row followed by its machine rows):
 *   Header row:  A order #, B "Customer, Country", D expected ship date, E voltage, F notes,
 *                G actual ship date, I down payment, J DP due, K DP received,
 *                L balance (number, or a formula like =48300-I101 whose number is the order total),
 *                M balance due, N balance received
 *   Machine row: B machine name, C serial (may be just the code, e.g. "SSM", or empty), D tick box = built
 *
 * Needs, in .env.local (never commit it; no VITE_ in front so it never reaches the website):
 *   VITE_SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=...   (Supabase → Project Settings → API keys → service_role / secret)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Command line and settings
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const COMMIT = flag('commit')
const KEEP_SERIALS = flag('keep-serials')
const SHEET = option('sheet') ?? '2026'
const USD_COUNTRIES = new Set(
  (option('usd-countries') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

function loadEnv() {
  const env: Record<string, string> = {}
  for (const name of ['.env', '.env.local']) {
    const file = path.join(ROOT, name)
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return { ...env, ...process.env } as Record<string, string | undefined>
}

function findFile() {
  const given = option('file')
  if (given) return path.resolve(ROOT, given)
  const dir = path.join(ROOT, 'import')
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : []
  if (!files.length) {
    console.error('No .xlsx file found. Put the exported sheet in the "import" folder, or use --file path/to/file.xlsx')
    process.exit(1)
  }
  return files[0]
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------
type Problem = { row: number; level: 'error' | 'warning'; message: string }
const problems: Problem[] = []
const error = (row: number, message: string) => problems.push({ row, level: 'error', message })
const warn = (row: number, message: string) => problems.push({ row, level: 'warning', message })

// ---------------------------------------------------------------------------
// Reading cells
// ---------------------------------------------------------------------------
type Raw = ExcelJS.CellValue

/** The value a person sees in the cell (formula result, rich text joined, …). */
function plain(v: Raw): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return plain((v as { result?: Raw }).result ?? null)
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('')
    if ('text' in v) return String((v as { text: unknown }).text)
    if ('error' in v) return null
    return null
  }
  return v as string | number | boolean | Date
}

function formulaOf(v: Raw): string | null {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('formula' in v && typeof v.formula === 'string') return v.formula
    if ('sharedFormula' in v && typeof v.sharedFormula === 'string') return v.sharedFormula
  }
  return null
}

const text = (v: Raw) => {
  const p = plain(v)
  if (p === null) return ''
  if (p instanceof Date) return p.toISOString().slice(0, 10)
  return String(p).trim()
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? dt.toISOString().slice(0, 10)
    : null
}

/** A date cell → "YYYY-MM-DD". Returns undefined when the cell is empty, null when it can't be read. */
function readDate(v: Raw, row: number, what: string): string | null | undefined {
  const p = plain(v)
  if (p === null || p === '') return undefined
  if (p instanceof Date) return p.toISOString().slice(0, 10)
  if (typeof p === 'number' && p > 20000 && p < 80000) {
    // A spreadsheet day number (days since 1899-12-30).
    return new Date(Date.UTC(1899, 11, 30) + p * 86400000).toISOString().slice(0, 10)
  }
  const s = String(p).trim()
  if (/^(-|–|\?|n\/?a|tbd|tba|none)$/i.test(s)) return undefined
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/) // m/d/yyyy (North American)
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2])
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s-,]*(\d{4})$/) // 15 Mar 2026
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1])
  m = s.match(/^([A-Za-z]{3,4})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/) // Mar 15, 2026
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2])
  warn(row, `${what} "${s}" is not a date I can read; left empty.`)
  return null
}

/** A money cell → number. undefined when empty, NaN when unreadable. */
function readMoney(v: Raw): number | undefined {
  const p = plain(v)
  if (p === null || p === '') return undefined
  if (typeof p === 'number') return p
  const s = String(p).replace(/[$,\s]|CAD|USD/gi, '')
  if (s === '' || s === '-') return undefined
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN
}

/** Tick box / yes / ✓ → true. */
function readTick(v: Raw) {
  const p = plain(v)
  if (p === true) return true
  if (typeof p === 'number') return p !== 0
  return typeof p === 'string' && /^(true|yes|y|x|✓|✔|☑|done|ready|built)$/i.test(p.trim())
}

/** A "received" cell: a date, or just ticked/yes (then we use a fallback date). */
function readReceived(v: Raw, row: number, what: string, fallback: string | undefined): string | undefined {
  const p = plain(v)
  if (p === null || p === '' || p === false) return undefined
  if (readTick(v)) {
    const date = fallback ?? todayHalifax()
    warn(row, `${what} is marked received but has no date; used ${date}.`)
    return date
  }
  if (typeof p === 'string' && /^(no|n|-|false)$/i.test(p.trim())) return undefined
  const d = readDate(v, row, what)
  return d ?? undefined
}

function todayHalifax() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax' }).format(new Date())
}

// ---------------------------------------------------------------------------
// Machine types, dropdown values
// ---------------------------------------------------------------------------
type MachineType = { id: string; name: string; code: string | null }

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ')

function typeFinder(types: MachineType[]) {
  const byWords = new Map(types.map((t) => [words(t.name), t]))
  const byCode = new Map(types.filter((t) => t.code).map((t) => [t.code!.toUpperCase(), t]))
  return {
    byName: (name: string) => byWords.get(words(name)) ?? byCode.get(name.trim().toUpperCase()),
    byCode: (code: string) => byCode.get(code.toUpperCase()),
  }
}

/** Machine types from the seed migration, for a dry run without database access. */
function offlineTypes(): MachineType[] {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/0002_seed_machine_types.sql'), 'utf8')
  return [...sql.matchAll(/\('([^']+)',\s*(?:'([A-Z0-9]+)'|null)\)/g)].map((m) => ({
    id: `offline:${m[1]}`,
    name: m[1],
    code: m[2] ?? null,
  }))
}

const DEFAULT_OPTIONS: Record<string, string[]> = {
  voltage: ['120V', '240V', 'Unknown'],
  delivery_equipment: ['Liftgate', 'No liftgate', 'Forklift', 'Tractor with forks', 'Unknown'],
  freight_type: ['LTL', 'FTL', 'LCL', "40' container", 'Other'],
}

// ---------------------------------------------------------------------------
// Parsing the sheet
// ---------------------------------------------------------------------------
type MachineOut = {
  machine_type_id: string
  type_name: string
  type_code: string | null
  serial_number: string | null
  ready: boolean
  source_row: number
}
type OrderOut = {
  order_number: number
  split_number: number | null
  customer: { name: string; country: string | null }
  stage: string
  currency: string
  order_total: number
  expected_ship_date: string | null
  actual_ship_date: string | null
  voltage: string
  delivery_equipment: string
  freight_type: string | null
  notes: string | null
  machines: MachineOut[]
  down_payment: { amount: number; due_date: string | null; received_date: string | null } | null
  balance: { due_date: string | null; received_date: string | null; amount: number } | null
  source_row: number
}

const ORDER_NO = /^\s*#?\s*(\d{1,6})(?:\.0+)?\s*(?:[-–]\s*(\d{1,3}))?\s*$/

function parseOrderNumber(v: Raw): { number: number; split: number | null } | null {
  const p = plain(v)
  if (typeof p === 'number' && Number.isInteger(p) && p > 0) return { number: p, split: null }
  if (typeof p !== 'string') return null
  const m = p.match(ORDER_NO)
  return m ? { number: +m[1], split: m[2] ? +m[2] : null } : null
}

function mapVoltage(raw: string, row: number, options: string[]) {
  const s = raw.trim()
  if (!s || /^(\?+|-+|–|unknown|tbd|n\/?a)$/i.test(s)) return 'Unknown'
  const exact = options.find((o) => o.toLowerCase() === s.toLowerCase())
  if (exact) return exact
  const digits = s.match(/\d{3}/)?.[0]
  const viaDigits = digits && options.find((o) => o.startsWith(digits))
  if (viaDigits) return viaDigits
  warn(row, `Voltage "${s}" is not in the Voltage list; imported as Unknown.`)
  return 'Unknown'
}

function pick(options: string[], wanted: string) {
  return options.find((o) => o.toLowerCase() === wanted.toLowerCase()) ?? null
}

function mapNotes(note: string, row: number, delivery: string[], freight: string[]) {
  const n = note.toLowerCase()
  let deliveryValue: string | null = null
  if (/no[\s-]*lift[\s-]*gate/.test(n)) deliveryValue = 'No liftgate'
  else if (/lift[\s-]*gate/.test(n)) deliveryValue = 'Liftgate'
  else if (/tractor/.test(n)) deliveryValue = 'Tractor with forks'
  else if (/fork[\s-]*lift/.test(n)) deliveryValue = 'Forklift'

  const found: string[] = []
  if (/\blcl\b/.test(n)) found.push('LCL')
  if (/\bftl\b/.test(n)) found.push('FTL')
  if (/\bltl\b/.test(n)) found.push('LTL')
  if (/\b40\s*('|’|ft\b|foot|feet|hc\b)|\b40'|container/.test(n)) found.push("40' container")
  if (found.length > 1) warn(row, `Notes mention more than one freight type (${found.join(', ')}); used ${found[0]}.`)
  const freightWanted = found[0] ?? null

  const d = deliveryValue ? pick(delivery, deliveryValue) : null
  if (deliveryValue && !d) warn(row, `"${deliveryValue}" is not in the Delivery equipment list; left as Unknown.`)
  const f = freightWanted ? pick(freight, freightWanted) : null
  if (freightWanted && !f) warn(row, `"${freightWanted}" is not in the Freight type list; left empty.`)
  return { delivery: d ?? 'Unknown', freight: f }
}

/** "SSM-2010", "SSM 2010", "ssm2010", "2010" → "SSM-2010"; "SSM" or "" → null. */
function parseSerial(raw: string, type: MachineType | undefined, row: number) {
  const s = raw.trim().toUpperCase()
  if (!s) return { serial: null, codeFromSerial: null as string | null }
  const m = s.match(/^([A-Z][A-Z0-9]*?)\s*[-–\s]?\s*(\d+)$/)
  if (m) {
    const num = m[2].padStart(4, '0')
    return { serial: `${m[1]}-${num}`, codeFromSerial: m[1] }
  }
  if (/^\d+$/.test(s)) {
    if (type?.code) {
      warn(row, `Serial "${raw.trim()}" has no code; read as ${type.code}-${s.padStart(4, '0')}.`)
      return { serial: `${type.code}-${s.padStart(4, '0')}`, codeFromSerial: type.code }
    }
    return { serial: null, codeFromSerial: null }
  }
  if (/^[A-Z][A-Z0-9]*$/.test(s)) return { serial: null, codeFromSerial: s } // just the code
  warn(row, `Serial "${raw.trim()}" doesn't look like CODE-1234; imported blank.`)
  return { serial: null, codeFromSerial: null }
}

function parseSheet(ws: ExcelJS.Worksheet, types: MachineType[], options: Record<string, string[]>) {
  const find = typeFinder(types)
  const orders: OrderOut[] = []
  let current: OrderOut | null = null
  let skippedBeforeFirst = 0

  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const cell = (col: string) => row.getCell(col).value
    const A = cell('A')
    const orderNo = parseOrderNumber(A)
    const hasAnything = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'I', 'L'].some((c) => text(cell(c)) !== '')
    if (!hasAnything) continue

    if (orderNo) {
      // ---------- Order header row ----------
      const customerCell = text(cell('B'))
      let name = customerCell
      let country: string | null = null
      const comma = customerCell.lastIndexOf(',')
      if (comma >= 0) {
        name = customerCell.slice(0, comma).trim()
        country = customerCell.slice(comma + 1).trim() || null
      } else if (customerCell) {
        warn(r, `Customer "${customerCell}" has no ", Country"; imported with no country.`)
      }
      if (!name) error(r, `Order ${text(A)} has no customer name.`)

      const expected = readDate(cell('D'), r, 'Expected ship date') ?? null
      const actual = readDate(cell('G'), r, 'Actual ship date') ?? null
      const note = text(cell('F'))
      const voltage = mapVoltage(text(cell('E')), r, options.voltage)
      const mapped = mapNotes(note, r, options.delivery_equipment, options.freight_type)

      // Money
      const dp = readMoney(cell('I'))
      if (Number.isNaN(dp)) error(r, `Down payment "${text(cell('I'))}" is not a number.`)
      const dpValue = dp !== undefined && !Number.isNaN(dp) ? dp : undefined
      const balanceFormula = formulaOf(cell('L'))
      const balanceValue = readMoney(cell('L'))
      let total: number
      let balanceAmount: number
      const fm = balanceFormula?.match(/^\s*=?\s*\(?\s*([\d.,]+)\s*\)?\s*-\s*\$?I\$?\d+\s*$/i)
      if (fm) {
        total = Number(fm[1].replace(/,/g, ''))
        balanceAmount = total - (dpValue ?? 0)
        if (balanceValue !== undefined && !Number.isNaN(balanceValue) && Math.abs(balanceValue - balanceAmount) > 0.01) {
          warn(r, `Balance formula =${balanceFormula} shows ${balanceValue} in the sheet, but ${total} − down payment = ${balanceAmount}. Used total ${total}.`)
        }
      } else if (balanceValue !== undefined && !Number.isNaN(balanceValue)) {
        balanceAmount = balanceValue
        total = (dpValue ?? 0) + balanceValue
        if (balanceFormula) warn(r, `Balance formula =${balanceFormula} is not "total − down payment"; used its value ${balanceValue}, total ${total}.`)
      } else {
        if (Number.isNaN(balanceValue)) error(r, `Balance "${text(cell('L'))}" is not a number.`)
        balanceAmount = 0
        total = dpValue ?? 0
        if (dpValue === undefined) warn(r, 'No down payment or balance; order total imported as 0.')
      }
      total = Math.round(total * 100) / 100

      const dpDue = readDate(cell('J'), r, 'Down payment due date') ?? null
      const dpRecv = readReceived(cell('K'), r, 'Down payment', dpDue ?? undefined) ?? null
      const balDue = readDate(cell('M'), r, 'Balance due date') ?? null
      const balRecv = readReceived(cell('N'), r, 'Balance', balDue ?? actual ?? undefined) ?? null

      current = {
        order_number: orderNo.number,
        split_number: orderNo.split,
        customer: { name, country },
        stage: '', // worked out once the machines are known
        currency: country && USD_COUNTRIES.has(country.toLowerCase()) ? 'USD' : 'CAD',
        order_total: total,
        expected_ship_date: expected,
        actual_ship_date: actual,
        voltage,
        delivery_equipment: mapped.delivery,
        freight_type: mapped.freight,
        notes: note || null,
        machines: [],
        down_payment: dpValue !== undefined || dpDue || dpRecv ? { amount: dpValue ?? 0, due_date: dpDue, received_date: dpRecv } : null,
        balance: total > 0 || balDue || balRecv ? { due_date: balDue, received_date: balRecv, amount: balanceAmount } : null,
        source_row: r,
      }
      orders.push(current)
      continue
    }

    if (!current) {
      skippedBeforeFirst++
      continue
    }

    // ---------- Machine row ----------
    const orderCode = `${current.order_number}${current.split_number ? `-${current.split_number}` : ''}`
    const machineName = text(cell('B'))
    const serialRaw = text(cell('C'))
    if (text(A)) warn(r, `Column A "${text(A)}" is not an order number; treated as a machine row of order ${orderCode}.`)
    if (!machineName) {
      if (serialRaw || readTick(cell('D'))) error(r, `Row has a serial/tick but no machine name (order ${orderCode}).`)
      continue
    }
    let type = find.byName(machineName)
    const parsed = parseSerial(serialRaw, type, r)
    if (!type && parsed.codeFromSerial) {
      type = find.byCode(parsed.codeFromSerial)
      if (type) warn(r, `Machine "${machineName}" not found by name; used ${type.name} from its serial code ${parsed.codeFromSerial}.`)
    }
    if (!type) {
      error(r, `Machine "${machineName}" doesn't match any machine type. Add or rename it in Admin → Machine types, then run again.`)
      continue
    }
    if (parsed.codeFromSerial && type.code && parsed.codeFromSerial !== type.code) {
      warn(r, `Serial ${serialRaw} starts with ${parsed.codeFromSerial} but ${type.name} uses ${type.code}.`)
    }
    if (!parsed.serial) {
      warn(r, `${type.name} on order ${orderCode} has no serial number (${serialRaw ? `"${serialRaw}"` : 'empty'}) → imported blank, flagged "needs serial".`)
    }
    current.machines.push({
      machine_type_id: type.id,
      type_name: type.name,
      type_code: type.code,
      serial_number: parsed.serial,
      ready: readTick(cell('D')),
      source_row: r,
    })
  }

  // ---------- Per-order checks ----------
  const seenOrders = new Map<string, number>()
  const seenSerials = new Map<string, number>()
  for (const o of orders) {
    const code = `${o.order_number}${o.split_number ? `-${o.split_number}` : ''}`
    if (seenOrders.has(code)) error(o.source_row, `Order ${code} appears twice (also row ${seenOrders.get(code)}).`)
    seenOrders.set(code, o.source_row)

    // Stage
    const cancelled = /cancel+ed|\bcancel\b/i.test(o.notes ?? '')
    const allReady = o.machines.length > 0 && o.machines.every((m) => m.ready)
    if (o.actual_ship_date) o.stage = 'Shipped'
    else if (cancelled) o.stage = 'Cancelled'
    else if (allReady) o.stage = 'Ready to ship'
    else if (o.machines.some((m) => m.ready)) o.stage = 'In production'
    else o.stage = 'Confirmed'
    if (cancelled) warn(o.source_row, `Order ${code}: notes say cancelled → imported as ${o.stage}${o.stage === 'Shipped' ? ' (it has a ship date)' : ''}.`)
    // Shipped machines were built.
    if (o.stage === 'Shipped') {
      const unticked = o.machines.filter((m) => !m.ready).length
      if (unticked) warn(o.source_row, `Order ${code} is shipped; its ${unticked} unticked machine(s) are imported as built.`)
      for (const m of o.machines) m.ready = true
    }
    if (o.machines.length === 0) warn(o.source_row, `Order ${code} has no machine rows.`)
    if (!o.expected_ship_date && o.stage !== 'Shipped' && o.stage !== 'Cancelled')
      warn(o.source_row, `Order ${code} has no expected ship date.`)

    for (const m of o.machines) {
      if (!m.serial_number) continue
      const prev = seenSerials.get(m.serial_number)
      if (prev) {
        error(m.source_row, `Serial ${m.serial_number} is used twice (also row ${prev}).`)
      }
      seenSerials.set(m.serial_number, m.source_row)
    }
  }
  return { orders, skippedBeforeFirst }
}

// ---------------------------------------------------------------------------
// Board order and serials: what the database will do after import
// ---------------------------------------------------------------------------
const BOARD = new Set(['Confirmed', 'In production', 'Ready to ship'])
const byOrderNumber = (a: OrderOut, b: OrderOut) =>
  a.order_number - b.order_number || (a.split_number ?? 0) - (b.split_number ?? 0)
const num = (s: string) => Number(s.match(/(\d+)$/)?.[1] ?? 0)

/**
 * Serials of unbuilt machines on the board follow board order (lowest board
 * number = lowest serial, per machine type). Lists the serials the database
 * will swap so that rule holds.
 */
function serialReorders(orders: OrderOut[]) {
  const changes: { order: string; type: string; from: string; to: string; row: number }[] = []
  const board = orders.filter((o) => BOARD.has(o.stage)).sort(byOrderNumber)
  const byType = new Map<string, { o: OrderOut; m: MachineOut }[]>()
  for (const o of board)
    for (const m of o.machines)
      if (!m.ready && m.serial_number) byType.set(m.machine_type_id, [...(byType.get(m.machine_type_id) ?? []), { o, m }])
  for (const list of byType.values()) {
    const sorted = list.map((x) => x.m.serial_number!).sort((a, b) => num(a) - num(b) || a.localeCompare(b))
    list.forEach((x, i) => {
      if (x.m.serial_number !== sorted[i]) {
        changes.push({
          order: `${x.o.order_number}${x.o.split_number ? `-${x.o.split_number}` : ''}`,
          type: x.m.type_name,
          from: x.m.serial_number!,
          to: sorted[i],
          row: x.m.source_row,
        })
      }
    })
  }
  return changes
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const env = loadEnv()
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  let db: SupabaseClient | null = null
  if (url && key) {
    db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  } else if (COMMIT) {
    console.error('To import (--commit) I need VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.')
    process.exit(1)
  }

  // Machine types and dropdown lists: from the database if we can reach it.
  let types: MachineType[]
  const options = { ...DEFAULT_OPTIONS }
  if (db) {
    const t = await db.from('machine_types').select('id, name, code').eq('archived', false)
    if (t.error) {
      console.error(`Could not read machine types: ${t.error.message}`)
      process.exit(1)
    }
    types = t.data as MachineType[]
    const o = await db.from('option_lists').select('list_name, value').eq('archived', false).order('sort_order')
    if (!o.error) {
      for (const list of Object.keys(options)) {
        const values = (o.data as { list_name: string; value: string }[]).filter((x) => x.list_name === list).map((x) => x.value)
        if (values.length) options[list] = values
      }
    }
  } else {
    types = offlineTypes()
  }

  const file = findFile()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.getWorksheet(SHEET)
  if (!ws) {
    console.error(`The file has no tab called "${SHEET}". Tabs: ${wb.worksheets.map((w) => `"${w.name}"`).join(', ')}. Use --sheet NAME.`)
    process.exit(1)
  }

  const { orders, skippedBeforeFirst } = parseSheet(ws, types, options)

  // Compare with what is already in the database.
  if (db) {
    const existing = await db.from('orders').select('order_number, split_number, order_code')
    for (const o of orders) {
      const hit = (existing.data ?? []).find((e) => e.order_number === o.order_number && (e.split_number ?? null) === o.split_number)
      if (hit) error(o.source_row, `Order ${hit.order_code} is already in the database.`)
    }
    const serials = orders.flatMap((o) => o.machines.map((m) => m.serial_number).filter((s): s is string => !!s))
    for (let i = 0; i < serials.length; i += 200) {
      const used = await db.from('order_machines').select('serial_number').in('serial_number', serials.slice(i, i + 200))
      for (const u of used.data ?? []) {
        const row = orders.flatMap((o) => o.machines).find((m) => m.serial_number === u.serial_number)?.source_row ?? 0
        error(row, `Serial ${u.serial_number} is already in the database.`)
      }
    }
  }

  // Keep serials fixed (as if typed by hand) if asked.
  const reorders = KEEP_SERIALS ? [] : serialReorders(orders)

  // ---------- Report ----------
  const out: string[] = []
  const say = (s = '') => out.push(s)
  const money = (n: number, cur: string) => `${cur} ${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  say(`${COMMIT ? 'IMPORT' : 'DRY RUN (nothing is saved)'} – ${path.relative(ROOT, file)}, tab "${SHEET}"`)
  say(db ? `Checked against the database at ${url}` : 'Not connected to the database (no SUPABASE_SERVICE_ROLE_KEY): checked against the built-in machine types only.')
  if (skippedBeforeFirst) say(`Skipped ${skippedBeforeFirst} row(s) above the first order (titles/headings).`)
  say()

  const sorted = [...orders].sort(byOrderNumber)
  for (const o of sorted) {
    const code = `${o.order_number}${o.split_number ? `-${o.split_number}` : ''}`
    say(`Order ${code}  (row ${o.source_row})  ${o.customer.name}${o.customer.country ? `, ${o.customer.country}` : ''}`)
    say(
      `   ${o.stage}` +
        ` · expected ${o.expected_ship_date ?? '—'}` +
        (o.actual_ship_date ? ` · shipped ${o.actual_ship_date}` : '') +
        ` · voltage ${o.voltage} · delivery ${o.delivery_equipment} · freight ${o.freight_type ?? '—'}`,
    )
    const dp = o.down_payment
    const bal = o.balance
    say(
      `   total ${money(o.order_total, o.currency)}` +
        (dp ? ` · down payment ${money(dp.amount, o.currency)}${o.order_total ? ` (${Math.round((dp.amount / o.order_total) * 1000) / 10}%)` : ''} due ${dp.due_date ?? '—'}${dp.received_date ? ` received ${dp.received_date}` : ''}` : '') +
        (bal ? ` · balance ${money(bal.amount, o.currency)} due ${bal.due_date ?? '—'}${bal.received_date ? ` received ${bal.received_date}` : ''}` : ''),
    )
    if (o.notes) say(`   notes: ${o.notes}`)
    for (const m of o.machines) {
      say(`     ${m.ready ? '[x]' : '[ ]'} ${m.type_name.padEnd(28)} ${m.serial_number ?? 'NEEDS SERIAL'}`)
    }
  }

  const customers = new Set(orders.map((o) => `${o.customer.name.toLowerCase()}|${(o.customer.country ?? '').toLowerCase()}`))
  const machines = orders.flatMap((o) => o.machines)
  const highest = new Map<string, number>()
  for (const m of machines)
    if (m.serial_number && m.type_code && m.serial_number.startsWith(`${m.type_code}-`))
      highest.set(m.type_code, Math.max(highest.get(m.type_code) ?? 0, num(m.serial_number)))

  say()
  say('SUMMARY')
  say(`  ${orders.length} orders, ${customers.size} customers, ${machines.length} machines (${machines.filter((m) => !m.serial_number).length} need a serial)`)
  const stages = new Map<string, number>()
  for (const o of orders) stages.set(o.stage, (stages.get(o.stage) ?? 0) + 1)
  say(`  Stages: ${[...stages].map(([s, n]) => `${s} ${n}`).join(', ')}`)
  say(`  Currency: ${orders.filter((o) => o.currency === 'USD').length} USD, ${orders.filter((o) => o.currency === 'CAD').length} CAD${USD_COUNTRIES.size ? '' : ' (all CAD – use --usd-countries "USA,United States" to import US orders in USD)'}`)
  say(`  Board order (confirmed / in production / ready to ship): by order number, oldest first.`)
  if (highest.size)
    say(`  Next serial numbers after import: ${[...highest].sort().map(([c, n]) => `${c}-${String(n + 1).padStart(4, '0')}`).join(', ')}`)
  if (KEEP_SERIALS) {
    say('  --keep-serials: every imported serial stays exactly as in the sheet.')
  } else if (reorders.length) {
    say()
    say(`SERIALS THAT WILL BE SWAPPED to follow board order (${reorders.length}) – unbuilt machines only.`)
    say('  (Run with --keep-serials to keep them exactly as in the sheet instead.)')
    for (const c of reorders) say(`  row ${c.row}: order ${c.order} ${c.type}: ${c.from} → ${c.to}`)
  }

  const errors = problems.filter((p) => p.level === 'error').sort((a, b) => a.row - b.row)
  const warnings = problems.filter((p) => p.level === 'warning').sort((a, b) => a.row - b.row)
  say()
  say(`PROBLEMS THAT STOP THE IMPORT (${errors.length})`)
  for (const p of errors) say(`  row ${p.row}: ${p.message}`)
  if (!errors.length) say('  none')
  say()
  say(`WARNINGS – imported anyway, please check (${warnings.length})`)
  for (const p of warnings) say(`  row ${p.row}: ${p.message}`)
  if (!warnings.length) say('  none')

  const report = out.join('\n')
  console.log(report)
  const reportFile = path.join(ROOT, 'import', COMMIT ? 'last-import.txt' : 'last-dry-run.txt')
  fs.mkdirSync(path.dirname(reportFile), { recursive: true })
  fs.writeFileSync(reportFile, report + '\n')
  console.log(`\nThis report was also saved to ${path.relative(ROOT, reportFile)}`)

  const payloadOut = option('payload-out')
  if (payloadOut) {
    fs.writeFileSync(path.resolve(ROOT, payloadOut), JSON.stringify(buildPayload(orders), null, 2))
    console.log(`Payload saved to ${payloadOut}`)
  }

  if (!COMMIT) {
    console.log(errors.length ? '\nFix the problems above, then run again.' : '\nLooks good. To import for real: npm run import-sheet -- --commit')
    return
  }
  if (errors.length) {
    console.error('\nNot imported: fix the problems above first. Nothing was saved.')
    process.exit(1)
  }

  // ---------- Write ----------
  const { data, error: e } = await db!.rpc('import_orders', { p_orders: buildPayload(orders) })
  if (e) {
    console.error(`\nImport failed, nothing was saved: ${e.message}`)
    process.exit(1)
  }
  console.log(`\nImported: ${JSON.stringify(data)}`)
}

/** What import_orders receives: board-stage orders oldest first, so they join the board in that order. */
function buildPayload(orders: OrderOut[]) {
  return [...orders].sort(byOrderNumber).map((o) => ({
    ...o,
    machines: o.machines.map((m) => ({
      machine_type_id: m.machine_type_id,
      serial_number: m.serial_number,
      // --keep-serials: fixed in place, as if typed by hand
      serial_manual: KEEP_SERIALS && !!m.serial_number,
      ready: m.ready,
      source_row: m.source_row,
    })),
  }))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
