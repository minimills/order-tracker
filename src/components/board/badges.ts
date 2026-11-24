import { BOARD_STAGES, type OrderSummaryRow } from '../../lib/types'
import { tr } from '../../i18n'

export type Badge = { label: string; tone: 'red' | 'amber'; kind: 'voltage' | 'payment' | 'ship_date' }

/** The warning badges shown on a board card (and the shop board). */
export function orderBadges(o: OrderSummaryRow): Badge[] {
  const badges: Badge[] = []
  if (o.voltage === 'Unknown' && BOARD_STAGES.includes(o.stage)) badges.push({ get label() {
    return tr("Voltage unknown")
  }, tone: 'amber', kind: 'voltage' })
  if (o.payment_status === 'Overdue') badges.push({ get label() {
    return tr("Payment overdue")
  }, tone: 'red', kind: 'payment' })
  else if (o.payment_status === 'Due soon') badges.push({ get label() {
    return tr("Payment due soon")
  }, tone: 'amber', kind: 'payment' })
  if (o.stage !== 'Shipped' && o.stage !== 'Cancelled' && !o.actual_ship_date && o.days_until_ship !== null) {
    const d = o.days_until_ship
    if (d < 0) badges.push({ label: tr("Ship date passed ({{value}} day{{value2}} ago)", { value: -d, value2: d === -1 ? '' : 's' }), tone: 'red', kind: 'ship_date' })
    else if (d === 0) badges.push({ get label() {
    return tr("Ships today")
  }, tone: 'amber', kind: 'ship_date' })
    else if (d <= 14) badges.push({ label: tr("Ships in {{d}} day{{value}}", { d: d, value: d === 1 ? '' : 's' }), tone: 'amber', kind: 'ship_date' })
  }
  return badges
}

export const badgeClass: Record<Badge['tone'], string> = {
  red: 'bg-red-100 text-red-800 ring-red-200',
  amber: 'bg-amber-100 text-amber-900 ring-amber-200',
}
