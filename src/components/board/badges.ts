import { BOARD_STAGES, type OrderSummaryRow } from '../../lib/types'

export type Badge = { label: string; tone: 'red' | 'amber' }

/** The warning badges shown on a board card (and the shop board). */
export function orderBadges(o: OrderSummaryRow): Badge[] {
  const badges: Badge[] = []
  if (o.voltage === 'Unknown' && BOARD_STAGES.includes(o.stage)) badges.push({ label: 'Voltage unknown', tone: 'amber' })
  if (o.payment_status === 'Overdue') badges.push({ label: 'Payment overdue', tone: 'red' })
  else if (o.payment_status === 'Due soon') badges.push({ label: 'Payment due soon', tone: 'amber' })
  if (o.stage !== 'Shipped' && o.stage !== 'Cancelled' && !o.actual_ship_date && o.days_until_ship !== null) {
    const d = o.days_until_ship
    if (d < 0) badges.push({ label: `Ship date passed (${-d} day${d === -1 ? '' : 's'} ago)`, tone: 'red' })
    else if (d === 0) badges.push({ label: 'Ships today', tone: 'amber' })
    else if (d <= 14) badges.push({ label: `Ships in ${d} day${d === 1 ? '' : 's'}`, tone: 'amber' })
  }
  return badges
}

export const badgeClass: Record<Badge['tone'], string> = {
  red: 'bg-red-100 text-red-800 ring-red-200',
  amber: 'bg-amber-100 text-amber-900 ring-amber-200',
}
