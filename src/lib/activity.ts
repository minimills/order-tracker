import { dtf, tr } from '../i18n'
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
  get board_position() {
    return tr("Place in shop queue")
  },
  get expected_ship_date() {
    return tr("Expected ship date")
  },
  get actual_ship_date() {
    return tr("Actual ship date")
  },
  voltage: 'Voltage',
  get delivery_equipment() {
    return tr("Delivery equipment")
  },
  get freight_type() {
    return tr("Freight type")
  },
  notes: 'Notes',
  get order_total() {
    return tr("Order total")
  },
  currency: 'Currency',
  get order_number() {
    return tr("Order number")
  },
  get split_number() {
    return tr("Split number")
  },
  order_code: 'Order #',
  customer_id: 'Customer',
  archived: 'Archived',
  serial_number: 'Serial',
  ready: 'Built',
  get serial_manual() {
    return tr("Serial entered manually")
  },
  role: 'Role',
  name: 'Name',
  company: 'Company',
  emails: 'Emails',
  phone: 'Phone',
  country: 'Country',
  get state_province() {
    return tr("State / province")
  },
  code: 'Code',
  get next_serial_number() {
    return tr("Next serial number")
  },
  value: 'Value',
  get sort_order() {
    return tr("Position in list")
  },
  get machine_type_id() {
    return tr("Machine type")
  },
  get payment_type() {
    return tr("Payment type")
  },
  amount: 'Amount',
  get due_date() {
    return tr("Due date")
  },
  get received_date() {
    return tr("Received date")
  },
  get received_amount() {
    return tr("Received amount")
  },
  get short_name() {
    return tr("Short name")
  },
  get general_notes() {
    return tr("General notes")
  },
  get signed_name() {
    return tr("Signed by")
  },
  get signed_at() {
    return tr("Signed at")
  },
  section: 'Section',
  item_text: 'Item',
  get length_cm() {
    return tr("Length (cm)")
  },
  get width_cm() {
    return tr("Width (cm)")
  },
  get height_cm() {
    return tr("Height (cm)")
  },
  get weight_kg() {
    return tr("Weight (kg)")
  },
  get plywood_sheets() {
    return tr("Plywood sheets")
  },
  get build_hours() {
    return tr("Hours to build")
  },
  get crated_on() {
    return tr("Date crated")
  },
  get crated_by() {
    return tr("Crated by")
  },
  needs_crate: 'Crate',
  get build_days() {
    return tr("Build times (days per step)")
  },
  get production_started_on() {
    return tr("Production started")
  },
}

const THING: Record<string, string> = {
  orders: 'order',
  order_machines: 'machine',
  payments: 'payment',
  customers: 'customer',
  get machine_types() {
    return tr("machine type")
  },
  get option_lists() {
    return tr("dropdown choice")
  },
  departments: 'department',
  get user_departments() {
    return tr("department membership")
  },
  allowed_users: 'user',
  app_settings: 'settings',
  crates: 'crate',
  get permission_templates() {
    return tr("permission template")
  },
  get machine_checklists() {
    return tr("final check")
  },
  get checklist_template_items() {
    return tr("checklist template item")
  },
  get build_checklist_items() {
    return tr("build checklist item")
  },
  get production_stage_template() {
    return tr("production stage")
  },
  get service_entries() {
    return tr("service day")
  },
  get service_certificates() {
    return tr("commissioning certificate")
  },
  document_templates: 'template',
  get tech_calendar_entries() {
    return tr("calendar entry")
  },
  get calendar_feeds() {
    return tr("phone calendar link")
  },
  get calendar_imports() {
    return tr("linked phone calendar")
  },
  get chat_conversations() {
    return tr("chat channel")
  },
  user_permissions: 'permissions',
  get machine_steps() {
    return tr("department step")
  },
  user_groups: 'group',
  user_group_members: 'group membership',
  get board_templates() {
    return tr("board template")
  },
}

/** Fields that are filled in automatically and only add noise. */
const HIDDEN = new Set(['id', 'created_at', 'archived_at', 'archived_by', 'order_id', 'order_code', 'checklist_done_at', 'checklist_done_by', 'last_worked_at', 'last_worked_by_name', 'signed_by', 'signature_path', 'machine_id', 'started_by', 'started_by_name', 'started_at', 'schedule_kept', 'done_by_name'])

export const activityTime = dtf({
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
    if (pos && pos.old !== pos.new) lines.push(tr("Place in shop queue: {{value}} → {{value2}}", { value: pos.old ?? tr("not in queue"), value2: pos.new ?? tr("left the queue") }))
    if (ship && ship.old !== ship.new) lines.push(tr("Actual ship date: {{show}} → {{show2}}", { show: show(ship.old, typeNames), show2: show(ship.new, typeNames) }))
    for (const s of (c.serial_changes as { order: string; old: string | null; new: string | null }[]) ?? []) {
      lines.push(tr("Serial (order {{order}}): {{value}} → {{value2}}", { order: s.order, value: s.old ?? tr("none"), value2: s.new ?? tr("none") }))
    }
    return { get title() {
    return tr("Moved on the Orders Board")
  }, lines }
  }

  if (e.action === 'admin' && (c as Record<string, unknown>).action === 'permissions') {
    const ch = c as { user?: string; source?: string | null; added?: Perms; removed?: Perms; changed?: Record<string, { old: string; new: string }> }
    return {
      title: tr("Permissions changed for {{value}}{{value2}}", { value: ch.user ?? e.record_id, value2: ch.source ? ` (${ch.source})` : '' }),
      lines: permissionLines(ch.added ?? {}, ch.removed ?? {}, ch.changed ?? {}),
    }
  }

  if (e.action === 'admin') {
    const lines: string[] = []
    const ch = c as Record<string, unknown>
    const serial = ch.serial_number as Change | undefined
    if (serial) lines.push(`Serial: ${serial.old ?? 'none'} → ${serial.new ?? 'none'}`)
    if (ch.next_serial_number) lines.push(tr("Next serial number set to {{next_serial_number}}", { next_serial_number: ch.next_serial_number }))
    for (const p of (ch.positions as { order: string; old: number | null; new: number | null }[]) ?? []) {
      lines.push(tr("Place in shop queue (order {{order}}): {{value}} → {{value2}}", { order: p.order, value: p.old ?? tr("not in queue"), value2: p.new ?? tr("left the queue") }))
    }
    for (const s of ((ch.serials ?? ch.serial_changes) as { order: string; old: string | null; new: string | null }[]) ?? []) {
      lines.push(tr("Serial (order {{order}}): {{value}} → {{value2}}", { order: s.order, value: s.old ?? tr("none"), value2: s.new ?? tr("none") }))
    }
    // Final checks: unlock / override / one-off item
    if (typeof ch.serial === 'string') lines.push(`Machine ${ch.serial}`)
    if (ch.signed_name) lines.push(tr("Was signed by {{signed_name}}", { signed_name: ch.signed_name }))
    if (Array.isArray(ch.not_signed) && ch.not_signed.length) lines.push(tr("Not signed: {{value}}", { value: ch.not_signed.join(', ') }))
    if (typeof ch.stage === 'string') lines.push(tr("Moved to {{stageLabel}}", { stageLabel: stageLabel(ch.stage) }))
    if (typeof ch.item === 'string') lines.push(`${ch.section ? `${ch.section}: ` : ''}${ch.item}`)
    if (typeof ch.reason === 'string') lines.push(`Reason: ${ch.reason}`)
    const action = String(ch.action ?? 'change')
    return { title: action.startsWith('final check') || action.startsWith('schedule') ? action[0].toUpperCase() + action.slice(1) : `Admin: ${action}`, lines }
  }

  const thing =
    THING[e.table_name] ?? e.table_name

  if (e.action === 'insert' || e.action === 'delete') {
    const verb = e.action === 'insert' ? 'Added' : 'Deleted'
    if (e.table_name === 'orders') return { title: e.action === 'insert' ? tr("Order created") : tr("Order deleted"), lines: [] }
    // Declarations of conformity (0039): issued, and emailed.
    if (e.table_name === 'ce_declarations')
      return {
        title: `${c.title ?? tr("Declaration of Conformity")} ${c.number} issued`,
        lines: [`Machine ${c.serial ?? ''}`, ...(c.replaces ? [`Replaces ${c.replaces}`] : [])],
      }
    if (e.table_name === 'order_reminders')
      return {
        title: c.status === 'failed' ? tr("Reminder to the customer could not be emailed") : tr("Reminder emailed to the customer"),
        lines: [String(c.subject ?? ''), `To ${[...((c.to as string[]) ?? []), ...((c.cc as string[]) ?? [])].join(', ')}${Number(c.bcc_count) ? ` (+${c.bcc_count} BCC)` : ''}`, ...(c.error ? [`Error: ${c.error}`] : [])],
      }
    if (e.table_name === 'freight_breakdowns')
      return {
        title: c.archived === true ? tr("Shipment cost breakdown archived") : c.archived === false ? tr("Shipment cost breakdown restored") : e.action === 'insert' ? tr("Shipment cost breakdown created") : tr("Shipment cost breakdown changed"),
        lines: [[c.freight_type, c.agent, c.invoice_number ? `invoice ${c.invoice_number}` : null].filter(Boolean).join(' · ')].filter(Boolean),
      }
    if (e.table_name === 'freight_quote_requests')
      return { title: c.status === 'failed' ? tr("Freight quote request could not be emailed") : tr("Freight quote request emailed"), lines: [`To ${((c.to as string[]) ?? []).join(', ')}${c.agent ? ` (${c.agent})` : ''}`] }
    if (e.table_name === 'ce_declaration_sends') {
      const to = [...((c.to as string[]) ?? []), ...((c.cc as string[]) ?? [])].join(', ')
      return {
        title: c.status === 'failed' ? tr("Declarations of conformity could not be emailed") : tr("Declarations of conformity emailed"),
        lines: [`${((c.numbers as string[]) ?? []).join(', ')}`, `To ${to}${Number(c.bcc_count) ? ` (+${c.bcc_count} BCC)` : ''}`, ...(c.error ? [`Error: ${c.error}`] : [])],
      }
    }
    if (e.table_name === 'allowed_users') return { title: `${verb} user ${c.email} (${c.role ?? 'staff'})`, lines: [] }
    if (e.table_name === 'customers') return { title: `${verb} customer ${c.name}`, lines: [] }
    if (e.table_name === 'machine_types') return { title: tr("{{verb}} machine type {{name}}", { verb: verb, name: c.name }), lines: [] }
    if (e.table_name === 'departments') return { title: `${verb} department "${c.name}"`, lines: [] }
    if (e.table_name === 'user_groups') return { title: `${verb} group "${c.name}"`, lines: [] }
    if (e.table_name === 'user_group_members')
      return { title: e.action === 'insert' ? tr("Added {{user_email}} to a group", { user_email: c.user_email }) : tr("Removed {{user_email}} from a group", { user_email: c.user_email }), lines: [] }
    if (e.table_name === 'board_templates') return { title: tr("{{verb}} board template \"{{name}}\"", { verb: verb, name: c.name }), lines: [] }
    if (e.table_name === 'user_departments')
      return {
        title: e.action === 'insert'
          ? tr("Added {{user_email}} to {{show}}", { user_email: c.user_email, show: show(c.department_id, typeNames) })
          : tr("Removed {{user_email}} from {{show}}", { user_email: c.user_email, show: show(c.department_id, typeNames) }),
        lines: [],
      }
    if (e.table_name === 'option_lists') return { title: tr("{{verb}} dropdown choice \"{{value}}\" ({{list_name}})", { verb: verb, value: c.value, list_name: c.list_name }), lines: [] }
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
      return { title: e.action === 'insert' ? tr("Final check started by {{value}}", { value: c.started_by_name ?? tr("someone") }) : tr("Final check deleted"), lines: [] }
    if (e.table_name === 'build_checklist_items')
      return { title: tr("{{verb}} build checklist item", { verb: verb }), lines: [`${c.section}: ${c.item_text}`] }
    if (e.table_name === 'checklist_template_items')
      return { title: tr("{{verb}} checklist template item", { verb: verb }), lines: [`${c.section}: ${c.item_text}`] }
    if (e.table_name === 'machine_steps')
      return {
        title: `${STEP_LABEL[c.step as StepKey] ?? c.step} ${e.action === 'insert' ? tr("marked complete") : tr("marked incomplete")}`,
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
      if (k === 'ready') return ch.new ? tr("Marked built") : tr("Marked not built")
      if (k === 'archived') return ch.new ? 'Archived' : tr("Restored from the archive")
      if (k === 'stage') return `Stage: ${stageLabel(String(ch.old))} → ${stageLabel(String(ch.new))}`
      if (k === 'checklist_done') return ch.new ? tr("Final check complete") : tr("Final check reopened")
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
        return `Permissions: ${permissionLines(added, removed, changed).join('; ') || tr("no change")}`
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
const levelWord = (v: string) => (v === 'edit' ? tr("can change") : tr("can see"))

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
  if (!e.user_email) return tr("automatic / database")
  return e.user_departments?.length ? `${e.user_email} (${e.user_departments.join(', ')})` : e.user_email
}
