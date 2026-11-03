import { createContext, useContext } from 'react'
import { showDate } from './dates'
import { formatMoney } from './format'
import type { Currency, Stage } from './types'

export type AlertKind =
  | 'payment_overdue'
  | 'payment_due_today'
  | 'payment_due_urgent'
  | 'payment_due_soon'
  | 'ship_passed'
  | 'ship_soon'
  | 'voltage_unknown'

/** One row of the my_alerts view. */
export type AlertRow = {
  alert_key: string
  kind: AlertKind
  severity: 'red' | 'amber'
  order_id: string
  order_code: string
  stage: Stage
  customer_name: string
  customer_company: string | null
  currency: Currency
  payment_id: string | null
  payment_type: string | null
  amount: number | null
  alert_date: string | null
  days: number | null
  snoozed_until: string | null
  dismissed_at: string | null
  hidden: boolean
}

export type AlertThresholds = { payment_warn_days: number; payment_urgent_days: number; ship_warn_days: number }
export const DEFAULT_THRESHOLDS: AlertThresholds = { payment_warn_days: 7, payment_urgent_days: 3, ship_warn_days: 14 }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Plain-words title and detail line for an alert. */
export function alertText(a: AlertRow): { title: string; detail: string } {
  const who = a.customer_company ? `${a.customer_name} (${a.customer_company})` : a.customer_name
  const money = a.amount !== null ? formatMoney(a.amount, a.currency) : ''
  const days = a.days ?? 0
  const order = `Order ${a.order_code}`
  switch (a.kind) {
    case 'payment_overdue':
      return {
        title: `Payment overdue · ${order}`,
        detail: `${a.payment_type} of ${money} was due ${showDate(a.alert_date)} (${plural(-days, 'day')} ago) · ${who}`,
      }
    case 'payment_due_today':
      return { title: `Payment due today · ${order}`, detail: `${a.payment_type} of ${money} · ${who}` }
    case 'payment_due_urgent':
    case 'payment_due_soon':
      return {
        title: `Payment due in ${plural(days, 'day')} · ${order}`,
        detail: `${a.payment_type} of ${money} due ${showDate(a.alert_date)} · ${who}`,
      }
    case 'ship_passed':
      return {
        title: `Ship date passed · ${order}`,
        detail: `Expected to ship ${showDate(a.alert_date)} (${plural(-days, 'day')} ago), not marked shipped · ${who}`,
      }
    case 'ship_soon':
      return {
        title: days === 0 ? `Ships today · ${order}` : `Ships in ${plural(days, 'day')} · ${order}`,
        detail: `Expected ship date ${showDate(a.alert_date)} · ${who}`,
      }
    case 'voltage_unknown':
      return { title: `Voltage unknown · ${order}`, detail: `${a.stage} order with no voltage set · ${who}` }
  }
}

export type AlertsState = {
  /** Alerts not snoozed or dismissed. */
  visible: AlertRow[]
  /** Snoozed or dismissed alerts (can be brought back). */
  hidden: AlertRow[]
  loading: boolean
  refresh: () => void
  snooze: (a: AlertRow, days: number) => Promise<void>
  dismiss: (a: AlertRow) => Promise<void>
  restore: (a: AlertRow) => Promise<void>
}

export const AlertsContext = createContext<AlertsState>({
  visible: [],
  hidden: [],
  loading: false,
  refresh: () => {},
  snooze: async () => {},
  dismiss: async () => {},
  restore: async () => {},
})

export function useAlerts() {
  return useContext(AlertsContext)
}
