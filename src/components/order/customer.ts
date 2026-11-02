import type { Customer } from '../../lib/types'

export type NewCustomer = {
  name: string
  company: string
  emails: string
  country: string
  state_province: string
}

export const emptyNewCustomer: NewCustomer = { name: '', company: '', emails: '', country: '', state_province: '' }

export type CustomerChoice =
  | { mode: 'existing'; customer: Customer | null }
  | { mode: 'new'; customer: NewCustomer }

/** Splits "a@x.com, b@y.com" (commas, spaces or new lines) into a clean list. */
export function parseEmails(text: string) {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
