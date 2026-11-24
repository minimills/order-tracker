import { supabase } from './supabase'
import { tr } from '../i18n'

// Freight: shipment cost breakdowns, quote request emails, insurance summary.
// The arithmetic matches the old Freight Multitool app.

export const FREIGHT_TYPES = ['LTL', 'FTL', 'LCL', 'FCL', 'Air'] as const
export type FreightType = (typeof FREIGHT_TYPES)[number]
export type FreightCurrency = 'CAD' | 'USD'

export type FreightSettings = {
  broker_fee: number
  rates: Record<FreightCurrency, { hourly: number; plywood: number }>
  insurance: { uplift: number; rate_pct: number; minimum: number }
  margin_presets: number[]
  exchange_rate: number
  pickup_locations: { name: string; address: string }[]
  ocean_air_types: string[]
  /** 0054: the person who arranges shipping (told when an order's crates are all entered). */
  shipping_contact?: string | null
}

export const FREIGHT_DEFAULTS: FreightSettings = {
  broker_fee: 180,
  rates: { CAD: { hourly: 65, plywood: 65 }, USD: { hourly: 50, plywood: 50 } },
  insurance: { uplift: 1.1, rate_pct: 0.5, minimum: 50 },
  margin_presets: [10, 20, 30],
  exchange_rate: 1.35,
  pickup_locations: [],
  ocean_air_types: ['LCL', 'FCL', 'Air'],
}

export type FreightAgent = {
  id: string
  name: string
  contact_name: string | null
  contact_email: string | null
  auto_insurance: boolean
  sub_contractor: boolean
  sort_order: number
  archived: boolean
}

export type Breakdown = {
  id: string
  order_id: string | null
  customer_name: string | null
  quote_number: string | null
  invoice_number: string | null
  ship_date: string | null
  freight_type: FreightType
  currency: FreightCurrency
  exchange_rate: number
  invoice_total: number
  agent_id: string | null
  agent_name: string | null
  agent_ref: string | null
  sub_contractor: string | null
  carrier: string | null
  tracking_number: string | null
  cargo_value: number
  freight: number
  insurance: number
  insurance_auto: boolean
  broker_fees: number
  broker_standard: boolean
  hourly_rate: number
  hours: number
  plywood_rate: number
  plywood_sheets: number
  margin_pct: number
  handling: number
  subtotal: number
  freight_subtotal: number
  breakdown_total: number
  total_with_margin: number
  freight_with_margin: number
  price_difference: number
  insured_value: number
  invoice_total_cad: number
  cargo_value_cad: number
  freight_cad: number
  insurance_cad: number
  breakdown_total_cad: number
  total_with_margin_cad: number
  price_difference_cad: number
  insured_value_cad: number
  notes: string | null
  source: 'app' | 'import'
  created_by_name: string | null
  updated_by_name: string | null
  archived: boolean
  created_at: string
  updated_at: string
}

export type OrderCrate = { id: string; length_cm: number | null; width_cm: number | null; height_cm: number | null; weight_kg: number | null; contents: string | null }

export type FreightOrderInfo = {
  order_id: string
  order_code: string
  customer_name: string | null
  customer_company: string | null
  country: string | null
  state_province: string | null
  customer_phone: string | null
  customer_emails: string[]
  quote_number: string | null
  invoice_number: string | null
  currency: FreightCurrency
  order_total: number | null
  freight_type: string | null
  delivery_equipment: string | null
  actual_ship_date: string | null
  expected_ship_date: string | null
  crating_hours: number | null
  plywood_sheets: number | null
  crates: OrderCrate[]
}

export async function loadFreightSettings(): Promise<FreightSettings> {
  if (!supabase) return FREIGHT_DEFAULTS
  const { data } = await supabase.rpc('freight_settings')
  const v = (data as Partial<FreightSettings> | null) ?? {}
  return {
    ...FREIGHT_DEFAULTS,
    ...v,
    rates: { CAD: { ...FREIGHT_DEFAULTS.rates.CAD, ...v.rates?.CAD }, USD: { ...FREIGHT_DEFAULTS.rates.USD, ...v.rates?.USD } },
    insurance: { ...FREIGHT_DEFAULTS.insurance, ...v.insurance },
  }
}

export async function loadAgents(): Promise<FreightAgent[]> {
  if (!supabase) return []
  const { data } = await supabase.from('freight_agents').select('*').order('sort_order').order('name')
  return (data as FreightAgent[] | null) ?? []
}

/** The order's freight type as one of ours ("40' container" = FCL); empty when it has no match. */
export function orderFreightType(v: string | null | undefined): FreightType | '' {
  if (!v) return ''
  if ((FREIGHT_TYPES as readonly string[]).includes(v)) return v as FreightType
  if (/container/i.test(v)) return 'FCL'
  return ''
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Insurance by the rule in the freight settings: the larger of (cargo + freight) × uplift × rate % and the minimum. */
export function insuranceFor(cargo: number, freight: number, s: FreightSettings) {
  return round2(Math.max(((cargo + freight) * s.insurance.uplift * s.insurance.rate_pct) / 100, s.insurance.minimum))
}

export type BreakdownNumbers = {
  invoice_total: number
  cargo_value: number
  freight: number
  insurance: number
  broker_fees: number
  hourly_rate: number
  hours: number
  plywood_rate: number
  plywood_sheets: number
  margin_pct: number
}

/** The results of a breakdown (the database works out the same numbers when it is saved). */
export function calcBreakdown(n: BreakdownNumbers) {
  const handling = round2(n.hours * n.hourly_rate + n.plywood_sheets * n.plywood_rate)
  const subtotal = round2(n.cargo_value + n.freight + n.insurance + n.broker_fees + handling)
  const freight_subtotal = round2(subtotal - n.cargo_value)
  const breakdown_total = subtotal
  return {
    handling,
    subtotal,
    freight_subtotal,
    breakdown_total,
    total_with_margin: round2(breakdown_total * (1 + n.margin_pct / 100)),
    freight_with_margin: round2(freight_subtotal * (1 + n.margin_pct / 100)),
    price_difference: round2(n.invoice_total - breakdown_total),
  }
}

/**
 * A typed amount that may be a sum, for example "12000+850" (as in the old app).
 * Only + - * / and brackets; null when it is not a valid sum.
 */
export function evaluateExpression(input: string): number | null {
  const expr = input.replace(/[\s,$]/g, '')
  if (!expr) return 0
  const tokens = expr.match(/\d+\.?\d*|\.\d+|[+\-*/()]/g)
  if (!tokens || tokens.join('') !== expr) return null
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  function factor(): number {
    if (peek() === '(') {
      next()
      const v = sum()
      if (next() !== ')') throw new Error(tr("bracket"))
      return v
    }
    if (peek() === '-') {
      next()
      return -factor()
    }
    const t = next()
    if (t === undefined || Number.isNaN(Number(t))) throw new Error(tr("token"))
    return Number(t)
  }
  function term(): number {
    let v = factor()
    while (peek() === '*' || peek() === '/') v = next() === '*' ? v * factor() : v / factor()
    return v
  }
  function sum(): number {
    let v = term()
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term()
    return v
  }
  try {
    const v = sum()
    return pos === tokens.length && Number.isFinite(v) ? round2(v) : null
  } catch {
    return null
  }
}

/** "7.5 hours × $65 + 8 sheets × $65" for the printout. */
export function handlingText(b: Pick<Breakdown, 'hours' | 'hourly_rate' | 'plywood_sheets' | 'plywood_rate'>) {
  const parts: string[] = []
  if (Number(b.hours)) parts.push(`${Number(b.hours)} hours × $${Number(b.hourly_rate)}`)
  if (Number(b.plywood_sheets)) parts.push(`${Number(b.plywood_sheets)} sheets × $${Number(b.plywood_rate)}`)
  return parts.join(' + ')
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Freight quote request email (wording of the old Email Agent)
// ---------------------------------------------------------------------------
export const BULK_TYPES = ['FTL', 'FCL']
export const QUOTE_TYPES = ['LTL', 'FTL', 'LCL', 'FCL', 'Air'] as const
export const GREETINGS = ['Hi', 'Hello', 'Dear']
export const CONTAINER_SIZES = ['20\' Standard', '40\' Standard', '40\' High Cube', '45\' High Cube']

export type CargoItem = { key: string; qty: string; pkg: string; desc: string; weight: string; l: string; w: string; h: string }

export type QuoteForm = {
  agentName: string
  greeting: string
  shipmentType: string
  origin: string
  destination: string
  pickup: string
  delivery: string
  businessName: string
  notABusiness: boolean
  consigneeName: string
  consigneePhone: string
  consigneeEmail: string
  weightUnit: 'kg' | 'lb'
  dimUnit: 'cm' | 'in'
  items: CargoItem[]
  bulkCommodity: string
  bulkItems: string
  bulkSpace: string
  bulkSpaceUnit: string
  bulkWeight: string
  containerSize: string
  liftgateOrigin: 'Yes' | 'No'
  liftgateDestination: 'Yes' | 'No'
}

export function quoteSubject(f: QuoteForm, company = 'Belfast Mini Mills') {
  return `${company} | ${f.shipmentType} - ${f.origin.trim()} to ${f.destination.trim()}`
}

function cargoText(f: QuoteForm) {
  if (BULK_TYPES.includes(f.shipmentType)) {
    const lines = [`Cargo: ${f.bulkCommodity.trim()}`]
    if (f.bulkItems.trim()) lines.push(`Total items: ${f.bulkItems.trim()}`)
    if (f.bulkSpace.trim()) lines.push(`Total space: ${f.bulkSpace.trim()} ${f.bulkSpaceUnit}`)
    if (f.bulkWeight.trim()) lines.push(`Weight: ${f.bulkWeight.trim()} ${f.weightUnit}`)
    if (f.shipmentType === 'FCL') lines.push(`Container size required: ${f.containerSize}`)
    return lines.join('\n')
  }
  const lines = ['Cargo:']
  for (const i of f.items) {
    const dims = i.l || i.w || i.h
    if (!i.qty && !i.pkg && !i.desc && !i.weight && !dims) continue
    let line = '-'
    const qtyPkg = [i.qty, i.pkg].filter(Boolean).join(' ')
    if (qtyPkg) line += ` ${qtyPkg}`
    if (i.desc) line += `${qtyPkg ? ' of' : ''} ${i.desc}`
    if (i.weight) line += ` — ${i.weight} ${f.weightUnit}`
    if (dims) line += ` — ${i.l || 0} x ${i.w || 0} x ${i.h || 0} ${f.dimUnit}`
    lines.push(line)
  }
  return lines.join('\n')
}

export function quoteBody(f: QuoteForm, signature = '') {
  const first = f.agentName.trim().split(/\s+/)[0] || 'there'
  const article = /^[AEFHILMNORSX]/.test(f.shipmentType) ? 'an' : 'a'
  const delivery = f.notABusiness ? `Delivery: ${f.delivery.trim()}` : `Delivery: ${f.businessName.trim()}\n${f.delivery.trim()}`
  return `${f.greeting} ${first},

Can you please provide us a quote for ${article} ${f.shipmentType} to ${f.destination.trim()}.

Pick up: ${f.pickup.trim()}

${delivery}

Consignee name: ${f.consigneeName.trim()}
Consignee Phone: ${f.consigneePhone.trim()}
Consignee Email: ${f.consigneeEmail.trim()}

${cargoText(f)}

Lift-gate at origin: ${f.liftgateOrigin}
Lift-gate at destination: ${f.liftgateDestination}${signature ? `\n\nThank you,\n${signature}` : ''}`
}

/** A crate from the crating data as a cargo line in the chosen units. */
export function crateToItem(c: OrderCrate, weightUnit: 'kg' | 'lb', dimUnit: 'cm' | 'in'): CargoItem {
  const len = (cm: number | null) => (cm == null ? '' : String(Math.round((dimUnit === 'cm' ? Number(cm) : Number(cm) / 2.54) * 10) / 10))
  const wt = c.weight_kg == null ? '' : String(weightUnit === 'kg' ? Math.round(Number(c.weight_kg) * 10) / 10 : Math.round(Number(c.weight_kg) * 2.2046226218))
  return { key: c.id, qty: '1', pkg: 'crate', desc: c.contents ?? '', weight: wt, l: len(c.length_cm), w: len(c.width_cm), h: len(c.height_cm) }
}

// ---------------------------------------------------------------------------
// CSV of the old Freight Multitool sheet
// ---------------------------------------------------------------------------
/** Reads CSV text into rows of cells (quotes, commas and line breaks inside quotes handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

/** The columns the old app saved (its sheet's header row). */
export const IMPORT_COLUMNS = [
  'timestamp', 'shipDate', 'customerName', 'quoteNumber', 'invoiceNumber', 'refNumber', 'livingstonRef', 'carrier', 'subContractor',
  'enteredCurrency', 'exchangeRate', 'freightType', 'invoiceTotal', 'cargoValue', 'freight', 'insurance', 'brokerFees',
  'hourlyRate', 'hours', 'plywoodRate', 'plywoodSheets', 'marginPct',
] as const
export type ImportRow = Partial<Record<(typeof IMPORT_COLUMNS)[number], string>> & { order_id?: string | null }

const cleanNumber = (v: string) => v.replace(/[$,\s]/g, '')
const NUMBER_COLUMNS = new Set(['exchangeRate', 'invoiceTotal', 'cargoValue', 'freight', 'insurance', 'brokerFees', 'hourlyRate', 'hours', 'plywoodRate', 'plywoodSheets', 'marginPct'])

/** A date from the sheet as YYYY-MM-DD ("2025-05-30", "5/30/2025", ISO time); empty when unreadable. */
function sheetDate(v: string) {
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return ''
}

/** The sheet's rows, by its header names (any order, capitals and spaces ignored). */
export function readImport(text: string): { rows: ImportRow[]; missing: string[] } {
  const table = parseCsv(text)
  if (table.length < 2) return { rows: [], missing: [] }
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '')
  const header = table[0].map(norm)
  const at = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, header.indexOf(norm(c))])) as Record<string, number>
  const missing = ['customerName', 'invoiceTotal', 'cargoValue', 'freight'].filter((c) => at[c] < 0)
  const rows = table.slice(1).map((r) => {
    const out: ImportRow = {}
    for (const c of IMPORT_COLUMNS) {
      if (at[c] < 0) continue
      let v = (r[at[c]] ?? '').trim()
      if (NUMBER_COLUMNS.has(c)) v = cleanNumber(v)
      if (c === 'shipDate') v = sheetDate(v)
      if (c === 'timestamp' && v && Number.isNaN(new Date(v).getTime())) v = ''
      out[c] = v
    }
    return out
  })
  return { rows: rows.filter((r) => r.customerName || r.invoiceNumber || r.quoteNumber || Number(r.invoiceTotal)), missing }
}
