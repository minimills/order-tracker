import { supabase } from './supabase'

// Email templates (Admin → Email Templates): certificate emails, customer
// reminders, the welcome email, and who customer emails come from.

export type ReminderTemplate = { name: string; subject: string; body: string }
export type EmailTemplates = {
  certificate_subject: string
  certificate_cc: string
  service_report_subject: string
  service_report_cc: string
  from_name: string
  from_address: string
  reply_to: string
  reminders: Record<string, ReminderTemplate>
  welcome: { subject: string; body: string }
}

export const REMINDER_KEYS = ['down_payment_due', 'balance_due', 'overdue', 'ship_date_update', 'custom'] as const
export const REMINDER_PLACEHOLDERS =
  '{customer_name}, {customer_company}, {order_number}, {invoice_number}, {quote_number}, {payment_type}, {amount}, {due_date}, {days_overdue}, {order_total}, {outstanding}, {expected_ship_date}, {original_ship_date}, {sender_name}, {company_name}'
export const WELCOME_PLACEHOLDERS = '{name}, {email}, {portal_url}, {features}, {sender_name}, {company_name}'

export const EMAIL_TEMPLATE_DEFAULTS: EmailTemplates = {
  certificate_subject: 'Commissioning Certificate Belfast Mini Mills – {customer_company}',
  certificate_cc: '{office_email}',
  service_report_subject: 'Service Report Belfast Mini Mills – {customer_company}',
  service_report_cc: '{office_email}',
  from_name: '',
  from_address: '',
  reply_to: '',
  reminders: {},
  welcome: { subject: 'Welcome to the {company_name} Order Tracker', body: 'Hello {name},\n\nYou can now use the {company_name} Order Tracker: {portal_url}\n\n{features}\n\n{sender_name}\n{company_name}' },
}

export async function loadEmailTemplates(): Promise<EmailTemplates> {
  if (!supabase) return EMAIL_TEMPLATE_DEFAULTS
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'email_templates').maybeSingle()
  const v = (data?.value as Partial<EmailTemplates> | null) ?? {}
  return { ...EMAIL_TEMPLATE_DEFAULTS, ...v, reminders: { ...(v.reminders ?? {}) }, welcome: { ...EMAIL_TEMPLATE_DEFAULTS.welcome, ...(v.welcome ?? {}) } }
}

/** Puts the values in place of {placeholders}; unknown ones are left as written. */
export function fillTemplate(text: string, values: Record<string, string>) {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m))
}

export const splitEmails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
