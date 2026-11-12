import { fetchAll } from '../fetchAll'
import { supabase } from '../supabase'
import { COLUMN_WIDTHS, HEADER_EXTRAS, HEADERS } from './layout'
import type { OutCell, OutSheet } from './xlsx'
import { richTextToPlain } from '../richText'

const d = (iso: string | null | undefined): OutCell => (iso ? { date: iso } : null)

/** The "Instructions" sheet, in plain words, with one example order. */
export function instructionsSheet(): OutSheet {
  const rows: OutCell[][] = [
    ['How to fill in the Orders sheet'],
    [],
    ['1. Each order starts with an ORDER ROW: put the order number in column A (for example 76, or 76-1 for a split shipment).'],
    ['2. Under it, add one MACHINE ROW per machine: leave column A empty, put the machine name in column B,'],
    ['   the serial number in column C (or leave it empty, or just the code like SSM, if it has no number yet),'],
    ['   and TRUE in column D if the machine is built (FALSE or empty if not).'],
    ['3. The next order number in column A starts the next order. Blank rows are fine.'],
    [],
    ['On an ORDER ROW:'],
    ['   B  Customer, Country (for example "Fibre Farm, Canada"; the part after the LAST comma is the country, state or province)'],
    ['   D  Expected ship date'],
    ['   E  Voltage: 120V or 240V; ? or - means Unknown'],
    ['   F  Notes. Words like Liftgate, No liftgate, forklift, tractor with forks, LTL, FTL, LCL or 40\' are recognised; the note is kept as written'],
    ['   G  Actual ship date (fill it in only when the order has shipped)'],
    ['   H  Delay: ignored (the app works it out)'],
    ['   I  Down payment amount,  J  its due date,  K  date it was received'],
    ['   L  Balance amount. A formula like =48300-I5 is fine: the first number is read as the order total'],
    ['   M  Balance due date,  N  date the balance was received'],
    [],
    ['Machine names must match a machine type in the app (Admin → Machine types). If one does not, the import preview lets you pick or create it.'],
    ['If an order number is already in the app, the import UPDATES that order instead of making a copy. Empty cells never erase anything.'],
    [],
    ['Example order (copy this layout into the Orders sheet):'],
    HEADERS,
    [76, 'Fibre Farm, Canada', null, { date: '2026-12-15' }, '240V', 'Liftgate, LTL', null, null, 12000, { date: '2026-10-01' }, { date: '2026-10-03' }, { formula: '48000-I25', value: 36000 }, { date: '2026-12-01' }, null],
    [null, 'Washer', 'SSM-0470', true],
    [null, 'Carder - Large', 'LCR', false],
    [null, 'Skein Winder', null, false],
  ]
  return { name: 'Instructions', rows, widths: [9, 38, 14, 16, 9, 34, 14, 8, 14, 12, 12, 14, 14, 14] }
}

/** An empty Orders sheet with the headings, plus the Instructions sheet. */
export function templateSheets(): OutSheet[] {
  return [{ name: 'Orders', rows: [HEADERS], widths: COLUMN_WIDTHS }, instructionsSheet()]
}

type OrderRow = {
  id: string
  order_code: string
  stage: string
  customer_name: string
  customer_country: string | null
  customer_state_province: string | null
  currency: string
  order_total: number
  expected_ship_date: string | null
  actual_ship_date: string | null
  delay_days: number | null
  voltage: string
  delivery_equipment: string
  freight_type: string | null
  quote_number?: string | null
  invoice_number?: string | null
  notes: string | null
  archived: boolean
  order_number: number
  split_number: number | null
}
type MachineRow = { order_id: string; serial_number: string | null; ready: boolean; notes: string | null; created_at: string; machine_types: { name: string } | null }
type PaymentRow = { order_id: string; order_code: string; payment_type: string; amount: number; received_amount: number; due_date: string | null; received_date: string | null; notes: string | null }

/** Everything in the app, in the same layout (plus Customers and Payments sheets for reference). */
export async function backupSheets(): Promise<OutSheet[]> {
  if (!supabase) throw new Error('Not connected to the database.')
  const [o, m, p, c] = await Promise.all([
    fetchAll<OrderRow>(() => supabase!.from('order_summary').select('*').eq('archived', false).order('order_number').order('split_number', { nullsFirst: true })),
    fetchAll<MachineRow>(() =>
      supabase!.from('order_machines').select('order_id, serial_number, ready, notes, created_at, machine_types(name)').eq('archived', false).order('created_at'),
    ),
    fetchAll<PaymentRow>(() => supabase!.from('payment_overview').select('*').eq('order_archived', false).order('order_number')),
    fetchAll<Record<string, unknown>>(() => supabase!.from('customer_list').select('name, company, emails, phone, country, state_province, notes, archived').order('name')),
  ])
  const error = o.error ?? m.error ?? p.error ?? c.error
  if (error) throw new Error(error.message)

  const machinesBy = new Map<string, MachineRow[]>()
  for (const x of m.data) machinesBy.set(x.order_id, [...(machinesBy.get(x.order_id) ?? []), x])
  const paymentsBy = new Map<string, PaymentRow[]>()
  for (const x of p.data) paymentsBy.set(x.order_id, [...(paymentsBy.get(x.order_id) ?? []), x])

  const extraHeads = [HEADER_EXTRAS.currency, HEADER_EXTRAS.delivery, HEADER_EXTRAS.freight, HEADER_EXTRAS.stage, HEADER_EXTRAS.quote, HEADER_EXTRAS.invoice, 'Extra payments (not re-imported)']
  const rows: OutCell[][] = [[...HEADERS, ...extraHeads]]
  for (const ord of o.data) {
    const pays = paymentsBy.get(ord.id) ?? []
    const dp = pays.find((x) => x.payment_type === 'Down payment')
    const bal = pays.find((x) => x.payment_type === 'Balance')
    const extras = pays.filter((x) => x.payment_type !== 'Down payment' && x.payment_type !== 'Balance')
    const where = [ord.customer_state_province, ord.customer_country].filter(Boolean).join(' - ')
    const r = rows.length + 1 // this row's number in the sheet
    const balanceCell: OutCell = dp
      ? { formula: `${ord.order_total}-I${r}`, value: Math.round((ord.order_total - dp.amount) * 100) / 100 }
      : ord.order_total || null
    rows.push([
      ord.order_code,
      where ? `${ord.customer_name}, ${where}` : ord.customer_name,
      null,
      d(ord.expected_ship_date),
      ord.voltage,
      richTextToPlain(ord.notes),
      d(ord.actual_ship_date),
      ord.delay_days,
      dp ? dp.amount : null,
      d(dp?.due_date),
      d(dp?.received_date),
      balanceCell,
      d(bal?.due_date),
      d(bal?.received_date),
      ord.currency,
      ord.delivery_equipment,
      ord.freight_type ?? '',
      ord.stage,
      ord.quote_number ?? '',
      ord.invoice_number ?? '',
      extras.map((x) => `${x.payment_type} ${x.amount}${x.due_date ? ` due ${x.due_date}` : ''}${x.received_date ? ` received ${x.received_date}` : ''}`).join('; '),
    ])
    for (const mc of machinesBy.get(ord.id) ?? []) {
      rows.push([null, mc.machine_types?.name ?? '', mc.serial_number ?? '', mc.ready, null, mc.notes ?? ''])
    }
    rows.push([])
  }

  const customers: OutCell[][] = [
    ['Name', 'Company', 'Emails', 'Phone', 'Country', 'State / province', 'Notes', 'Archived'],
    ...c.data.map((x) => [
      String(x.name ?? ''),
      String(x.company ?? ''),
      ((x.emails as string[]) ?? []).join(', '),
      String(x.phone ?? ''),
      String(x.country ?? ''),
      String(x.state_province ?? ''),
      String(x.notes ?? ''),
      x.archived ? 'yes' : '',
    ]),
  ]
  const payments: OutCell[][] = [
    ['Order #', 'Payment', 'Amount', 'Received so far', 'Due date', 'Received date', 'Note'],
    ...p.data.map((x) => [x.order_code, x.payment_type, x.amount, x.received_amount, d(x.due_date), d(x.received_date), x.notes ?? '']),
  ]
  return [
    { name: 'Orders', rows, widths: COLUMN_WIDTHS },
    { name: 'Customers', rows: customers, widths: [30, 28, 40, 16, 16, 16, 40, 9] },
    { name: 'Payments', rows: payments, widths: [9, 16, 14, 14, 12, 12, 30] },
    instructionsSheet(),
  ]
}
