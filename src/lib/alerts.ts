import { stageLabel } from './stages'
import { createContext, useContext } from 'react'
import { showDate } from './dates'
import { formatMoney } from './format'
import type { Currency, Stage } from './types'
import { tr } from '../i18n'

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
        title: tr("Payment overdue · {{order}}", { order: order }),
        detail: tr("{{payment_type}} of {{money}} was due {{showDate}} ({{plural}} ago) · {{who}}", { payment_type: a.payment_type, money: money, showDate: showDate(a.alert_date), plural: plural(-days, 'day'), who: who }),
      }
    case 'payment_due_today':
      return { title: tr("Payment due today · {{order}}", { order: order }), detail: `${a.payment_type} of ${money} · ${who}` }
    case 'payment_due_urgent':
    case 'payment_due_soon':
      return {
        title: tr("Payment due in {{plural}} · {{order}}", { plural: plural(days, 'day'), order: order }),
        detail: tr("{{payment_type}} of {{money}} due {{showDate}} · {{who}}", { payment_type: a.payment_type, money: money, showDate: showDate(a.alert_date), who: who }),
      }
    case 'ship_passed':
      return {
        title: tr("Ship date passed · {{order}}", { order: order }),
        detail: tr("Expected to ship {{showDate}} ({{plural}} ago), not marked as shipped · {{who}}", { showDate: showDate(a.alert_date), plural: plural(-days, 'day'), who: who }),
      }
    case 'ship_soon':
      return {
        title: days === 0 ? tr("Ships today · {{order}}", { order: order }) : tr("Ships in {{plural}} · {{order}}", { plural: plural(days, 'day'), order: order }),
        detail: tr("Expected ship date {{showDate}} · {{who}}", { showDate: showDate(a.alert_date), who: who }),
      }
    case 'voltage_unknown':
      return { title: tr("Voltage unknown · {{order}}", { order: order }), detail: tr("{{stageLabel}} order with no voltage set · {{who}}", { stageLabel: stageLabel(a.stage), who: who }) }
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
