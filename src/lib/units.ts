/**
 * Imperial / Metric for crate sizes and weights.
 * The database always stores metric (cm, kg); these helpers convert for display
 * and convert typed values back to metric for saving.
 */

export type Units = 'imperial' | 'metric'

export const CM_PER_INCH = 2.54
export const KG_PER_LB = 0.45359237

export function lengthUnit(units: Units) {
  return units === 'imperial' ? 'in' : 'cm'
}

export function weightUnit(units: Units) {
  return units === 'imperial' ? 'lb' : 'kg'
}

function round(n: number, decimals: number) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

// Sensible rounding: inches and cm to one decimal, pounds to the whole pound,
// kilograms to one decimal.
const LENGTH_DECIMALS = 1
const WEIGHT_DECIMALS: Record<Units, number> = { imperial: 0, metric: 1 }

/** cm → number in the user's units (rounded). */
export function lengthFromCm(cm: number, units: Units) {
  return round(units === 'imperial' ? cm / CM_PER_INCH : cm, LENGTH_DECIMALS)
}

/** kg → number in the user's units (rounded). */
export function weightFromKg(kg: number, units: Units) {
  return round(units === 'imperial' ? kg / KG_PER_LB : kg, WEIGHT_DECIMALS[units])
}

/** A typed length in the user's units → cm (not rounded, so nothing is lost). */
export function lengthToCm(value: number, units: Units) {
  return units === 'imperial' ? value * CM_PER_INCH : value
}

/** A typed weight in the user's units → kg. */
export function weightToKg(value: number, units: Units) {
  return units === 'imperial' ? value * KG_PER_LB : value
}

const display = (decimals: number) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: decimals })

/** "1,200" – a number for reading (thousands separators, no trailing zeros). */
export function showNumber(n: number | null | undefined, decimals = 2) {
  return n === null || n === undefined ? '—' : display(decimals).format(n)
}

/** "48 in" / "121.9 cm", or a dash. */
export function showLength(cm: number | null | undefined, units: Units) {
  return cm == null ? '—' : `${showNumber(lengthFromCm(cm, units), LENGTH_DECIMALS)} ${lengthUnit(units)}`
}

/** "1,200 lb" / "544.3 kg", or a dash. */
export function showWeight(kg: number | null | undefined, units: Units) {
  return kg == null ? '—' : `${showNumber(weightFromKg(kg, units), WEIGHT_DECIMALS[units])} ${weightUnit(units)}`
}

/** "96 × 48 × 60 in" (length × width × height), or null when no size was entered. */
export function showDims(
  c: { length_cm: number | null; width_cm: number | null; height_cm: number | null },
  units: Units,
) {
  if (c.length_cm == null && c.width_cm == null && c.height_cm == null) return null
  const part = (cm: number | null) => (cm == null ? '?' : showNumber(lengthFromCm(cm, units), LENGTH_DECIMALS))
  return `${part(c.length_cm)} × ${part(c.width_cm)} × ${part(c.height_cm)} ${lengthUnit(units)}`
}

/** Value to put in an input box (no thousands separators), or '' when empty. */
export function lengthInput(cm: number | null | undefined, units: Units) {
  return cm == null ? '' : String(lengthFromCm(cm, units))
}

export function weightInput(kg: number | null | undefined, units: Units) {
  return kg == null ? '' : String(weightFromKg(kg, units))
}

/** Plain number for CSV files (no separators), or empty. */
export function csvLength(cm: number | null | undefined, units: Units) {
  return cm == null ? null : lengthFromCm(cm, units)
}

export function csvWeight(kg: number | null | undefined, units: Units) {
  return kg == null ? null : weightFromKg(kg, units)
}
