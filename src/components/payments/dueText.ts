import type { PaymentRow } from '../../lib/types'
import { tr } from '../../i18n'

/** "Due in 3 days", "Due today", "4 days overdue" or "" */
export function dueText(p: Pick<PaymentRow, 'status' | 'days_until_due'>) {
  const d = p.days_until_due
  if (p.status === 'Paid' || p.status === 'Nothing due' || d === null) return ''
  if (d < 0) return tr("{{value}} day{{value2}} overdue", { value: -d, value2: d === -1 ? '' : 's' })
  if (d === 0) return tr("Due today")
  return tr("Due in {{d}} day{{value}}", { d: d, value: d === 1 ? '' : 's' })
}
