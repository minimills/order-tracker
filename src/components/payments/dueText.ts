import type { PaymentRow } from '../../lib/types'

/** "Due in 3 days", "Due today", "4 days overdue" or "" */
export function dueText(p: Pick<PaymentRow, 'status' | 'days_until_due'>) {
  const d = p.days_until_due
  if (p.status === 'Paid' || p.status === 'Nothing due' || d === null) return ''
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`
  if (d === 0) return 'Due today'
  return `Due in ${d} day${d === 1 ? '' : 's'}`
}
