/** Same format as the database: code + "-" + at least 4 digits, e.g. LCR-0073. */
export function formatSerial(code: string, n: number) {
  return `${code}-${String(n).padStart(4, '0')}`
}

export function formatMoney(amount: number | null | undefined, currency: string) {
  if (amount == null || Number.isNaN(amount)) return '—'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency, currencyDisplay: 'code' }).format(amount)
}

/** Turns a database error into a sentence a person can act on. */
export function friendlyError(error: { message?: string; code?: string } | null | undefined) {
  if (!error) return 'Something went wrong. Please try again.'
  if (error.code === '23505') {
    if (error.message?.includes('machine_types_code_key')) return 'That code is already used by another machine type.'
    if (error.message?.includes('machine_types_name_key')) return 'That name is already used by another machine type.'
    if (error.message?.includes('serial')) return 'That serial number is already used.'
    return 'That is already used. Please choose a different value.'
  }
  if (error.code === '42501' || error.message?.includes('row-level security')) {
    return 'You do not have permission to do that. Ask an admin.'
  }
  if (error.message?.includes('Failed to fetch')) return 'Could not reach the database. Check your internet connection.'
  return error.message || 'Something went wrong. Please try again.'
}
