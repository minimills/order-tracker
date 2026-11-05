import { stageLabel } from '../stages'
import { BOARD_STAGES, STAGES } from '../types'
import { readPlace } from './places'
import { NOT_A_MACHINE, type DraftMachine, type DraftOrder, type Level, type Msg } from './types'

/*
 * Works out what every row in the preview means and what is wrong with it.
 * It is run again after every edit in the preview, so it must be pure.
 */

export type ImportType = { id: string; name: string; code: string | null; archived: boolean }

export type ExistingMachine = {
  id: string
  machine_type_id: string
  serial_number: string | null
  ready: boolean
}
export type ExistingOrder = {
  id: string
  order_code: string
  stage: string
  customer_name: string
  machines: ExistingMachine[]
}

export type ImportContext = {
  types: ImportType[]
  options: { voltage: string[]; delivery_equipment: string[]; freight_type: string[] }
  existing: Map<string, ExistingOrder>
  /** serial → order code, for every serial already in the app */
  serialOwner: Map<string, string>
  keepSerials: boolean
}

export type CheckedMachine = {
  draft: DraftMachine
  level: Level | 'ok'
  msgs: Msg[]
  type: ImportType | null
  /** closest machine type name when the name didn't match */
  suggestion: ImportType | null
  action: 'new' | 'update' | 'note' | 'skip'
  serial: string | null
  serialManual: boolean
}

export type CheckedOrder = {
  draft: DraftOrder
  level: Level | 'ok'
  msgs: Msg[]
  orderNumber: number | null
  split: number | null
  customerName: string
  country: string | null
  state: string | null
  voltage: string | null
  delivery: string | null
  freight: string | null
  currency: 'CAD' | 'USD'
  total: number | null
  dpAmount: number | null
  balance: number | null
  stage: string
  existing: ExistingOrder | null
  machines: CheckedMachine[]
  /** Names of rows marked "not a machine", added to the order notes. */
  extraNotes: string[]
}

export type CheckResult = {
  orders: CheckedOrder[]
  /** Machine types without a code whose serials suggest one, e.g. 4 Spinner/Plyer → 4SPP. */
  codeSuggestions: { type: ImportType; code: string; count: number }[]
  /** File-wide messages */
  general: Msg[]
  /** New orders that go on the board, in the order they will join it. */
  boardOrder: CheckedOrder[]
}

const BOARD = new Set<string>(BOARD_STAGES)

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ')

function distance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

const num = (s: string) => Number(s.match(/(\d+)$/)?.[1] ?? 0)
const money = (s: string) => (s.trim() === '' ? null : Number(s))

/** Splits "SSM-0455" into code + number, preferring codes the app knows. */
function splitSerial(raw: string, knownCodes: string[]): { code: string | null; number: string | null } {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ')
  if (!s) return { code: null, number: null }
  for (const code of knownCodes) {
    if (s === code) return { code, number: null }
    const rest = s.slice(code.length)
    if (s.startsWith(code) && /^[-–\s]*\d+$/.test(rest)) return { code, number: rest.replace(/[^\d]/g, '') }
  }
  let m = s.match(/^([A-Z0-9]*[A-Z][A-Z0-9]*)\s*[-–]\s*(\d+)$/)
  if (m) return { code: m[1], number: m[2] }
  m = s.match(/^([A-Z]+)\s?(\d+)$/)
  if (m) return { code: m[1], number: m[2] }
  if (/^[A-Z0-9]*[A-Z][A-Z0-9]*$/.test(s)) return { code: s, number: null }
  if (/^\d+$/.test(s)) return { code: null, number: s }
  return { code: null, number: null }
}

const formatSerial = (code: string, n: string) => `${code}-${n.replace(/^0+(?=\d{4,})/, '').padStart(4, '0')}`

function worst(levels: (Level | 'ok')[]): Level | 'ok' {
  if (levels.includes('error')) return 'error'
  if (levels.includes('warning')) return 'warning'
  return 'ok'
}

export function checkImport(drafts: DraftOrder[], ctx: ImportContext): CheckResult {
  const activeTypes = ctx.types.filter((t) => !t.archived)
  const byWords = new Map(activeTypes.map((t) => [words(t.name), t]))
  const byCode = new Map(activeTypes.filter((t) => t.code).map((t) => [t.code!.toUpperCase(), t]))
  const typeById = new Map(ctx.types.map((t) => [t.id, t]))
  const knownCodes = [...byCode.keys()].sort((a, b) => b.length - a.length)
  const pick = (list: string[], wanted: string) => list.find((o) => o.toLowerCase() === wanted.toLowerCase()) ?? null

  const seenCodes = new Map<string, number>()
  const seenSerials = new Map<string, number>()
  const codeVotes = new Map<string, Map<string, number>>() // type id → code → count
  const general: Msg[] = []

  const orders: CheckedOrder[] = drafts.map((d) => {
    const msgs: Msg[] = [...d.readMessages]
    const add = (level: Level, text: string, row = d.row) => msgs.push({ row, level, text })

    // ---------- Order number ----------
    const m = d.code.trim().match(/^#?\s*(\d{1,6})\s*(?:[-–]\s*(\d{1,3}))?$/)
    const orderNumber = m ? Number(m[1]) : null
    const split = m && m[2] ? Number(m[2]) : null
    const code = orderNumber ? `${orderNumber}${split ? `-${split}` : ''}` : d.code
    if (!orderNumber) add('error', `"${d.code}" is not an order number (like 74 or 74-1).`)
    const existing = orderNumber ? (ctx.existing.get(code) ?? null) : null
    if (d.include && orderNumber) {
      const prev = seenCodes.get(code)
      if (prev) add('error', `Order ${code} appears twice in the file (also row ${prev}). Untick one of them.`)
      else seenCodes.set(code, d.row)
    }
    if (existing) add('info', `Order ${code} is already in the app: it will be updated. Empty cells keep what the app has.`)

    // ---------- Customer ----------
    const comma = d.customer.lastIndexOf(',')
    const customerName = (comma >= 0 ? d.customer.slice(0, comma) : d.customer).trim()
    const place = readPlace(comma >= 0 ? d.customer.slice(comma + 1) : '')
    if (!customerName && !existing) add('error', `Order ${code} has no customer.`)
    if (customerName && comma < 0) add('info', `No ", Country" after the customer name, so no country is saved.`)
    if (place.note) add(place.note.includes('Please check') ? 'warning' : 'info', place.note)

    // ---------- Voltage ----------
    let voltage: string | null = null
    const v = d.voltage.trim()
    if (!v) {
      voltage = existing ? null : 'Unknown'
    } else if (/^(\?+|-+|–|unknown|tbd|n\/?a)$/i.test(v)) {
      voltage = 'Unknown'
      add('warning', `Voltage "${v}" will be saved as Unknown${existing ? ' (a voltage already set in the app is kept)' : ''}.`)
    } else {
      voltage = pick(ctx.options.voltage, v) ?? ctx.options.voltage.find((o) => o.startsWith(v.match(/\d{3}/)?.[0] ?? '###')) ?? null
      if (!voltage) {
        voltage = 'Unknown'
        add('warning', `Voltage "${v}" is not in the Voltage list; it will be saved as Unknown.`)
      }
    }

    // ---------- Delivery and freight (from the notes, or the backup columns) ----------
    const n = d.notes.toLowerCase()
    let deliveryWanted: string | null = d.delivery || null
    if (!deliveryWanted) {
      if (/no[\s-]*lift[\s-]*gate/.test(n)) deliveryWanted = 'No liftgate'
      else if (/lift[\s-]*gate/.test(n)) deliveryWanted = 'Liftgate'
      else if (/tractor/.test(n)) deliveryWanted = 'Tractor with forks'
      else if (/fork[\s-]*lift/.test(n)) deliveryWanted = 'Forklift'
    }
    const freightFound: string[] = []
    if (d.freight) freightFound.push(d.freight)
    else {
      if (/\blcl\b/.test(n)) freightFound.push('LCL')
      if (/\bftl\b/.test(n)) freightFound.push('FTL')
      if (/\bltl\b/.test(n)) freightFound.push('LTL')
      if (/\b40\s*('|’|ft\b|foot|feet|hc\b)|\b40'|container/.test(n)) freightFound.push("40' container")
    }
    if (freightFound.length > 1) add('warning', `The notes mention more than one freight type (${freightFound.join(', ')}); ${freightFound[0]} is used.`)
    let delivery = deliveryWanted ? pick(ctx.options.delivery_equipment, deliveryWanted) : null
    if (deliveryWanted && !delivery) add('warning', `"${deliveryWanted}" is not in the Delivery equipment list; left as Unknown.`)
    const freight = freightFound[0] ? pick(ctx.options.freight_type, freightFound[0]) : null
    if (freightFound[0] && !freight) add('warning', `"${freightFound[0]}" is not in the Freight type list; left empty.`)
    if (!delivery && !existing) delivery = 'Unknown'
    if (d.notes && !d.delivery && !d.freight && (deliveryWanted || freightFound[0])) {
      const found = [deliveryWanted && delivery && `delivery: ${delivery}`, freight && `freight: ${freight}`].filter(Boolean)
      if (found.length) add('info', `Notes "${d.notes}" → ${found.join(', ')} (the note is kept too).`)
    }

    // ---------- Currency ----------
    const cur = d.currency.trim().toUpperCase()
    if (cur && cur !== 'CAD' && cur !== 'USD') add('error', `Currency "${d.currency}" must be CAD or USD.`)
    const currency: 'CAD' | 'USD' = cur === 'USD' ? 'USD' : 'CAD'

    // ---------- Money ----------
    const total = money(d.total)
    const dpAmount = money(d.dpAmount)
    if (d.total.trim() !== '' && Number.isNaN(total)) add('error', `Order total "${d.total}" is not a number.`)
    if (d.dpAmount.trim() !== '' && Number.isNaN(dpAmount)) add('error', `Down payment "${d.dpAmount}" is not a number.`)
    if (total !== null && dpAmount !== null && dpAmount > total) add('error', `The down payment (${dpAmount}) is more than the order total (${total}).`)
    for (const [label, val] of [
      ['Down payment received amount', d.dpReceivedAmount],
      ['Balance received amount', d.balanceReceivedAmount],
    ] as const)
      if (val.trim() !== '' && Number.isNaN(Number(val))) add('error', `${label} "${val}" is not a number.`)

    // ---------- Machines ----------
    const usedExisting = new Set<string>()
    const extraNotes: string[] = []
    const machines: CheckedMachine[] = d.machines.map((dm) => {
      const mm: Msg[] = []
      const madd = (level: Level, text: string) => mm.push({ row: dm.row, level, text })
      if (!dm.include) {
        return { draft: dm, level: 'ok', msgs: [], type: null, suggestion: null, action: 'skip', serial: null, serialManual: false }
      }
      if (dm.typeChoice === NOT_A_MACHINE) {
        extraNotes.push(dm.name)
        madd('info', `"${dm.name}" is not a machine: it will be added to the order notes.`)
        return { draft: dm, level: 'ok', msgs: mm, type: null, suggestion: null, action: 'note', serial: null, serialManual: false }
      }

      const parts = splitSerial(dm.serial, knownCodes)
      let type: ImportType | null = dm.typeChoice ? (typeById.get(dm.typeChoice) ?? null) : (byWords.get(words(dm.name)) ?? byCode.get(dm.name.trim().toUpperCase()) ?? null)
      let suggestion: ImportType | null = null
      if (!type && !dm.typeChoice && parts.code && byCode.get(parts.code)) {
        type = byCode.get(parts.code)!
        madd('info', `"${dm.name}" read as ${type.name} from its serial ${dm.serial}.`)
      }
      if (!type) {
        const target = words(dm.name)
        let best: ImportType | null = null
        let bestD = Infinity
        for (const t of activeTypes) {
          const dd = distance(target, words(t.name))
          if (dd < bestD) {
            bestD = dd
            best = t
          }
        }
        if (best && bestD <= Math.max(2, Math.floor(target.length * 0.2))) suggestion = best
        madd(
          'error',
          `"${dm.name}" doesn't match a machine type.${suggestion ? ` Did you mean ${suggestion.name}?` : ''} Pick one from the list, create a new type, or choose "Not a machine".`,
        )
        return { draft: dm, level: 'error', msgs: mm, type: null, suggestion, action: 'new', serial: null, serialManual: false }
      }

      // Serial
      let serial: string | null = null
      let serialManual = false
      const raw = dm.serial.trim()
      if (!raw) {
        madd('warning', `No serial number: it will be saved as "needs serial".`)
      } else if (!parts.number) {
        madd('warning', `Serial "${raw}" has no number and will be saved as "needs serial".`)
      } else {
        const code = parts.code ?? type.code
        if (!code) {
          madd('warning', `Serial "${raw}" has no letters and ${type.name} has no code; it will be saved as "needs serial".`)
        } else {
          serial = formatSerial(code, parts.number)
          if (!parts.code) madd('info', `Serial "${raw}" has no code; read as ${serial}.`)
          if (!type.code) {
            serialManual = true
            const votes = codeVotes.get(type.id) ?? new Map<string, number>()
            votes.set(code, (votes.get(code) ?? 0) + 1)
            codeVotes.set(type.id, votes)
            madd('info', `${type.name} has no code in the app yet, so ${serial} is kept exactly as typed.`)
          } else if (code !== type.code) {
            serialManual = true
            madd('warning', `Serial ${serial} doesn't start with ${type.code} (the code for ${type.name}); it will be kept exactly as typed.`)
          }
          if (ctx.keepSerials) serialManual = true
        }
      }

      // Duplicates
      if (serial) {
        const prev = d.include ? seenSerials.get(serial) : undefined
        if (prev) madd('error', `Serial ${serial} is used twice in the file (also row ${prev}).`)
        else if (d.include) seenSerials.set(serial, dm.row)
        const owner = ctx.serialOwner.get(serial)
        if (owner && owner !== code) madd('error', `Serial ${serial} is already used by order ${owner}.`)
      }

      // Update or new (same rules as the database)
      let action: CheckedMachine['action'] = 'new'
      if (existing) {
        const sameSerial = serial ? existing.machines.find((x) => x.serial_number === serial) : undefined
        const candidate =
          sameSerial ??
          existing.machines.find(
            (x) => !usedExisting.has(x.id) && x.machine_type_id === type!.id && (serial === null || x.serial_number === null),
          )
        if (candidate) {
          usedExisting.add(candidate.id)
          action = 'update'
        } else {
          madd('info', `New machine: it will be added to order ${code}.`)
        }
      }
      const level = worst(mm.map((x) => x.level))
      return { draft: dm, level, msgs: mm, type, suggestion: null, action, serial, serialManual }
    })
    if (existing) {
      const left = existing.machines.length - usedExisting.size
      if (left > 0) add('info', `${left} machine${left === 1 ? '' : 's'} already in the app ${left === 1 ? 'is' : 'are'} not in the file; ${left === 1 ? 'it is' : 'they are'} kept.`)
    }

    // ---------- Stage ----------
    let stage: string
    const wantedStage = d.stage.trim()
    const included = machines.filter((x) => x.action === 'new' || x.action === 'update')
    if (wantedStage) {
      // The stored name ("Ready") or the name shown in the app ("Ready / testing") both work.
      const w = wantedStage.toLowerCase()
      stage = STAGES.find((s) => s.toLowerCase() === w || stageLabel(s).toLowerCase() === w) ?? ''
      if (!stage) add('error', `Stage "${wantedStage}" is not one of: ${STAGES.map((s) => stageLabel(s)).join(', ')}.`)
    } else if (d.actual) stage = 'Shipped'
    else if (/cancel+ed|\bcancel\b/i.test(d.notes)) stage = 'Cancelled'
    else if (included.length > 0 && included.every((x) => x.draft.built)) stage = 'Ready to ship'
    else if (included.some((x) => x.draft.built)) stage = 'In production'
    else stage = 'Confirmed'
    if (existing) {
      if ((stage === 'Shipped' || stage === 'Cancelled') && existing.stage !== stage) add('info', `Stage will change from ${stageLabel(existing.stage)} to ${stageLabel(stage)}.`)
      else if (stage !== existing.stage) {
        add('info', `The app has this order as ${stageLabel(existing.stage)}; that is kept.`)
        stage = existing.stage
      }
    } else if (!wantedStage) {
      add('info', `Will be saved as ${stage}${stage === 'Shipped' ? ' (it has an actual ship date)' : ''}.`)
    }
    if (stage === 'Shipped') {
      const unticked = machines.filter((x) => (x.action === 'new' || x.action === 'update') && !x.draft.built).length
      if (unticked) add('info', `The order is shipped, so its ${unticked} unticked machine${unticked === 1 ? '' : 's'} will be saved as built.`)
    }
    if (!d.expected && !existing && BOARD.has(stage)) add('warning', 'No expected ship date.')
    if (total === null && !existing) {
      add(stage === 'Shipped' || stage === 'Cancelled' ? 'info' : 'warning', 'No down payment or balance in the file, so the order total will be 0.')
    }

    const level = worst([...msgs.map((x) => x.level), ...machines.map((x) => x.level)])
    return {
      draft: d,
      level: d.include ? level : 'ok',
      msgs,
      orderNumber,
      split,
      customerName,
      country: place.country,
      state: place.state,
      voltage,
      delivery,
      freight,
      currency,
      total,
      dpAmount,
      balance: total !== null ? Math.round((total - (dpAmount ?? 0)) * 100) / 100 : null,
      stage,
      existing,
      machines,
      extraNotes,
    }
  })

  // Machine types without a code: suggest the code their serials use.
  const codeSuggestions: CheckResult['codeSuggestions'] = []
  for (const [typeId, votes] of codeVotes) {
    const [code, count] = [...votes].sort((a, b) => b[1] - a[1])[0]
    const type = typeById.get(typeId)
    if (type && !byCode.has(code)) codeSuggestions.push({ type, code, count })
  }

  // New orders that go on the board join it in an order worked out from their
  // serial numbers (an order holding lower serials goes first), so the serials
  // in the file can stay as they are. Orders without serials go by order number.
  const boardNew = orders.filter((o) => o.draft.include && !o.existing && BOARD.has(o.stage) && o.orderNumber)
  const boardOrder = boardSequence(boardNew)

  // Any serial that still has to move to keep "lower board number = lower serial".
  if (!ctx.keepSerials) {
    const byType = new Map<string, CheckedMachine[]>()
    for (const o of boardOrder)
      for (const mc of o.machines)
        if (mc.type && mc.action === 'new' && mc.serial && !mc.serialManual && !mc.draft.built)
          byType.set(mc.type.id, [...(byType.get(mc.type.id) ?? []), mc])
    for (const list of byType.values()) {
      const sorted = list.map((x) => x.serial!).sort((a, b) => num(a) - num(b) || a.localeCompare(b))
      list.forEach((mc, i) => {
        if (mc.serial !== sorted[i]) {
          mc.msgs.push({
            row: mc.draft.row,
            level: 'warning',
            text: `Will become ${sorted[i]} so that lower board numbers get lower serials. Tick "Keep serials exactly as in the file" to stop this.`,
          })
          mc.level = worst([mc.level, 'warning'])
        }
      })
    }
    for (const o of orders) o.level = o.draft.include ? worst([...o.msgs.map((x) => x.level), ...o.machines.map((x) => x.level)]) : 'ok'
  }

  return { orders, codeSuggestions, general, boardOrder }
}

/**
 * Orders sharing a machine type are put so that the one with the lower serial
 * comes first; otherwise by order number. Conflicts fall back to order number.
 */
function boardSequence(list: CheckedOrder[]): CheckedOrder[] {
  const byNumber = [...list].sort((a, b) => a.orderNumber! - b.orderNumber! || (a.split ?? 0) - (b.split ?? 0))
  const lowest = new Map<CheckedOrder, Map<string, number>>()
  for (const o of byNumber) {
    const m = new Map<string, number>()
    for (const mc of o.machines)
      if (mc.type && mc.serial && !mc.draft.built && (mc.action === 'new' || mc.action === 'update'))
        m.set(mc.type.id, Math.min(m.get(mc.type.id) ?? Infinity, num(mc.serial)))
    lowest.set(o, m)
  }
  // a must come before b?
  const before = (a: CheckedOrder, b: CheckedOrder) => {
    let votesA = 0
    let votesB = 0
    for (const [t, n] of lowest.get(a)!) {
      const other = lowest.get(b)!.get(t)
      if (other === undefined) continue
      if (n < other) votesA++
      else if (other < n) votesB++
    }
    return votesA > votesB
  }
  const placed: CheckedOrder[] = []
  const left = [...byNumber]
  while (left.length) {
    // The first order (by number) that no other remaining order must precede.
    const i = left.findIndex((o) => !left.some((p) => p !== o && before(p, o)))
    placed.push(...left.splice(i >= 0 ? i : 0, 1))
  }
  return placed
}
