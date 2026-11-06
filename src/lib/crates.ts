import { supabase } from './supabase'
import type { Stage } from './types'
import { showDims, showNumber, showWeight, weightFromKg, weightUnit, type Units } from './units'

/** One row of the crate_report view (sizes in cm, weights in kg). */
export type CrateRow = {
  id: string
  order_id: string
  order_code: string
  order_number: number
  split_number: number | null
  stage: Stage
  customer_name: string
  customer_company: string | null
  customer_country: string | null
  length_cm: number | null
  width_cm: number | null
  height_cm: number | null
  weight_kg: number | null
  plywood_sheets: number | null
  build_hours: number | null
  crated_on: string
  crated_by: string | null
  notes: string | null
  created_at: string
  machine_ids: string[]
  machine_type_ids: string[]
  /** One name per machine in the crate (a crate with two pickers lists "Picker" twice). */
  machine_types: string[]
  serials: string[]
}

/** A crate with its number on the order ("Crate 2"). */
export type NumberedCrate = CrateRow & { number: number }

/** A machine as the crating screens need it. */
export type CrateMachine = { id: string; label: string }

/** Stages where crating is shown and can be marked. */
export const CRATING_STAGES: Stage[] = ['Ready to ship', 'Shipped']

/** The order's crates numbered 1, 2, 3… in the order they were made. */
export function numberCrates(crates: CrateRow[]): NumberedCrate[] {
  return [...crates]
    .sort((a, b) => a.crated_on.localeCompare(b.crated_on) || a.created_at.localeCompare(b.created_at))
    .map((c, i) => ({ ...c, number: i + 1 }))
}

/** Loads the (not archived) crates of some orders, numbered per order. */
export async function loadCrates(orderIds: string[]) {
  if (!supabase || orderIds.length === 0) return { byOrder: new Map<string, NumberedCrate[]>(), error: null }
  const { data, error } = await supabase.from('crate_report').select('*').in('order_id', orderIds)
  const byOrder = new Map<string, NumberedCrate[]>()
  const grouped = new Map<string, CrateRow[]>()
  for (const c of (data as CrateRow[] | null) ?? []) {
    grouped.set(c.order_id, [...(grouped.get(c.order_id) ?? []), c])
  }
  for (const [id, list] of grouped) byOrder.set(id, numberCrates(list))
  return { byOrder, error }
}

/** "Carder - Large" or "2 × Picker + Carder - Small"; "(no machines)" if they were all removed. */
export function contentsLabel(machineTypes: string[]) {
  if (machineTypes.length === 0) return '(no machines)'
  const counts = new Map<string, number>()
  for (const t of machineTypes) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n > 1 ? `${n} × ${name}` : name)).join(' + ')
}

/** "Carder - Large LCR-2072 + Picker PCK-0031" */
export function contentsWithSerials(c: CrateRow) {
  if (c.machine_types.length === 0) return '(no machines)'
  return contentsLabel(c.machine_types) + (c.serials.length ? ` (${c.serials.join(', ')})` : '')
}

/** "96 × 48 × 60 in · 1,200 lb · 4 sheets · 6.5 h" – the short line shown under a machine. */
export function crateLine(c: CrateRow, units: Units) {
  const parts = [
    showDims(c, units) ?? 'size not entered',
    c.weight_kg == null ? 'weight not entered' : showWeight(c.weight_kg, units),
  ]
  if (c.plywood_sheets != null) parts.push(`${showNumber(c.plywood_sheets)} sheet${c.plywood_sheets === 1 ? '' : 's'}`)
  if (c.build_hours != null) parts.push(`${showNumber(c.build_hours)} h`)
  return parts.join(' · ')
}

/**
 * Text to paste into a freight quote request: number of crates, each crate's
 * size and weight, and the total weight, in the person's units.
 */
export function freightSummary(
  order: { order_code: string; customer_name: string; customer_country: string | null },
  crates: NumberedCrate[],
  units: Units,
  notCrated: string[],
) {
  const lines: string[] = []
  const where = order.customer_country ? ` (${order.customer_country})` : ''
  lines.push(`Order ${order.order_code} – ${order.customer_name}${where}`)
  const total = crates.reduce((sum, c) => sum + (c.weight_kg ?? 0), 0)
  const missingWeight = crates.filter((c) => c.weight_kg == null).length
  lines.push(`${crates.length} crate${crates.length === 1 ? '' : 's'}, dimensions L × W × H`)
  lines.push('')
  for (const c of crates) {
    const dims = showDims(c, units) ?? 'size not entered yet'
    const weight = c.weight_kg == null ? 'weight not entered yet' : showWeight(c.weight_kg, units)
    lines.push(`Crate ${c.number}: ${dims}, ${weight} – ${contentsLabel(c.machine_types)}`)
  }
  lines.push('')
  lines.push(
    `Total weight: ${showNumber(weightFromKg(total, units), units === 'imperial' ? 0 : 1)} ${weightUnit(units)}` +
      (missingWeight ? ` (not counting ${missingWeight} crate${missingWeight === 1 ? '' : 's'} with no weight yet)` : ''),
  )
  if (notCrated.length) lines.push(`Not crated yet: ${notCrated.join(', ')}`)
  return lines.join('\n')
}
