/**
 * THE permissions catalog: every page, card, chart, list, column, field, tab,
 * button and action in the app has one entry here.
 *
 * Rules (checked by `npm run check:perms`, which runs before every commit):
 * - Every screen element is wrapped in <Can permission="…"> (or a route in
 *   <Page permission="…">) with a key from this list.
 * - Every key here is used somewhere in the code.
 * - New features add their items here. Non-admin users don't have them until
 *   an admin ticks them in Admin → Users (they show a "New" badge there).
 *
 * Levels: "view" = can see it; "edit" = can change it / use the button
 * (edit includes view). Items with only "edit" are buttons and actions.
 *
 * `requires`: shown only when that item (usually the page) is allowed too.
 * `needs`: also needs these data permissions (e.g. money columns need "payments").
 * `db`: also enforced by the database, not just hidden on screen.
 * `page`: a page switch (buttons and inputs on the page need their own items).
 */

export type Level = 'view' | 'edit'

export const GROUPS = [
  'Dashboard',
  'Orders board',
  'New order',
  'Orders list',
  'Order page',
  'Final check',
  'Payments',
  'Crating',
  'Reports',
  'Agent',
  'Settings',
  'Admin',
] as const
export type Group = (typeof GROUPS)[number]

export type PermissionItem = {
  key: string
  group: Group
  /** Sub-heading inside the group ("Cards", "Columns"…). */
  section: string
  label: string
  levels: Level[]
  requires?: string
  needs?: string[]
  db?: boolean
  hint?: string
  /** A page switch. Buttons and inputs need their own item, not the page's. */
  page?: boolean
}

const V: Level[] = ['view']
const E: Level[] = ['edit']
const VE: Level[] = ['view', 'edit']

type Def = Omit<PermissionItem, 'group' | 'section'>
function group(g: Group, sections: Record<string, Def[]>): PermissionItem[] {
  return Object.entries(sections).flatMap(([section, items]) => items.map((i) => ({ ...i, group: g, section })))
}

const ORDER_COLUMNS: [string, string, string[]?][] = [
  ['order', 'Order #'],
  ['stage', 'Stage'],
  ['customer', 'Customer'],
  ['company', 'Company'],
  ['country', 'Country'],
  ['state', 'State / province'],
  ['machines', 'Machines'],
  ['serials', 'Serials'],
  ['ready', 'Ready (built count)'],
  ['expected', 'Expected ship'],
  ['actual', 'Actual ship'],
  ['delay', 'Delay (days)'],
  ['voltage', 'Voltage'],
  ['delivery', 'Delivery equipment'],
  ['freight', 'Freight'],
  ['currency', 'Currency'],
  ['total', 'Total', ['order.field.order_total']],
  ['downpct', 'Down %', ['payments', 'order.field.order_total']],
  ['paid', 'Paid', ['payments']],
  ['outstanding', 'Outstanding', ['payments', 'order.field.order_total']],
  ['nextdue', 'Next payment due', ['payments']],
  ['payment', 'Payment status', ['payments']],
  ['downamount', 'Down payment (CSV only)', ['payments']],
  ['orderdate', 'Order date (CSV only)'],
  ['notes', 'Notes (CSV only)'],
  ['archived', 'Archived (CSV only)'],
]

export const CATALOG: PermissionItem[] = [
  ...group('Dashboard', {
    Page: [{ key: 'dashboard', label: 'Dashboard page', levels: V, page: true }],
    Cards: [
      { key: 'dashboard.card.in_production', label: 'In production (number of orders)', levels: V, requires: 'dashboard' },
      { key: 'dashboard.card.ready', label: 'Ready (number of orders being tested)', levels: V, requires: 'dashboard' },
      { key: 'dashboard.card.ready_to_ship', label: 'Ready to ship (number of orders)', levels: V, requires: 'dashboard' },
      { key: 'dashboard.card.payments_overdue', label: 'Payments overdue (number and amounts)', levels: V, requires: 'dashboard', needs: ['payments'] },
      { key: 'dashboard.card.money_owed', label: 'Money still owed', levels: V, requires: 'dashboard', needs: ['payments', 'order.field.order_total'] },
      { key: 'dashboard.card.average_delay', label: 'Average delay this year', levels: V, requires: 'dashboard' },
    ],
    Charts: [{ key: 'dashboard.chart.delay_by_month', label: 'Average delay by month', levels: V, requires: 'dashboard' }],
    Lists: [
      { key: 'dashboard.list.latest_shipped', label: 'Latest shipped', levels: V, requires: 'dashboard' },
      { key: 'dashboard.list.next_ship_dates', label: 'Next ship dates', levels: V, requires: 'dashboard' },
      { key: 'dashboard.list.next_payments', label: 'Next payments due', levels: V, requires: 'dashboard', needs: ['payments'] },
      { key: 'dashboard.list.schedule_changes', label: 'Schedule changes: orders whose suggested ship date is later than promised (Accept / Keep)', levels: V, requires: 'dashboard', needs: ['schedule'] },
    ],
  }),

  ...group('Orders board', {
    Page: [
      { key: 'orders.board', label: 'Orders board page', levels: V, page: true },
      { key: 'orders.board.refresh', label: 'Refresh button', levels: V, requires: 'orders.board' },
    ],
    Columns: [
      { key: 'orders.board.column.quote', label: 'Quote column', levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.confirmed', label: 'Confirmed column', levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.in_production', label: 'In production column', levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.ready', label: 'Ready column (built, being tested)', levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.ready_to_ship', label: 'Ready to ship column', levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.shipped', label: 'Shipped column (last 30 days)', levels: V, requires: 'orders.board' },
    ],
    'Details on each card': [
      { key: 'orders.board.card.customer', label: 'Customer name', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.company', label: 'Company', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.country', label: 'Country and flag', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.machines', label: 'Machine chips (each machine type and how many)', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.chip_status', label: 'Chip colours: built / final checklist done / crated', levels: V, requires: 'orders.board.card.machines', hint: 'Crated only shows with “Crating” too.' },
      { key: 'orders.board.card.chip_serials', label: 'Serial numbers when hovering over or tapping a chip', levels: V, requires: 'orders.board.card.machines' },
      { key: 'orders.board.card.built', label: 'Machines built (2/3 ready)', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.ship_date', label: 'Ship date', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.deadline', label: 'Next department deadline (amber when close, red when missed)', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.badge_voltage', label: 'Badge: voltage unknown', levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.badge_payment', label: 'Badge: payment overdue / due soon', levels: V, requires: 'orders.board', needs: ['payments'] },
      { key: 'orders.board.card.badge_ship_date', label: 'Badge: ship date close / passed', levels: V, requires: 'orders.board' },
    ],
    Actions: [
      { key: 'orders.board.reorder', label: 'Move orders up and down the queue (drag, ↑ ↓)', levels: E, requires: 'orders.board', db: true },
      { key: 'orders.board.change_stage', label: 'Change stage on the board (drag to another column, “Move to…”, including Shipped)', levels: E, requires: 'orders.board', db: true },
    ],
    'Shop board (large print)': [
      { key: 'shop_board', label: 'Shop board page', levels: V, page: true },
      { key: 'shop_board.print', label: 'Print button', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.customer', label: 'Customer and company', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.country', label: 'Country', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.stage', label: 'Stage', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.ship_date', label: 'Ship-by date', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.voltage', label: 'Voltage', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.built', label: 'Machines built count', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.badges', label: 'Warning badges', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.machines', label: 'Machines and serials', levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.notes', label: 'Order notes', levels: V, requires: 'shop_board' },
    ],
  }),

  ...group('New order', {
    Page: [{ key: 'orders.new', label: 'New order page (create orders)', levels: E, db: true, hint: 'Shipping and payment boxes follow the Order page and Payments permissions.' }],
    'Fields and actions': [
      { key: 'orders.new.customer.new', label: 'Add a new customer while creating an order', levels: E, requires: 'orders.new', db: true },
      { key: 'orders.new.field.order_number', label: 'Choose the order number', levels: E, requires: 'orders.new' },
      { key: 'orders.new.field.stage', label: 'Choose the stage', levels: E, requires: 'orders.new' },
      { key: 'orders.new.split', label: 'Split shipment (76-1, 76-2), also the button on the order page', levels: E, requires: 'orders.new' },
      { key: 'orders.new.serial_by_hand', label: 'Type a serial number by hand', levels: E, requires: 'orders.new' },
      { key: 'orders.new.schedule', label: 'Schedule preview: expected ship date worked out, deadlines timeline', levels: V, requires: 'orders.new' },
    ],
  }),

  ...group('Orders list', {
    Page: [{ key: 'orders.list', label: 'Orders list page', levels: V, page: true }],
    Columns: ORDER_COLUMNS.map(([k, label, needs]) => ({
      key: `orders.list.column.${k}`,
      label,
      levels: V,
      requires: 'orders.list',
      needs,
    })),
    'Filters and tools': [
      { key: 'orders.list.filter.search', label: 'Search box', levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.stage', label: 'Stage filter', levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.voltage', label: 'Voltage filter', levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.payment', label: 'Payment status filter', levels: V, requires: 'orders.list', needs: ['payments'] },
      { key: 'orders.list.filter.archived', label: '“Show archived” tick box', levels: V, requires: 'orders.list' },
      { key: 'orders.list.sort', label: 'Sort by clicking a column heading', levels: V, requires: 'orders.list' },
      { key: 'orders.list.outstanding_total', label: 'Total outstanding (bottom of the list)', levels: V, requires: 'orders.list', needs: ['payments', 'order.field.order_total'] },
      { key: 'orders.list.export_csv', label: 'Export CSV', levels: V, requires: 'orders.list', hint: 'The file only holds the columns this person can see.' },
    ],
  }),

  ...group('Order page', {
    Page: [{ key: 'order.page', label: 'Open an order (order page; also makes orders clickable elsewhere)', levels: V, page: true }],
    Header: [
      { key: 'order.header.customer', label: 'Customer name, company and country', levels: V, requires: 'order.page' },
      { key: 'serial.copy', label: 'Copy button next to serial numbers (everywhere in the app)', levels: V },
      { key: 'customer.contact', label: 'Customer emails and phone (everywhere in the app)', levels: VE, db: true },
      { key: 'order.header.badges', label: 'Warning badges', levels: V, requires: 'order.page' },
    ],
    Buttons: [
      { key: 'order.action.edit', label: '“Edit” button (which fields can be changed is set per field below)', levels: E, requires: 'order.page' },
      { key: 'order.action.change_stage', label: 'Change stage (any stage)', levels: E, requires: 'order.page', db: true },
      { key: 'order.action.mark_shipped', label: 'Mark shipped', levels: E, requires: 'order.page', db: true },
    ],
    Tabs: [
      { key: 'order.tab.activity', label: 'Activity tab (history of the order)', levels: V, requires: 'order.page', db: true },
      { key: 'order.tab.emails', label: 'Emails tab', levels: V, requires: 'order.page' },
      { key: 'order.tab.ai_notes', label: 'AI notes tab', levels: V, requires: 'order.page' },
    ],
    Machines: [
      { key: 'order.section.machines', label: 'Machines section', levels: V, requires: 'order.page' },
      { key: 'order.machines.built', label: 'Built tick boxes (see / tick)', levels: VE, requires: 'order.section.machines', db: true },
      { key: 'order.machines.checklist', label: 'Final check status per machine (and the “Final check” button with “Final check: see”)', levels: V, requires: 'order.section.machines', needs: ['checklist'] },
      { key: 'order.machines.add', label: '“+ Add machines”', levels: E, requires: 'order.section.machines', db: true },
      { key: 'order.machines.crate_flag', label: '“Crate?” tick per machine (only crated machines get a crating deadline)', levels: VE, requires: 'order.section.machines', db: true },
      { key: 'order.machines.remove', label: '“Remove” a machine', levels: E, requires: 'order.section.machines', db: true },
    ],
    'Shipping section': [
      { key: 'order.section.shipping', label: 'Shipping section', levels: V, requires: 'order.page' },
      { key: 'order.field.expected_ship_date', label: 'Expected ship date', levels: VE, db: true },
      { key: 'order.field.actual_ship_date', label: 'Actual ship date', levels: VE, db: true },
      { key: 'order.field.delay', label: 'Delay (days late / early)', levels: V },
      { key: 'order.field.voltage', label: 'Voltage', levels: VE, db: true },
      { key: 'order.field.delivery_equipment', label: 'Delivery equipment', levels: VE, db: true },
      { key: 'order.field.freight_type', label: 'Freight type', levels: VE, db: true },
      { key: 'order.field.order_date', label: 'Order date', levels: V },
      { key: 'order.field.currency', label: 'Currency', levels: VE, db: true },
    ],
    'Money and notes': [
      { key: 'order.field.order_total', label: 'Order total (everywhere in the app)', levels: VE, db: true },
      { key: 'order.field.notes', label: 'Notes', levels: VE, db: true },
      { key: 'order.section.payments', label: 'Payments section on the order page', levels: V, requires: 'order.page', needs: ['payments'] },
    ],
  }),

  ...group('Order page', {
    Schedule: [
      { key: 'schedule', label: 'Schedule section: how the ship date was worked out, department deadlines timeline', levels: V, requires: 'order.page' },
      { key: 'schedule.machines', label: 'Deadlines per machine', levels: V, requires: 'schedule' },
      { key: 'schedule.step_done', label: 'Mark department steps done (Fabrication, Sandblasting…)', levels: E, requires: 'schedule', db: true },
      { key: 'schedule.accept', label: 'Accept or keep suggested new dates', levels: E, db: true },
    ],
  }),

  ...group('Final check', {
    'Checklist screen': [
      { key: 'checklist', label: 'See final checks (checklist screen, progress on orders and board chips)', levels: V, db: true, page: true },
      { key: 'checklist.filters', label: '“Show only items still to do”, open / close sections', levels: V, requires: 'checklist' },
      { key: 'checklist.col.notes', label: 'Notes column', levels: V, requires: 'checklist' },
      { key: 'checklist.col.who', label: 'Who ticked each item and when', levels: V, requires: 'checklist' },
      { key: 'checklist.general_notes', label: 'General notes for the machine', levels: V, requires: 'checklist' },
      { key: 'checklist.photos', label: 'Photo spots (photos come in a later update)', levels: V, requires: 'checklist' },
      { key: 'checklist.print', label: 'Print / PDF of a signed checklist', levels: V, requires: 'checklist' },
    ],
    Actions: [
      { key: 'checklist.start', label: 'Start a machine’s final check', levels: E, requires: 'checklist', db: true },
      { key: 'checklist.tick', label: 'Tick items, mark N/A, write item notes and general notes', levels: E, requires: 'checklist', db: true },
      { key: 'checklist.add_item', label: 'Add a one-off item to one machine’s checklist', levels: E, requires: 'checklist', db: true },
      { key: 'checklist.sign', label: 'Sign off a final check (locks it)', levels: E, requires: 'checklist', db: true },
      { key: 'checklist.unlock', label: 'Unlock a signed final check (with a reason, logged)', levels: E, requires: 'checklist', db: true },
    ],
    'Moving orders': [
      { key: 'checklist.ready_reminder', label: 'Reminder of machines whose final check hasn’t started, when moving an order to Ready', levels: V, needs: ['checklist'] },
      { key: 'checklist.override', label: 'Move an order to Ready to ship without all final checks signed (with a reason, logged)', levels: E, db: true },
    ],
  }),

  ...group('Payments', {
    Data: [{ key: 'payments', label: 'Payment data everywhere (amounts, due dates, received). Without it, payments can’t be read at all.', levels: VE, db: true }],
    Page: [
      { key: 'payments.page', label: 'Payments page', levels: V, needs: ['payments'], page: true },
      { key: 'payments.page.refresh', label: 'Refresh button on the Payments page', levels: V, requires: 'payments.page' },
    ],
    Actions: [
      { key: 'payments.action.add', label: 'Add a payment', levels: E, needs: ['payments'] },
      { key: 'payments.action.edit', label: 'Edit a payment', levels: E, needs: ['payments'] },
      { key: 'payments.action.delete', label: 'Delete a payment', levels: E, needs: ['payments'], db: true },
      { key: 'payments.action.mark_received', label: 'Mark received', levels: E, needs: ['payments'], db: true },
      { key: 'payments.action.undo_received', label: 'Undo received', levels: E, needs: ['payments'] },
    ],
  }),

  ...group('Crating', {
    Data: [{ key: 'crating', label: 'Crates on orders and the shop board (Edit: tick “Crated?”, add, change, remove crates)', levels: VE, db: true }],
    'Order page': [
      { key: 'crating.summary', label: 'Crating summary', levels: V, needs: ['crating'] },
      { key: 'crating.summary.copy', label: 'Copy button (freight quote text)', levels: V, requires: 'crating.summary' },
      { key: 'crating.ship_warning', label: 'Warning when marking shipped with machines not crated', levels: V, needs: ['crating'] },
      { key: 'crating.units', label: 'Imperial / Metric switch', levels: V },
    ],
  }),

  ...group('Reports', {
    'Department delays': [
      { key: 'reports.department_delays', label: 'Department delays report (on-time %, days late per department)', levels: V, page: true, db: true },
      { key: 'reports.department_delays.by_month', label: 'Table: by month', levels: V, requires: 'reports.department_delays' },
      { key: 'reports.department_delays.period', label: 'Choose the period (last 3 / 6 / 12 months, all time)', levels: V, requires: 'reports.department_delays' },
    ],
    'Crating report': [

      { key: 'reports.crating', label: 'Crating report page', levels: V, needs: ['crating'], page: true },
      { key: 'reports.crating.filters', label: 'Date and machine type filters', levels: V, requires: 'reports.crating' },
      { key: 'reports.crating.by_type', label: 'Table: by machine type', levels: V, requires: 'reports.crating' },
      { key: 'reports.crating.every_crate', label: 'Table: every crate', levels: V, requires: 'reports.crating' },
      { key: 'reports.crating.export_csv', label: 'Export CSV (every crate)', levels: V, requires: 'reports.crating.every_crate' },
      { key: 'reports.crating.export_summary', label: 'Summary CSV', levels: V, requires: 'reports.crating.by_type' },
    ],
  }),

  ...group('Agent', {
    Page: [{ key: 'agent', label: 'Agent page (coming soon)', levels: V, page: true }],
  }),

  ...group('Settings', {
    Page: [
      { key: 'settings', label: 'Settings page', levels: V, page: true },
      { key: 'settings.account', label: 'Your account (email, role, departments)', levels: V, requires: 'settings' },
      { key: 'settings.start_page', label: 'Choose their own start page (the page that opens after signing in)', levels: E, requires: 'settings', db: true },
      { key: 'settings.units', label: 'Units for crate sizes', levels: V, requires: 'settings', needs: ['crating.units'] },
      { key: 'settings.notifications', label: 'Desktop notifications', levels: V, requires: 'settings' },
      { key: 'settings.connection', label: 'Database connection status', levels: V, requires: 'settings' },
    ],
    Alerts: [
      { key: 'alerts.bell', label: 'Alerts bell in the top bar', levels: V, hint: 'Payment alerts also need “payments”.' },
      { key: 'alerts.popups', label: 'Pop-ups and desktop notifications for red alerts', levels: V, requires: 'alerts.bell' },
      { key: 'alerts.snooze', label: 'Snooze and dismiss alerts', levels: E, requires: 'alerts.bell' },
    ],
  }),

  ...group('Admin', {
    Pages: [
      { key: 'admin.users', label: 'Users: add, rename, remove, departments (only full admins change permissions or make admins)', levels: E, db: true },
      { key: 'admin.departments', label: 'Departments', levels: E, db: true },
      { key: 'admin.machine_types', label: 'Machine types', levels: E, db: true },
      { key: 'admin.dropdowns', label: 'Dropdown lists', levels: E, db: true },
      { key: 'admin.checklists', label: 'Checklist templates (edit checklist templates)', levels: E, db: true },
      { key: 'admin.stages', label: 'Stage names (rename what people see, e.g. “Ready / testing”)', levels: E, db: true },
      { key: 'admin.order_defaults', label: 'Order defaults (currency, voltage, crate, payment due days)', levels: E, db: true },
      { key: 'admin.scheduling', label: 'Scheduling (working days, holidays, buffer, machines one after another)', levels: E, db: true },
      { key: 'admin.records', label: 'Orders, customers & machines: edit any field, archive', levels: E, db: true },
      { key: 'admin.serials', label: 'Serial numbers', levels: E, db: true },
      { key: 'admin.board', label: 'Shop queue repair', levels: E, db: true },
      { key: 'admin.alerts', label: 'Alert settings', levels: E, db: true },
      { key: 'admin.company', label: 'Company details', levels: E, db: true },
      { key: 'admin.import', label: 'Import & backup', levels: E, db: true },
      { key: 'admin.archive', label: 'Archive: bring back, delete for good', levels: E, db: true },
      { key: 'admin.activity', label: 'Activity: every change, who and when', levels: V, db: true },
    ],
  }),
]

export const CATALOG_BY_KEY = new Map(CATALOG.map((i) => [i.key, i]))

/** Every Admin page key (the Admin menu shows when any of them is allowed). */
export const ADMIN_KEYS = CATALOG.filter((i) => i.group === 'Admin').map((i) => i.key)
