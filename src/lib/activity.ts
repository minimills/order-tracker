import { STEP_LABEL, type StepKey } from './schedule'
import { CATALOG_BY_KEY } from './permissions/catalog'
import { isRichText, richTextToPlain } from './richText'
import { stageLabel } from './stages'

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
  short_name: 'Short name',
  general_notes: 'General notes',
  signed_name: 'Signed by',
  signed_at: 'Signed at',
  section: 'Section',
  item_text: 'Item',
  length_cm: 'Length (cm)',
  width_cm: 'Width (cm)',
  height_cm: 'Height (cm)',
  weight_kg: 'Weight (kg)',
  plywood_sheets: 'Plywood sheets',
  build_hours: 'Hours to build',
  crated_on: 'Date crated',
  crated_by: 'Crated by',
  needs_crate: 'Crate?',
  build_days: 'Build times (days per step)',
  production_started_on: 'Production started',
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
  crates: 'crate',
  permission_templates: 'permission template',
  machine_checklists: 'final check',
  checklist_template_items: 'checklist template item',
  user_permissions: 'permissions',
  machine_steps: 'department step',
  user_groups: 'group',
  user_group_members: 'group membership',
  board_templates: 'board template',
}

/** Fields that are filled in automatically and only add noise. */
const HIDDEN = new Set(['id', 'created_at', 'archived_at', 'archived_by', 'order_id', 'order_code', 'checklist_done_at', 'checklist_done_by', 'last_worked_at', 'last_worked_by_name', 'signed_by', 'signature_path', 'machine_id', 'started_by', 'started_by_name', 'started_at', 'schedule_kept', 'done_by_name'])

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
  if (typeof v === 'string' && isRichText(v)) return richTextToPlain(v).replace(/\n/g, ' / ')
  return String(v)
}

export function describeActivity(e: ActivityEntry, typeNames: Map<string, string>): { title: string; lines: string[] } {
  const c = e.changes
  if (e.action === 'move') {
    const lines: string[] = []
    const stage = c.stage as Change | undefined
    const pos = c.board_position as Change | undefined
    const ship = c.actual_ship_date as Change | undefined
    if (stage && stage.old !== stage.new) lines.push(`Stage: ${stageLabel(String(stage.old))} → ${stageLabel(String(stage.new))}`)
    if (pos && pos.old !== pos.new) lines.push(`Place in shop queue: ${pos.old ?? 'not in queue'} → ${pos.new ?? 'left the queue'}`)
    if (ship && ship.old !== ship.new) lines.push(`Actual ship date: ${show(ship.old, typeNames)} → ${show(ship.new, typeNames)}`)
    for (const s of (c.serial_changes as { order: string; old: string | null; new: string | null }[]) ?? []) {
      lines.push(`Serial (order ${s.order}): ${s.old ?? 'none'} → ${s.new ?? 'none'}`)
    }
    return { title: 'Moved on the board', lines }
  }

  if (e.action === 'admin' && (c as Record<string, unknown>).action === 'permissions') {
    const ch = c as { user?: string; source?: string | null; added?: Perms; removed?: Perms; changed?: Record<string, { old: string; new: string }> }
    return {
      title: `Permissions changed for ${ch.user ?? e.record_id}${ch.source ? ` (${ch.source})` : ''}`,
      lines: permissionLines(ch.added ?? {}, ch.removed ?? {}, ch.changed ?? {}),
    }
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
    // Final checks: unlock / override / one-off item
    if (typeof ch.serial === 'string') lines.push(`Machine ${ch.serial}`)
    if (ch.signed_name) lines.push(`Was signed by ${ch.signed_name}`)
    if (Array.isArray(ch.not_signed) && ch.not_signed.length) lines.push(`Not signed: ${ch.not_signed.join(', ')}`)
    if (typeof ch.stage === 'string') lines.push(`Moved to ${stageLabel(ch.stage)}`)
    if (typeof ch.item === 'string') lines.push(`${ch.section ? `${ch.section}: ` : ''}${ch.item}`)
    if (typeof ch.reason === 'string') lines.push(`Reason: ${ch.reason}`)
    const action = String(ch.action ?? 'change')
    return { title: action.startsWith('final check') || action.startsWith('schedule') ? action[0].toUpperCase() + action.slice(1) : `Admin: ${action}`, lines }
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
    if (e.table_name === 'user_groups') return { title: `${verb} group "${c.name}"`, lines: [] }
    if (e.table_name === 'user_group_members')
      return { title: e.action === 'insert' ? `Added ${c.user_email} to a group` : `Removed ${c.user_email} from a group`, lines: [] }
    if (e.table_name === 'board_templates') return { title: `${verb} board template "${c.name}"`, lines: [] }
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
    if (e.table_name === 'crates')
      return {
        title: `${verb} crate`,
        lines: [
          [c.length_cm, c.width_cm, c.height_cm].some((v) => v != null)
            ? `Size ${c.length_cm ?? '?'} × ${c.width_cm ?? '?'} × ${c.height_cm ?? '?'} cm`
            : '',
          c.weight_kg != null ? `Weight ${c.weight_kg} kg` : '',
          c.crated_by ? `Crated by ${c.crated_by}` : '',
        ].filter(Boolean),
      }
    if (e.table_name === 'machine_checklists')
      return { title: e.action === 'insert' ? `Final check started by ${c.started_by_name ?? 'someone'}` : 'Final check deleted', lines: [] }
    if (e.table_name === 'checklist_template_items')
      return { title: `${verb} checklist template item`, lines: [`${c.section}: ${c.item_text}`] }
    if (e.table_name === 'machine_steps')
      return {
        title: `${STEP_LABEL[c.step as StepKey] ?? c.step} ${e.action === 'insert' ? 'marked done' : 'un-ticked'}`,
        lines: e.action === 'insert' ? [`Done ${c.done_on}${c.done_by_name ? ` by ${c.done_by_name}` : ''}`] : [],
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
      if (k === 'stage') return `Stage: ${stageLabel(String(ch.old))} → ${stageLabel(String(ch.new))}`
      if (k === 'checklist_done') return ch.new ? 'Final checklist done' : 'Final checklist un-ticked'
      if (k === 'default_permissions' || k === 'perms') {
        const o = (ch.old ?? {}) as Perms
        const n = (ch.new ?? {}) as Perms
        const added = Object.fromEntries(Object.entries(n).filter(([key]) => !(key in o)))
        const removed = Object.fromEntries(Object.entries(o).filter(([key]) => !(key in n)))
        const changed = Object.fromEntries(
          Object.entries(n)
            .filter(([key, v]) => key in o && o[key] !== v)
            .map(([key, v]) => [key, { old: o[key], new: v }]),
        )
        return `Permissions: ${permissionLines(added, removed, changed).join('; ') || 'no change'}`
      }
      return `${LABELS[k] ?? k}: ${show(ch.old, typeNames)} → ${show(ch.new, typeNames)}`
    })
  const name = c.name ?? c.email ?? c.value ?? c.key
  return { title: `Changed ${thing}${typeof name === 'string' ? ` ${name}` : ''}`, lines }
}


type Perms = Record<string, string>

const permName = (key: string) => {
  const item = CATALOG_BY_KEY.get(key)
  return item ? `${item.group}: ${item.label}` : key
}
const levelWord = (v: string) => (v === 'edit' ? 'can change' : 'can see')

/** "+ Dashboard: Next ship dates (can see)", "− …", "… : can see → can change". */
function permissionLines(added: Perms, removed: Perms, changed: Record<string, { old: string; new: string }>) {
  return [
    ...Object.entries(added).map(([k, v]) => `+ ${permName(k)} (${levelWord(v)})`),
    ...Object.entries(removed).map(([k]) => `− ${permName(k)}`),
    ...Object.entries(changed).map(([k, v]) => `${permName(k)}: ${levelWord(v.old)} → ${levelWord(v.new)}`),
  ]
}

/** "anna@x.com (Office, Shipping)" or "automatic / database". */
export function activityWho(e: ActivityEntry) {
  if (!e.user_email) return 'automatic / database'
  return e.user_departments?.length ? `${e.user_email} (${e.user_departments.join(', ')})` : e.user_email
}
