/** "10,000.50" or "$10000" -> 10000.5; empty -> null; anything else -> NaN */
export function parseMoney(text: string) {
  const cleaned = text.replace(/[\s,$]/g, '')
  if (cleaned === '') return null
  return /^\d+(\.\d{0,2})?$/.test(cleaned) ? Number(cleaned) : NaN
}

export function round2(n: number) {
  return Math.round(n * 100) / 100
}
