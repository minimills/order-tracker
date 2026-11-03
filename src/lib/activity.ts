export type ActivityEntry = {
  id: number
  at: string
  user_email: string | null
  /** Departments of the person who made the change, at that moment. */
  user_departments?: string[] | null
  table_name: string
  record_id: string | null
  action: 'insert' | 'update' | 'delete' | 'move' | 'admin'
  changes: Record<string, unknown>
}

type Change = { old: unknown; new: unknown }

const LABELS: Record<string, string> = {
  stage: 'Stage',
  board_position: 'Place in shop queue',
  expected_ship_date: 'Expected ship date',
  actual_ship_date: 'Actual ship date',
  voltage: 'Voltage',
  delivery_equipment: 'Delivery equipment',
  freight_type: 'Freight type',
  notes: 'Notes',
  order_total: 'Order total',
  currency: 'Currency',
  order_number: 'Order number',
  split_number: 'Split number',
  order_code: 'Order #',
  customer_id: 'Customer',
  archived: 'Archived',
  serial_number: 'Serial',
  ready: 'Built',
  serial_manual: 'Serial typed by hand',
  role: 'Role',
  name: 'Name',
  company: 'Company',
  emails: 'Emails',
  phone: 'Phone',
  country: 'Country',
  state_province: 'State / province',
  code: 'Code',
  next_serial_number: 'Next serial number',
  value: 'Value',
  sort_order: 'Position in list',
  machine_type_id: 'Machine type',
  payment_type: 'Payment type',
  amount: 'Amount',
  due_date: 'Due date',
  received_date: 'Received date',
  received_amount: 'Received amount',
}

const THING: Record<string, string> = {
  orders: 'order',
  order_machines: 'machine',
  payments: 'payment',
  customers: 'customer',
  machine_types: 'machine type',
  option_lists: 'dropdown choice',
  departments: 'department',
  user_departments: 'department membership',
  allowed_users: 'user',
  app_settings: 'settings',
}

/** Fields that are filled in automatically and only add noise. */
const HIDDEN = new Set(['id', 'created_at', 'archived_at', 'archived_by', 'order_id', 'order_code'])

export const activityTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Halifax',
  dateStyle: 'medium',
  timeStyle: 'short',
})

function show(v: unknown, typeNames: Map<string, string>) {
  if (v === null || v === undefined || v === '') return '(empty)'
  if (v === true) return 'yes'
  if (v === false) return 'no'
  if (typeof v === 'string' && typeNames.has(v)) return typeNames.get(v)!
  return String(v)
}

export function describeActivity(e: ActivityEntry, typeNames: Map<string, string>): { title: string; lines: string[] } {
  const c = e.changes
  if (e.action === 'move') {
    const lines: string[] = []
    const stage = c.stage as Change | undefined
    const pos = c.board_position as Change | undefined
    const ship = c.actual_ship_date as Change | undefined
    if (stage && stage.old !== stage.new) lines.push(`Stage: ${stage.old} → ${stage.new}`)
    if (pos && pos.old !== pos.new) lines.push(`Place in shop queue: ${pos.old ?? 'not in queue'} → ${pos.new ?? 'left the queue'}`)
    if (ship && ship.old !== ship.new) lines.push(`Actual ship date: ${show(ship.old, typeNames)} → ${show(ship.new, typeNames)}`)
    for (const s of (c.serial_changes as { order: string; old: string | null; new: string | null }[]) ?? []) {
      lines.push(`Serial (order ${s.order}): ${s.old ?? 'none'} → ${s.new ?? 'none'}`)
    }
    return { title: 'Moved on the board', lines }
  }

  if (e.action === 'admin') {
    const lines: string[] = []
    const ch = c as Record<string, unknown>
    const serial = ch.serial_number as Change | undefined
    if (serial) lines.push(`Serial: ${serial.old ?? 'none'} → ${serial.new ?? 'none'}`)
    if (ch.next_serial_number) lines.push(`Next serial number set to ${ch.next_serial_number}`)
    for (const p of (ch.positions as { order: string; old: number | null; new: number | null }[]) ?? []) {
      lines.push(`Place in shop queue (order ${p.order}): ${p.old ?? 'not in queue'} → ${p.new ?? 'left the queue'}`)
    }
    for (const s of ((ch.serials ?? ch.serial_changes) as { order: string; old: string | null; new: string | null }[]) ?? []) {
      lines.push(`Serial (order ${s.order}): ${s.old ?? 'none'} → ${s.new ?? 'none'}`)
    }
    return { title: `Admin: ${String(ch.action ?? 'change')}`, lines }
  }

  const thing =
    THING[e.table_name] ?? e.table_name

  if (e.action === 'insert' || e.action === 'delete') {
    const verb = e.action === 'insert' ? 'Added' : 'Deleted'
    if (e.table_name === 'orders') return { title: e.action === 'insert' ? 'Order created' : 'Order deleted', lines: [] }
    if (e.table_name === 'allowed_users') return { title: `${verb} user ${c.email} (${c.role ?? 'staff'})`, lines: [] }
    if (e.table_name === 'customers') return { title: `${verb} customer ${c.name}`, lines: [] }
    if (e.table_name === 'machine_types') return { title: `${verb} machine type ${c.name}`, lines: [] }
    if (e.table_name === 'departments') return { title: `${verb} department "${c.name}"`, lines: [] }
    if (e.table_name === 'user_departments')
      return {
        title: e.action === 'insert'
          ? `Added ${c.user_email} to ${show(c.department_id, typeNames)}`
          : `Removed ${c.user_email} from ${show(c.department_id, typeNames)}`,
        lines: [],
      }
    if (e.table_name === 'option_lists') return { title: `${verb} dropdown choice "${c.value}" (${c.list_name})`, lines: [] }
    if (e.table_name === 'order_machines')
      return {
        title: `${verb} machine: ${show(c.machine_type_id, typeNames)}`,
        lines: c.serial_number ? [`Serial ${c.serial_number}`] : [],
      }
    if (e.table_name === 'payments')
      return { title: `${verb} payment: ${c.payment_type} ${c.amount ?? ''}`, lines: c.due_date ? [`Due ${c.due_date}`] : [] }
    return { title: `${verb} ${thing}`, lines: [] }
  }

  const lines = Object.entries(c)
    .filter(([k]) => !HIDDEN.has(k))
    .map(([k, v]) => {
      const ch = v as Change
      if (k === 'ready') return ch.new ? 'Marked built' : 'Marked not built'
      if (k === 'archived') return ch.new ? 'Archived' : 'Brought back from archive'
      return `${LABELS[k] ?? k}: ${show(ch.old, typeNames)} → ${show(ch.new, typeNames)}`
    })
  const name = c.name ?? c.email ?? c.value ?? c.key
  return { title: `Changed ${thing}${typeof name === 'string' ? ` ${name}` : ''}`, lines }
}


/** "anna@x.com (Office, Shipping)" or "automatic / database". */
export function activityWho(e: ActivityEntry) {
  if (!e.user_email) return 'automatic / database'
  return e.user_departments?.length ? `${e.user_email} (${e.user_departments.join(', ')})` : e.user_email
}
