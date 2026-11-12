/** Row shapes of the database tables the app reads. */

export type MachineType = {
  id: string
  name: string
  code: string | null
  /** Short name for the machine chips on the board (empty = full name). */
  short_name?: string | null
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
  /** Chip colour (#rrggbb), used for voltage chips on the Orders board. */
  colour?: string | null
}

export type OptionListName = 'voltage' | 'delivery_equipment' | 'freight_type' | 'payment_type' | 'notice_category' | 'ce_directive'

/** Stages are fixed (the board and serial rules depend on them). */
/** Stored values. Names shown on screen can be renamed in Admin → Stage names (see src/lib/stages.ts). */
export const STAGES = ['Quote', 'Confirmed', 'In production', 'Ready', 'Ready to ship', 'Shipped', 'Cancelled'] as const
export type Stage = (typeof STAGES)[number]

export const CURRENCIES = ['CAD', 'USD'] as const
export type Currency = (typeof CURRENCIES)[number]

export const BOARD_STAGES: Stage[] = ['Confirmed', 'In production', 'Ready', 'Ready to ship']

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
  /** Empty without the "order.field.order_total" permission. */
  order_total: number | null
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
  /** Payment columns are empty without the "payments" permission. */
  total_paid: number | null
  amount_outstanding: number | null
  next_due_date: string | null
  payment_status: PaymentStatus | null
  archived: boolean
  /** 0037 (missing on databases without that migration). */
  quote_number?: string | null
  invoice_number?: string | null
  /** The first promised ship date (= expected_ship_date when it never changed). */
  original_ship_date?: string | null
  /** How many times the expected ship date was changed. */
  ship_date_revisions?: number | null
}

export type PaymentStatusLabel = 'Paid' | 'Overdue' | 'Due soon' | 'Upcoming' | 'Nothing due'

/** One row of the payment_overview view. */
export type PaymentRow = {
  id: string
  order_id: string
  order_number: number
  split_number: number | null
  order_code: string
  stage: Stage
  order_archived: boolean
  currency: Currency
  customer_id: string
  customer_name: string
  customer_company: string | null
  customer_country: string | null
  customer_emails: string[]
  payment_type: string
  amount: number
  received_amount: number
  remaining: number
  due_date: string | null
  received_date: string | null
  notes: string | null
  days_until_due: number | null
  status: PaymentStatusLabel
}

/** A department (Office, Fabrication Shop…). default_permissions is filled in by a later step. */
export type Department = {
  id: string
  name: string
  sort_order: number
  default_permissions: Record<string, unknown>
  archived: boolean
}
