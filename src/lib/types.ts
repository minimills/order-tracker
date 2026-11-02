/** Row shapes of the database tables the app reads. */

export type MachineType = {
  id: string
  name: string
  code: string | null
  next_serial_number: number
  archived: boolean
}

export type Customer = {
  id: string
  name: string
  company: string | null
  emails: string[]
  phone: string | null
  country: string | null
  state_province: string | null
  notes: string | null
  archived: boolean
}

export type OptionItem = {
  id: string
  list_name: string
  value: string
  sort_order: number
  locked: boolean
  archived: boolean
}

export type OptionListName = 'voltage' | 'delivery_equipment' | 'freight_type' | 'payment_type'

/** Stages are fixed (the board and serial rules depend on them). */
export const STAGES = ['Quote', 'Confirmed', 'In production', 'Ready to ship', 'Shipped', 'Cancelled'] as const
export type Stage = (typeof STAGES)[number]

export const CURRENCIES = ['CAD', 'USD'] as const
export type Currency = (typeof CURRENCIES)[number]

export const BOARD_STAGES: Stage[] = ['Confirmed', 'In production', 'Ready to ship']

export const PAYMENT_STATUSES = ['Overdue', 'Due soon', 'Open', 'Paid', 'No total'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

/** One row of the order_summary view. */
export type OrderSummaryRow = {
  id: string
  order_number: number
  split_number: number | null
  order_code: string
  stage: Stage
  board_position: number | null
  order_date: string
  customer_id: string
  customer_name: string
  customer_company: string | null
  customer_country: string | null
  customer_state_province: string | null
  currency: Currency
  order_total: number
  expected_ship_date: string | null
  actual_ship_date: string | null
  delay_days: number | null
  days_until_ship: number | null
  voltage: string
  delivery_equipment: string
  freight_type: string | null
  notes: string | null
  machines_count: number
  machines_ready_count: number
  machines_list: string | null
  serials: string | null
  down_payment_amount: number | null
  down_payment_percent: number | null
  total_paid: number
  amount_outstanding: number
  next_due_date: string | null
  payment_status: PaymentStatus
  archived: boolean
}
