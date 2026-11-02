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
