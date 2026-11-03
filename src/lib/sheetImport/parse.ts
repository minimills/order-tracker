import { HEADER_EXTRAS } from './layout'
import type { Cell, DraftMachine, DraftOrder, Grid, Msg } from './types'

/*
 * Reads the sheet layout into orders and machines (see layout.ts).
 * Values are kept as editable text; validate.ts decides what they mean.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function isoDate(y: number, m: number, d: number) {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? dt.toISOString().slice(0, 10)
    : null
}

/** A date typed as text → YYYY-MM-DD, or null if it can't be read. */
export function textToDate(s: string): string | null {
  const t = s.trim()
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return isoDate(+m[1], +m[2], +m[3])
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/) // m/d/yyyy (North American)
  if (m) return isoDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2])
  m = t.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s-,]*(\d{4})$/) // 15 Mar 2026
  if (m && MONTHS[m[2].toLowerCase()]) return isoDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1])
  m = t.match(/^([A-Za-z]{3,4})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/) // Mar 15, 2026
  if (m && MONTHS[m[1].toLowerCase()]) return isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2])
  return null
}

/** Spreadsheet day number (days since 1899-12-30) → YYYY-MM-DD. */
export function serialToDate(n: number) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10)
}

const cellText = (c: Cell | undefined): string => {
  if (!c) return ''
  switch (c.kind) {
    case 'text':
      return c.text.trim()
    case 'number':
      return String(c.value)
    case 'date':
      return c.iso
    case 'bool':
      return c.value ? 'TRUE' : 'FALSE'
    default:
      return ''
  }
}

const isEmpty = (c: Cell | undefined) => !c || c.kind === 'empty' || (c.kind === 'text' && c.text.trim() === '')

const ORDER_NO = /^\s*#?\s*(\d{1,6})(?:\.0+)?\s*(?:[-–]\s*(\d{1,3}))?\s*$/

/** "74", 74, "74-1" → "74" / "74-1"; anything else → null. */
export function readOrderCode(c: Cell | undefined): string | null {
  if (!c) return null
  if (c.kind === 'number' && Number.isInteger(c.value) && c.value > 0) return String(c.value)
  if (c.kind !== 'text') return null
  const m = c.text.match(ORDER_NO)
  return m ? (m[2] ? `${+m[1]}-${+m[2]}` : String(+m[1])) : null
}

function isTick(c: Cell | undefined) {
  if (!c) return false
  if (c.kind === 'bool') return c.value
  if (c.kind === 'number') return c.value !== 0
  return c.kind === 'text' && /^(true|yes|y|x|✓|✔|☑|done|ready|built)$/i.test(c.text.trim())
}

type DateRead = { iso: string; problem?: string }

/** A date cell → { iso } ('' when empty). problem is set when the cell had something unreadable. */
function readDate(c: Cell | undefined): DateRead {
  if (isEmpty(c)) return { iso: '' }
  if (c!.kind === 'date') return { iso: c!.iso }
  if (c!.kind === 'number' && c!.value > 20000 && c!.value < 80000) return { iso: serialToDate(c!.value) }
  const t = cellText(c)
  if (/^(-+|–|\?+|n\/?a|tbd|tba|none)$/i.test(t)) return { iso: '' }
  const d = textToDate(t)
  return d ? { iso: d } : { iso: '', problem: t }
}

function readMoney(c: Cell | undefined): { text: string; problem?: string } {
  if (isEmpty(c)) return { text: '' }
  if (c!.kind === 'number') return { text: String(Math.round(c!.value * 100) / 100) }
  const t = cellText(c)
  const cleaned = t.replace(/[$,\s]|CAD|USD/gi, '')
  if (cleaned === '' || cleaned === '-') return { text: '' }
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? { text: cleaned } : { text: '', problem: t }
}

let counter = 0
const newKey = (p: string) => `${p}${++counter}`

/** Column letters → index. */
const COL = Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l, i) => [l, i])) as Record<string, number>

export type ParseResult = {
  orders: DraftOrder[]
  /** Rows above the first order (titles, headings). */
  skippedTop: number
  /** Optional backup columns found in the header row (e.g. Currency → column O). */
  extras: Partial<Record<keyof typeof HEADER_EXTRAS, number>>
}

/** Reads the sheet into editable draft orders. */
export function parseGrid(grid: Grid): ParseResult {
  const orders: DraftOrder[] = []
  let current: DraftOrder | null = null
  let skippedTop = 0

  // Optional columns written by "Download all data", found by their heading in row 1.
  const extras: ParseResult['extras'] = {}
  const header = grid.rows[0] ?? []
  header.forEach((c, i) => {
    const t = cellText(c).toLowerCase()
    for (const [key, label] of Object.entries(HEADER_EXTRAS)) {
      if (t === label.toLowerCase()) extras[key as keyof typeof HEADER_EXTRAS] = i
    }
  })

  grid.rows.forEach((cells, r) => {
    const row = r + 1
    const at = (col: string) => cells[COL[col]]
    const anything = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'I', 'J', 'K', 'L', 'M', 'N'].some((c) => !isEmpty(at(c)))
    if (!anything) return
    const code = readOrderCode(at('A'))

    if (code) {
      // ---------- Order row ----------
      const msgs: Msg[] = []
      const date = (col: string, what: string) => {
        const d = readDate(at(col))
        if (d.problem) msgs.push({ row, level: 'warning', text: `${what} "${d.problem}" isn't a date I can read; it will be left empty.` })
        return d.iso
      }
      const money = (col: string, what: string) => {
        const m = readMoney(at(col))
        if (m.problem) msgs.push({ row, level: 'error', text: `${what} "${m.problem}" is not a number.` })
        return m.text
      }

      const dp = money('I', 'Down payment')
      // Balance: a formula like =48300-I101 means the order total is 48300.
      const L = at('L')
      let total = ''
      const balanceMoney = readMoney(L)
      const formula = L?.kind === 'number' ? L.formula : undefined
      const fm = formula?.match(/^\s*=?\s*\(?\s*([\d.,]+)\s*\)?\s*-\s*\$?I\$?\d+\s*$/i)
      if (fm) {
        total = String(Number(fm[1].replace(/,/g, '')))
      } else if (balanceMoney.text !== '') {
        total = String(Math.round((Number(balanceMoney.text) + (dp ? Number(dp) : 0)) * 100) / 100)
        if (formula) {
          msgs.push({
            row,
            level: 'warning',
            text: `Balance formula =${formula} is not "total − down payment"; its value ${balanceMoney.text} is used as the balance (total ${total}).`,
          })
        }
      } else if (balanceMoney.problem) {
        msgs.push({ row, level: 'error', text: `Balance "${balanceMoney.problem}" is not a number.` })
      } else if (dp) {
        total = dp
      }

      // Received columns: a date, a tick, or an amount.
      const received = (col: string, what: string, dueIso: string) => {
        const c = at(col)
        if (isEmpty(c) || (c!.kind === 'bool' && !c!.value)) return { date: '', amount: '' }
        if (c!.kind === 'date') return { date: c!.iso, amount: '' }
        if (isTick(c) && !(c!.kind === 'number' && c!.value > 1)) {
          msgs.push({ row, level: 'warning', text: `${what} is ticked as received but has no date; ${dueIso || 'today'} will be used.` })
          return { date: dueIso, amount: '' }
        }
        if (c!.kind === 'number' && c!.value > 0 && !(c!.value > 20000 && c!.value < 80000 && Number.isInteger(c!.value))) {
          msgs.push({
            row,
            level: 'warning',
            text: `${what} received shows an amount (${c!.value}) instead of a date; saved as ${c!.value} received${dueIso ? ` on ${dueIso}` : ''}.`,
          })
          return { date: dueIso, amount: String(c!.value) }
        }
        const d = readDate(c)
        if (d.problem) msgs.push({ row, level: 'warning', text: `${what} received "${d.problem}" isn't a date; left as not received.` })
        return { date: d.iso, amount: '' }
      }

      const dpDue = date('J', 'Down payment due date')
      const balanceDue = date('M', 'Balance due date')
      const dpRecv = received('K', 'Down payment', dpDue)
      const balRecv = received('N', 'Balance', balanceDue)
      const extra = (key: keyof typeof HEADER_EXTRAS) => (extras[key] !== undefined ? cellText(cells[extras[key]!]) : '')

      current = {
        key: newKey('o'),
        row,
        include: true,
        code,
        customer: cellText(at('B')),
        expected: date('D', 'Expected ship date'),
        voltage: cellText(at('E')),
        notes: cellText(at('F')),
        actual: date('G', 'Actual ship date'),
        dpAmount: dp,
        dpDue,
        dpReceived: dpRecv.date,
        dpReceivedAmount: dpRecv.amount,
        total,
        balanceDue,
        balanceReceived: balRecv.date,
        balanceReceivedAmount: balRecv.amount,
        delivery: extra('delivery'),
        freight: extra('freight'),
        currency: extra('currency').toUpperCase(),
        stage: extra('stage'),
        readMessages: msgs,
        machines: [],
      }
      orders.push(current)
      return
    }

    if (!current) {
      skippedTop++
      return
    }

    // ---------- Machine row ----------
    const o: DraftOrder = current
    const msgs = o.readMessages
    if (!isEmpty(at('A'))) {
      msgs.push({ row, level: 'warning', text: `Column A "${cellText(at('A'))}" is not an order number; this row is treated as a machine of order ${o.code}.` })
    }
    // An actual ship date sometimes sits on the first machine row.
    const g = readDate(at('G'))
    if (g.iso && !o.actual) {
      o.actual = g.iso
      msgs.push({ row, level: 'info', text: `Actual ship date ${g.iso} found on a machine row; used for order ${o.code}.` })
    }
    const name = cellText(at('B'))
    if (!name) {
      if (!isEmpty(at('C')) || isTick(at('D'))) {
        msgs.push({ row, level: 'warning', text: `Row has a serial or tick but no machine name; it is ignored.` })
      }
      return
    }
    const machine: DraftMachine = {
      key: newKey('m'),
      row,
      include: true,
      name,
      typeChoice: '',
      serial: cellText(at('C')),
      built: isTick(at('D')),
      notes: cellText(at('F')),
    }
    o.machines.push(machine)
  })

  // An order number with nothing else (e.g. the next empty order) is left out.
  for (const o of orders) {
    if (!o.customer && o.machines.length === 0) {
      o.include = false
      o.readMessages.push({ row: o.row, level: 'info', text: `Order ${o.code} has no customer and no machines, so it is left out (tick it to include it).` })
    }
  }
  return { orders, skippedTop, extras }
}
