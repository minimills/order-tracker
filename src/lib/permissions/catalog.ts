/**
 * THE permissions catalog: every page, card, chart, list, column, field, tab,
 * button and action in the app has one entry here.
 *
 * Rules (checked by `npm run check:perms`, which runs before every commit):
 * - Every screen element is wrapped in <Can permission="…"> (or a route in
 *   <Page permission="…">) with a key from this list.
 * - Every key here is used somewhere in the code.
 * - New features add their items here. Non-admin users don't have them until
 *   an admin allows them in Admin → Users (they show a "New" badge there).
 *
 * Levels: "view" = can see it; "edit" = can change it / use the button
 * (edit includes view). Items with only "edit" are buttons and actions.
 *
 * `requires`: shown only when that item (usually the page) is allowed too.
 * `needs`: also needs these data permissions (for example money columns need "payments").
 * `db`: also enforced by the database, not just hidden on screen.
 * `page`: a page switch (buttons and inputs on the page need their own items).
 */

export type Level = 'view' | 'edit'

/** Marks a label as a translation key (shown with tr() in the permission editor). Same as tk() in src/i18n. Kept here so this file has no imports (scripts read it with Node). */
const tk = <S extends string>(text: S): S => text

export const GROUPS = [
  'Dashboard',
  'Orders board',
  'New order',
  'Orders list',
  'Order page',
  'Final check',
  'CE Declarations',
  'Payments',
  'Crating',
  'Freight',
  'Boards',
  'Notice Board',
  'Service / Training',
  'Calendar',
  'Timesheets',
  'Chat',
  'Automations',
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
  /** Allowed for everyone by default (new people start with it; an admin can still revoke it). */
  defaultOn?: boolean
}

const V: Level[] = ['view']
const E: Level[] = ['edit']
const VE: Level[] = ['view', 'edit']

type Def = Omit<PermissionItem, 'group' | 'section'>
function group(g: Group, sections: Record<string, Def[]>): PermissionItem[] {
  return Object.entries(sections).flatMap(([section, items]) => items.map((i) => ({ ...i, group: g, section })))
}

const ORDER_COLUMNS: [string, string, string[]?][] = [
  ['order', tk('Order #')],
  ['quote', tk('Quote #')],
  ['invoice', tk('Invoice #')],
  ['stage', tk('Stage')],
  ['customer', tk('Customer')],
  ['company', tk('Company')],
  ['country', tk('Country')],
  ['state', tk('State / province')],
  ['machines', tk('Machines')],
  ['serials', tk('Serials')],
  ['ready', tk('Ready (built count)')],
  ['expected', tk('Expected ship (revised)')],
  ['original', tk('Original ship date')],
  ['revisions', tk('Ship date changes')],
  ['actual', tk('Actual ship')],
  ['delay', tk('Delay (days)')],
  ['voltage', tk('Voltage')],
  ['delivery', tk('Delivery equipment')],
  ['freight', tk('Freight')],
  ['currency', tk('Currency')],
  ['total', tk('Total'), ['order.field.order_total']],
  ['downpct', tk('Down %'), ['payments', tk('order.field.order_total')]],
  ['paid', tk('Paid'), ['payments']],
  ['outstanding', tk('Outstanding'), ['payments', tk('order.field.order_total')]],
  ['nextdue', tk('Next payment due'), ['payments']],
  ['payment', tk('Payment status'), ['payments']],
  ['downamount', tk('Down payment (CSV only)'), ['payments']],
  ['orderdate', tk('Order date (CSV only)')],
  ['notes', tk('Notes (CSV only)')],
  ['archived', tk('Archived (CSV only)')],
  ['training', tk('Training needed')],
  ['technician', tk('Technician')],
  ['service_dates', tk('Training dates')],
  ['service_days', tk('Training / travel days')],
]

export const CATALOG: PermissionItem[] = [
  ...group('Dashboard', {
    Page: [{ key: 'dashboard', label: tk("Dashboard page"), levels: V, page: true }],
    Cards: [
      { key: 'dashboard.card.in_production', label: tk("In production (number of orders)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.card.ready', label: tk("Ready (number of orders being tested)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.card.ready_to_ship', label: tk("Ready to ship (number of orders)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.card.payments_overdue', label: tk("Payments overdue (number and amounts)"), levels: V, requires: 'dashboard', needs: ['payments'] },
      { key: 'dashboard.card.money_owed', label: tk("Money still owed"), levels: V, requires: 'dashboard', needs: ['payments', 'order.field.order_total'] },
      { key: 'dashboard.card.average_delay', label: tk("Average delay this year"), levels: V, requires: 'dashboard' },
    ],
    'Customize': [
      { key: 'dashboard.charts', label: tk("Chart widgets (each chart allowed under “Charts” below)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.switch', label: tk("Tabs to switch between their dashboards (when they have more than one)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.refresh', label: tk("Refresh Now (widgets also refresh by themselves when the data changes)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.charts.customize', label: tk("Customize their own dashboards: Edit Dashboard, add widgets, drag to move and resize, widget settings (saved per person and screen size)"), levels: E, requires: 'dashboard', db: true },
      { key: 'dashboard.tabs', label: tk("Several dashboards as tabs: create, rename, reorder, duplicate, delete, choose the default"), levels: E, requires: 'dashboard.charts.customize', db: true },
      { key: 'dashboard.share', label: tk("Share a dashboard with others (each person gets a copy)"), levels: E, requires: 'dashboard', db: true },
      { key: 'dashboard.reset', label: tk("Reset a dashboard to the template it came from"), levels: E, requires: 'dashboard', db: true },
      { key: 'dashboard.charts.form', label: tk("Widget setting: form (column, bar, line, pie, gauge, gauge with targets, number, table)"), levels: V, requires: 'dashboard.charts.customize' },
      { key: 'dashboard.charts.dates', label: tk("Widget setting: date range (today, this week, month, quarter, year, last year, custom; compare with last year)"), levels: V, requires: 'dashboard.charts.customize' },
      { key: 'dashboard.widget.filters', label: tk("Widget setting: filters (department, machine type, customer country, board)"), levels: V, requires: 'dashboard.charts.customize' },
      { key: 'dashboard.widget.colour', label: tk("Widget setting: colour"), levels: V, requires: 'dashboard.charts.customize' },
      { key: 'dashboard.widget.health', label: tk("Widget setting: good and bad colours for this widget (whether higher is better or worse, and the limits)"), levels: V, requires: 'dashboard.charts.customize' },
      { key: 'dashboard.charts.print', label: tk("Print the dashboard or chosen widgets (with the letterhead)"), levels: V, requires: 'dashboard' },
    ],
    Widgets: [
      { key: 'dashboard.widget.my_work', label: tk("My work: cards and tasks assigned to them, with Start, Pause and Finish on the dashboard (only boards they can open; the buttons also need the board timing permission)"), levels: V, requires: 'dashboard', needs: ['boards'] },
      { key: 'dashboard.widget.my_tasks', label: tk("My tasks (open cards assigned to them on boards they can open)"), levels: V, requires: 'dashboard', needs: ['boards'] },
      { key: 'dashboard.widget.overdue', label: tk("Overdue items (their overdue cards; overdue payments and passed ship dates where allowed)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.widget.new_orders', label: tk("New orders (the last 14 days)"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.widget.board_snapshot', label: tk("Board snapshot: cards per stage of a chosen board (only boards they can open)"), levels: V, requires: 'dashboard', needs: ['boards'] },
      { key: 'dashboard.widget.calendar', label: tk("Today’s calendar (their own calendar)"), levels: V, requires: 'dashboard', needs: ['service.calendar'] },
      { key: 'dashboard.widget.events', label: tk("Upcoming company events"), levels: V, requires: 'dashboard', needs: ['notices.events'] },
      { key: 'dashboard.widget.holidays', label: tk("Upcoming holidays and closures"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.widget.notices', label: tk("Latest notices (only notices meant for them)"), levels: V, requires: 'dashboard', needs: ['notices'] },
      { key: 'dashboard.widget.chats', label: tk("Unread chats"), levels: V, requires: 'dashboard', needs: ['chat'] },
      { key: 'dashboard.widget.freight_totals', label: tk("Freight and crating totals (plywood sheets, crates, crating hours)"), levels: V, requires: 'dashboard', needs: ['crating'] },
      { key: 'dashboard.widget.labour_cost', label: tk("Labour cost (total, overtime, cost per hour)"), levels: V, requires: 'dashboard', needs: ['payroll.pay'], db: true },
      { key: 'dashboard.widget.note', label: tk("Personal note (only they can see it)"), levels: V, requires: 'dashboard' },
    ],
    Charts: [
      { key: 'dashboard.chart.delay_by_month', label: tk("Average delay by month"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.chart.delay_by_year', label: tk("Average delay by year"), levels: V, requires: 'dashboard.charts' },
      { key: 'dashboard.chart.on_time', label: tk("On-time and late shipments"), levels: V, requires: 'dashboard.charts' },
      { key: 'dashboard.chart.top_machines', label: tk("Most ordered machines"), levels: V, requires: 'dashboard.charts' },
      { key: 'dashboard.chart.by_country', label: tk("Orders by country"), levels: V, requires: 'dashboard.charts' },
      { key: 'dashboard.chart.voltage', label: tk("120V and 240V machines built"), levels: V, requires: 'dashboard.charts' },
      { key: 'dashboard.chart.speed_employee', label: tk("Build speed by employee (from the board timers; shows names)"), levels: V, requires: 'dashboard.charts', db: true },
      { key: 'dashboard.chart.speed_task', label: tk("Build speed by task (from the board timers)"), levels: V, requires: 'dashboard.charts', db: true },
      { key: 'dashboard.chart.department_delays', label: tk("Department delays"), levels: V, requires: 'dashboard.charts', needs: ['reports.department_delays'] },
      { key: 'dashboard.chart.service_days', label: tk("Planned service call days and planned travel days"), levels: V, requires: 'dashboard.charts', needs: ['service', 'service.calls'] },
      { key: 'dashboard.chart.service_hours', label: tk("Total travel hours and service hours"), levels: V, requires: 'dashboard.charts', needs: ['service.log'] },
      { key: 'dashboard.chart.payments_on_time', label: tk("On-time and late payments"), levels: V, requires: 'dashboard.charts', needs: ['payments'] },
      { key: 'dashboard.chart.outstanding', label: tk("Money outstanding by currency"), levels: V, requires: 'dashboard.charts', needs: ['payments'] },
      { key: 'dashboard.chart.board_cards', label: tk("Open cards on chosen boards, by stage (only boards the person can open)"), levels: V, requires: 'dashboard.charts', needs: ['boards'] },
      { key: 'dashboard.chart.crating_plywood', label: tk("Plywood sheets used (from Freight)"), levels: V, requires: 'dashboard.charts', needs: ['crating'] },
      { key: 'dashboard.chart.crating_crates', label: tk("Crates made (from Freight)"), levels: V, requires: 'dashboard.charts', needs: ['crating'] },
      { key: 'dashboard.chart.crating_hours', label: tk("Crating hours (from Freight)"), levels: V, requires: 'dashboard.charts', needs: ['crating'] },
    ],
    Lists: [
      { key: 'dashboard.list.latest_shipped', label: tk("Latest shipped"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.list.next_ship_dates', label: tk("Next ship dates"), levels: V, requires: 'dashboard' },
      { key: 'dashboard.list.next_payments', label: tk("Next payments due"), levels: V, requires: 'dashboard', needs: ['payments'] },
      { key: 'dashboard.whos_off', label: tk("Who’s off today (approved time off; the reason only with “Absence Calendar”)"), levels: V, requires: 'dashboard', db: true },
      { key: 'dashboard.list.schedule_changes', label: tk("Schedule changes: orders whose suggested ship date is later than promised (Accept / Keep)"), levels: V, requires: 'dashboard', needs: ['schedule'] },
    ],
  }),

  ...group('Orders board', {
    Page: [
      { key: 'orders.board', label: tk("Orders board page"), levels: V, page: true },
      { key: 'orders.board.refresh', label: tk("Refresh button"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.print', label: tk("Print button: the board as shown (print preview with the letterhead)"), levels: V, requires: 'orders.board' },
    ],
    Columns: [
      { key: 'orders.board.column.quote', label: tk("Quote column"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.confirmed', label: tk("Confirmed column"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.in_production', label: tk("In production column"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.ready', label: tk("Ready column (built, being tested)"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.ready_to_ship', label: tk("Ready to ship column"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.column.shipped', label: tk("Shipped column (last 30 days)"), levels: V, requires: 'orders.board' },
    ],
    'Details on each card': [
      { key: 'orders.board.card.customer', label: tk("Customer name (only when there is no company name)"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.voltage', label: tk("Voltage chip at the top of the card (colours in Admin → Dropdown Lists)"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.new_order_banner', label: tk("Banner “New order 87 added” when a new order lands in Confirmed"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.company', label: tk("Company"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.country', label: tk("Country and flag"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.machines', label: tk("Machine chips (each machine type and how many)"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.chip_status', label: tk("Chip colours: built / final checklist done / crated"), levels: V, requires: 'orders.board.card.machines', hint: tk("Crated only shows with “Crating” too.") },
      { key: 'orders.board.card.chip_serials', label: tk("Serial numbers when hovering over or tapping a chip"), levels: V, requires: 'orders.board.card.machines' },
      { key: 'orders.board.card.built', label: tk("Machines built (2/3 ready)"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.ship_date', label: tk("Ship date"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.service', label: tk("Training dates and technician"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.deadline', label: tk("Next department deadline (amber when close, red when missed)"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.badge_voltage', label: tk("Badge: voltage unknown"), levels: V, requires: 'orders.board' },
      { key: 'orders.board.card.badge_payment', label: tk("Badge: payment overdue / due soon"), levels: V, requires: 'orders.board', needs: ['payments'] },
      { key: 'orders.board.card.badge_ship_date', label: tk("Badge: ship date close / passed"), levels: V, requires: 'orders.board' },
    ],
    Actions: [
      { key: 'orders.board.reorder', label: tk("Move orders up and down the queue (drag, ↑ ↓)"), levels: E, requires: 'orders.board', db: true },
      { key: 'orders.board.change_stage', label: tk("Change stage on the board (drag to another column, “Move to…”, including Shipped)"), levels: E, requires: 'orders.board', db: true },
    ],
    'Shop board (large print)': [
      { key: 'shop_board', label: tk("Shop board page"), levels: V, page: true },
      { key: 'shop_board.print', label: tk("Print button (prints what the filters show)"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.filters', label: tk("Filters: search (customer, country, serial number), stage, orders, ship date before / after, machine type, ship date passed (by more than X days)"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.sort', label: tk("Order # ascending / descending switch (remembered per person; ascending without it)"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.views', label: tk("View: across, list or cards (remembered per person)"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.customer', label: tk("Customer and company"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.country', label: tk("Country"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.stage', label: tk("Stage"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.ship_date', label: tk("Ship-by date"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.voltage', label: tk("Voltage"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.built', label: tk("Machines built count"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.badges', label: tk("Warning badges"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.machines', label: tk("Machines and serials"), levels: V, requires: 'shop_board' },
      { key: 'shop_board.detail.notes', label: tk("Order notes"), levels: V, requires: 'shop_board' },
    ],
  }),

  ...group('New order', {
    Page: [{ key: 'orders.new', label: tk("New order page (create orders)"), levels: E, db: true, hint: tk("Shipping and payment boxes follow the Order page and Payments permissions.") }],
    'Fields and actions': [
      { key: 'orders.new.customer.new', label: tk("Add a new customer while creating an order"), levels: E, requires: 'orders.new', db: true },
      { key: 'orders.new.field.order_number', label: tk("Choose the order number"), levels: E, requires: 'orders.new' },
      { key: 'orders.new.field.stage', label: tk("Choose the stage"), levels: E, requires: 'orders.new' },
      { key: 'orders.new.split', label: tk("Split shipment (76-1, 76-2), also the button on the order page"), levels: E, requires: 'orders.new' },
      { key: 'orders.new.serial_by_hand', label: tk("Type a serial number by hand"), levels: E, requires: 'orders.new' },
      { key: 'orders.new.schedule', label: tk("Schedule preview: expected ship date worked out, deadlines timeline"), levels: V, requires: 'orders.new' },
      { key: 'orders.new.crating', label: tk("“Will this order be crated?” (No = no Crating stage and no crating boxes for the order)"), levels: E, requires: 'orders.new' },
    ],
  }),

  ...group('Orders list', {
    Page: [
      { key: 'orders.list', label: tk("Orders list page"), levels: V, page: true },
      { key: 'orders.list.print', label: tk("Print button: the rows and columns shown (print preview with the letterhead)"), levels: V, requires: 'orders.list' },
    ],
    Columns: ORDER_COLUMNS.map(([k, label, needs]) => ({
      key: `orders.list.column.${k}`,
      label,
      levels: V,
      requires: 'orders.list',
      needs,
    })),
    'Filters and tools': [
      { key: 'orders.list.filter.search', label: tk("Search box"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.stage', label: tk("Stage filter"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.voltage', label: tk("Voltage filter"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.payment', label: tk("Payment status filter"), levels: V, requires: 'orders.list', needs: ['payments'] },
      { key: 'orders.list.filter.archived', label: tk("“Show archived” option"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.columns', label: tk("Choose columns (remembered in this browser)"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.checkboxes', label: tk("Filter by several stages, voltages and machine types at once (checkboxes)"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.ship_dates', label: tk("Filter by expected ship date and actual ship date (from / to)"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.delay', label: tk("Filter by delay in days (lowest / highest)"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.currency', label: tk("Filter by currency"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.filter.training', label: tk("Filter by on-site training (needed / not needed)"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.rows', label: tk("Hide rows from the list (and the CSV); “Show Hidden Rows” brings them back (remembered in this browser)"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.sort', label: tk("Sort by clicking a column heading"), levels: V, requires: 'orders.list' },
      { key: 'orders.list.outstanding_total', label: tk("Total outstanding (bottom of the list)"), levels: V, requires: 'orders.list', needs: ['payments', 'order.field.order_total'] },
      { key: 'orders.list.export_csv', label: tk("Export CSV"), levels: V, requires: 'orders.list', hint: tk("The file only holds the columns this person can see.") },
    ],
  }),

  ...group('Order page', {
    Page: [
      { key: 'order.page', label: tk("Open an order (order page; also makes orders clickable elsewhere)"), levels: V, page: true },
      { key: 'order.print', label: tk("Print button on the order page (print preview with the letterhead; choose the sections to include)"), levels: V, requires: 'order.page' },
    ],
    Header: [
      { key: 'order.header.customer', label: tk("Customer name, company and country"), levels: V, requires: 'order.page' },
      { key: 'serial.copy', label: tk("Copy button next to serial numbers (everywhere in the app)"), levels: V },
      { key: 'customer.language', label: tk("Customer’s preferred language for emails and documents (edit: change it)"), levels: VE, db: true },
      { key: 'customer.contact', label: tk("Customer emails and phone (everywhere in the app)"), levels: VE, db: true },
      { key: 'order.header.badges', label: tk("Warning badges"), levels: V, requires: 'order.page' },
    ],
    Buttons: [
      { key: 'order.action.edit', label: tk("“Edit” button (which fields can be changed is set per field below)"), levels: E, requires: 'order.page' },
      { key: 'order.action.change_stage', label: tk("Change stage (any stage)"), levels: E, requires: 'order.page', db: true },
      { key: 'order.action.mark_shipped', label: tk("Mark shipped"), levels: E, requires: 'order.page', db: true },
    ],
    Tabs: [
      { key: 'order.tab.activity', label: tk("Activity tab (history of the order)"), levels: V, requires: 'order.page', db: true },
      { key: 'order.tab.emails', label: tk("Emails tab"), levels: V, requires: 'order.page' },
      { key: 'order.tab.ai_notes', label: tk("AI notes tab"), levels: V, requires: 'order.page' },
    ],
    Machines: [
      { key: 'order.section.machines', label: tk("Machines section"), levels: V, requires: 'order.page' },
      { key: 'order.machines.built', label: tk("Built status per machine (view / mark as built)"), levels: VE, requires: 'order.section.machines', db: true },
      { key: 'order.production_link', label: tk("Links to the production board and each machine’s production card"), levels: V, requires: 'order.section.machines', needs: ['boards'] },
      { key: 'order.machines.progress', label: tk("Production stage and % per machine instead of “Not built” (Order page and Orders board chips)"), levels: V, db: true },
      { key: 'order.machines.checklist', label: tk("Final check status per machine (and the “Final check” button with “Final check: see”)"), levels: V, requires: 'order.section.machines', needs: ['checklist'] },
      { key: 'order.machines.add', label: tk("“Add Machines” button"), levels: E, requires: 'order.section.machines', db: true },
      { key: 'order.machines.crate_flag', label: tk("“Crate” setting per machine (only crated machines get a crating deadline)"), levels: VE, requires: 'order.section.machines', db: true },
      { key: 'order.machines.remove', label: tk("“Remove” a machine"), levels: E, requires: 'order.section.machines', db: true },
    ],
    'Machine page': [
      { key: 'machines', label: tk("Machine page: search by serial number, owners and the whole history (built, owners, service, training, final check, crating, shipping)"), levels: V, page: true, db: true },
      { key: 'machines.search', label: tk("Search box on the Machines page: narrows the list of every machine as you type (serial, model, customer, country, order #)"), levels: V, requires: 'machines' },
      { key: 'machines.print', label: tk("Print button on the machine pages (search results, details and history)"), levels: V, requires: 'machines' },
      { key: 'machines.transfer', label: tk("“Transfer / Resold”: give a machine a new owner (date, notes, optional order)"), levels: E, requires: 'machines', db: true },
    ],
    'Shipping section': [
      { key: 'order.section.shipping', label: tk("Shipping section"), levels: V, requires: 'order.page' },
      { key: 'order.field.expected_ship_date', label: tk("Expected ship date"), levels: VE, db: true },
      { key: 'order.field.actual_ship_date', label: tk("Actual ship date"), levels: VE, db: true },
      { key: 'order.field.delay', label: tk("Delay (days late / early)"), levels: V },
      { key: 'order.field.voltage', label: tk("Voltage"), levels: VE, db: true },
      { key: 'order.field.delivery_equipment', label: tk("Delivery equipment"), levels: VE, db: true },
      { key: 'order.field.freight_type', label: tk("Freight type"), levels: VE, db: true },
      { key: 'order.field.order_date', label: tk("Order date"), levels: V },
      { key: 'order.field.quote_number', label: tk("Quote #"), levels: VE, db: true },
      { key: 'order.field.invoice_number', label: tk("Invoice #"), levels: VE, db: true },
      { key: 'order.ship_history', label: tk("Revised ship date: original date, number of changes and the history (old, new, who, when, reason)"), levels: V, requires: 'order.section.shipping' },
      { key: 'order.field.currency', label: tk("Currency"), levels: VE, db: true },
    ],
    'Service / Training section': [
      { key: 'order.section.freight', label: tk("Freight section (shipment cost breakdowns and the freight quote request of the order)"), levels: V, requires: 'order.page', hint: tk("Shows what the Freight permissions allow.") },
      { key: 'order.section.service', label: tk("Service / Training section (on-site training and commissioning plan)"), levels: V, requires: 'order.page' },
      { key: 'order.field.training_needed', label: tk("Training needed"), levels: VE, requires: 'order.section.service', db: true },
      { key: 'order.field.training_days', label: tk("On-site training days"), levels: VE, requires: 'order.section.service', db: true },
      { key: 'order.field.travel_days', label: tk("Travel days"), levels: VE, requires: 'order.section.service', db: true },
      { key: 'order.field.technician', label: tk("Assigned technician"), levels: VE, requires: 'order.section.service', db: true },
      { key: 'order.field.service_dates', label: tk("Planned start and end dates"), levels: VE, requires: 'order.section.service', db: true },
    ],
    'Money and notes': [
      { key: 'order.field.order_total', label: tk("Order total (everywhere in the app)"), levels: VE, db: true },
      { key: 'order.field.notes', label: tk("Notes"), levels: VE, db: true },
      { key: 'order.field.crating', label: tk("Will this order be crated? (edit: change it; turning it off hides the Crating stage and every crating box for the order)"), levels: VE, db: true },
      { key: 'order.section.payments', label: tk("Payments section on the order page"), levels: V, requires: 'order.page', needs: ['payments'] },
    ],
  }),

  ...group('Order page', {
    Schedule: [
      { key: 'schedule', label: tk("Schedule section: how the ship date was worked out, department deadlines timeline"), levels: V, requires: 'order.page' },
      { key: 'schedule.machines', label: tk("Deadlines per machine"), levels: V, requires: 'schedule' },
      { key: 'schedule.step_done', label: tk("Mark department steps done (Fabrication, Sandblasting…)"), levels: E, requires: 'schedule', db: true },
      { key: 'schedule.accept', label: tk("Accept or keep suggested new dates"), levels: E, db: true },
    ],
  }),

  ...group('CE Declarations', {
    Declarations: [
      { key: 'ce', label: tk("CE declarations of conformity: register on the order and machine pages, Download PDF and Print"), levels: V, db: true },
      { key: 'ce.issue', label: tk("Issue CE declarations (choose machines, preview, sign, generate) and reissue a new version"), levels: E, requires: 'ce', db: true },
      { key: 'ce.email', label: tk("Email CE declarations (To, CC, BCC, message, one PDF per machine or one combined PDF)"), levels: E, requires: 'ce', db: true },
    ],
  }),

  ...group('Final check', {
    'Checklist screen': [
      { key: 'checklist', label: tk("See final checks (checklist screen, progress on orders and board chips)"), levels: V, db: true, page: true },
      { key: 'checklist.filters', label: tk("“Show only items still to do”, open / close sections"), levels: V, requires: 'checklist' },
      { key: 'checklist.col.notes', label: tk("Notes column"), levels: V, requires: 'checklist' },
      { key: 'checklist.col.who', label: tk("Who completed each item and when"), levels: V, requires: 'checklist' },
      { key: 'checklist.general_notes', label: tk("General notes for the machine"), levels: V, requires: 'checklist' },
      { key: 'checklist.photos', label: tk("Photo spots (photos come in a later update)"), levels: V, requires: 'checklist' },
      { key: 'checklist.print', label: tk("Print / PDF of a signed checklist"), levels: V, requires: 'checklist' },
    ],
    Actions: [
      { key: 'checklist.start', label: tk("Start a machine’s final check"), levels: E, requires: 'checklist', db: true },
      { key: 'checklist.tick', label: tk("Mark items complete or not applicable, write item notes and general notes"), levels: E, requires: 'checklist', db: true },
      { key: 'checklist.add_item', label: tk("Add a one-off item to one machine’s checklist"), levels: E, requires: 'checklist', db: true },
      { key: 'checklist.sign', label: tk("Sign off a final check (locks it)"), levels: E, requires: 'checklist', db: true },
      { key: 'checklist.unlock', label: tk("Unlock a signed final check (with a reason, logged)"), levels: E, requires: 'checklist', db: true },
    ],
    'Moving orders': [
      { key: 'checklist.ready_reminder', label: tk("Reminder of machines whose final check hasn’t started, when moving an order to Ready"), levels: V, needs: ['checklist'] },
      { key: 'checklist.override', label: tk("Move an order to Ready to ship without all final checks signed (with a reason, logged)"), levels: E, db: true },
    ],
  }),

  ...group('Payments', {
    Data: [{ key: 'payments', label: tk("Payment data everywhere (amounts, due dates, received). Without it, payments can’t be read at all."), levels: VE, db: true }],
    Page: [
      { key: 'payments.page', label: tk("Payments page"), levels: V, needs: ['payments'], page: true },
      { key: 'payments.page.refresh', label: tk("Refresh button on the Payments page"), levels: V, requires: 'payments.page' },
      { key: 'payments.print', label: tk("Print button on the Payments page"), levels: V, requires: 'payments.page' },
    ],
    Actions: [
      { key: 'payments.action.add', label: tk("Add a payment"), levels: E, needs: ['payments'] },
      { key: 'payments.action.edit', label: tk("Edit a payment"), levels: E, needs: ['payments'] },
      { key: 'payments.action.delete', label: tk("Delete a payment"), levels: E, needs: ['payments'], db: true },
      { key: 'reminders.send', label: tk("“Send Reminder”: email a customer about a payment or the ship date (on an order and on the Payments page)"), levels: E, db: true, hint: tk("The reminder shows the customer’s email, the amount and the due date of that order.") },
      { key: 'reminders', label: tk("Reminders sent before (list in the Send Reminder box)"), levels: V, db: true },
      { key: 'payments.action.mark_received', label: tk("Mark received"), levels: E, needs: ['payments'], db: true },
      { key: 'payments.action.undo_received', label: tk("Undo received"), levels: E, needs: ['payments'] },
    ],
  }),

  ...group('Freight', {
    Dashboard: [
      { key: 'freight.dashboard', label: tk("Freight dashboard: plywood sheets, crates made and crating hours (today, week, month, year) and the charts by month"), levels: V, needs: ['crating'] },
      { key: 'freight.dashboard.filters', label: tk("Year and custom date filter"), levels: V, requires: 'freight.dashboard' },
      { key: 'freight.print', label: tk("Print button on the Freight page (dashboard, cost breakdowns list, insurance summary, crating tables)"), levels: V },
    ],
    'Shipment cost breakdowns': [
      { key: 'freight.breakdowns', label: tk("Shipment cost breakdowns: the list and each breakdown (Edit: create and change)"), levels: VE, db: true, hint: tk("Shows invoice totals, cargo values and margins.") },
      { key: 'freight.breakdowns.filters', label: tk("Search and filters"), levels: V, requires: 'freight.breakdowns' },
      { key: 'freight.breakdowns.copy', label: tk("Copy buttons on the results"), levels: V, requires: 'freight.breakdowns' },
      { key: 'freight.breakdowns.print', label: tk("Print a breakdown"), levels: V, requires: 'freight.breakdowns' },
      { key: 'freight.breakdowns.archive', label: tk("Archive and restore a breakdown"), levels: E, requires: 'freight.breakdowns', db: true },
      { key: 'freight.breakdowns.import', label: tk("Import old Freight Multitool data (CSV)"), levels: E, requires: 'freight.breakdowns', db: true },
      { key: 'freight.agents.add', label: tk("“Add new” in the shipping agent list"), levels: E, db: true },
      { key: 'freight.profit', label: tk("Profit and loss tab: invoice amounts against breakdown costs (summary, chart by day / week / month / quarter / year, compare with last year)"), levels: V, needs: ['freight.breakdowns'] },
    ],
    'Incoming freight': [
      { key: 'freight.incoming', label: tk("Incoming freight tab: shipments received from suppliers with their costs (Edit: add, change, archive)"), levels: VE, db: true },
      { key: 'freight.incoming.export', label: tk("Incoming freight: Export CSV"), levels: V, requires: 'freight.incoming' },
    ],
    'Quote requests and insurance': [
      { key: 'freight.quote', label: tk("Freight quote request email (View: write and copy; Edit: send it from the app)"), levels: VE, db: true, hint: tk("Uses the customer’s contact details only with “Customer contact details”.") },
      { key: 'freight.insurance', label: tk("Insurance summary (cargo and insured values by date range)"), levels: V, db: true },
      { key: 'freight.insurance.export', label: tk("Insurance summary: Export CSV"), levels: V, requires: 'freight.insurance' },
    ],
  }),

  ...group('Crating', {
    Data: [{ key: 'crating', label: tk("Crates on orders and the shop board (Edit: mark machines as crated, add, change and archive crates)"), levels: VE, db: true }],
    'Order page': [
      { key: 'crating.summary', label: tk("Crating summary"), levels: V, needs: ['crating'] },
      { key: 'crating.summary.copy', label: tk("Copy button (freight quote text)"), levels: V, requires: 'crating.summary' },
      { key: 'crating.ship_warning', label: tk("Warning when marking shipped with machines not crated"), levels: V, needs: ['crating'] },
      { key: 'crating.units', label: tk("Imperial / Metric switch"), levels: V },
      { key: 'crating.handoff', label: tk("Crating hand-off: who crates the order, what is still missing, and whether the shipping quote information was sent"), levels: V, needs: ['crating'], db: true },
      { key: 'crating.assign', label: tk("Choose who crates an order (they are told in the app)"), levels: E, requires: 'crating.handoff', db: true },
    ],
  }),

  ...group('Boards', {
    Pages: [
      { key: 'boards', label: tk("Boards page (boards you own or that are shared with you)"), levels: V, page: true, db: true, hint: tk("Sharing gives access to a board; the items below decide what can be seen and done on it.") },
      { key: 'boards.print', label: tk("Print button on the Boards page and on a board (the stages and cards shown)"), levels: V, requires: 'boards' },
      { key: 'boards.create', label: tk("Make your own boards (from scratch or a template)"), levels: E, requires: 'boards', db: true },
      { key: 'boards.show_archived', label: tk("“Show archived” boards"), levels: V, requires: 'boards' },
    ],
    'Board tools': [
      { key: 'boards.manage', label: tk("Board settings: name, colour, stages, labels (boards you manage)"), levels: E, requires: 'boards', db: true },
      { key: 'boards.share', label: tk("Share boards with people, groups, departments or everyone (boards you manage)"), levels: E, requires: 'boards', db: true },
      { key: 'boards.notifications', label: tk("Notification settings of a board (edit: boards you manage)"), levels: VE, requires: 'boards', db: true },
      { key: 'boards.archive', label: tk("Archive or restore a board (an archived board stays visible only to its creator and the people who could open it when it was archived)"), levels: E, requires: 'boards', db: true },
      { key: 'boards.close', label: tk("Close Board: close a board early (boards they manage; it leaves the Boards page and can only be viewed)"), levels: E, requires: 'boards', db: true },
      { key: 'boards.closed', label: tk("“Closed Boards” button: every closed board they can open (search and filters)"), levels: V, requires: 'boards' },
      { key: 'boards.reopen', label: tk("Reopen a closed board (with its own board number or a new one; boards they manage)"), levels: E, requires: 'boards.closed', db: true },
      { key: 'boards.stage.collapse', label: tk("Collapse and expand stages (remembered for each person)"), levels: V, requires: 'boards', db: true },
      { key: 'boards.stage.move_all', label: tk("Stage menu: “Move All Cards To…” / “Copy All Cards To…” another stage or board"), levels: E, requires: 'boards', db: true },
      { key: 'boards.stage.archive_all', label: tk("Stage menu: “Archive All Cards in This Stage” (machine cards stay)"), levels: E, requires: 'boards', needs: ['boards.card.archive'], db: true },
      { key: 'boards.labels.create', label: tk("Create a new label (name and colour) from inside a card"), levels: E, requires: 'boards.card.labels', db: true },
      { key: 'boards.filter', label: tk("Search and filter cards (label, person, mine)"), levels: V, requires: 'boards' },
    ],
    Cards: [
      { key: 'boards.card.create', label: tk("Add cards"), levels: E, requires: 'boards', db: true },
      { key: 'boards.card.open', label: tk("Open a card (its full details)"), levels: V, requires: 'boards' },
      { key: 'boards.card.print', label: tk("Print a card (its details, checklists and comments)"), levels: V, requires: 'boards.card.open' },
      { key: 'boards.card.navigate', label: tk("← Previous / Next → board and “Go to an order or board” at the top of a board"), levels: V, requires: 'boards' },
      { key: 'boards.card.complete', label: tk("Round “Mark Complete” circle before the card title (one click)"), levels: E, requires: 'boards', db: true },
      { key: 'boards.card.customer_label', label: tk("Customer label (“Company – State, Country”; edit: pick from the customer list or type it)"), levels: VE, requires: 'boards', db: true },
      { key: 'boards.card.move', label: tk("Move cards (drag between stages, up and down)"), levels: E, requires: 'boards', db: true },
      { key: 'boards.card.move_board', label: tk("Move a card to another board (boards they can work on; machine and service call cards stay on their board)"), levels: E, requires: 'boards.card.move', db: true },
      { key: 'boards.card.copy', label: tk("Copy a card to another stage or board (keeps checklists, labels, description and links)"), levels: E, requires: 'boards.card.open', db: true },
      { key: 'boards.card.edit', label: tk("Change a card’s title, description and due date"), levels: E, requires: 'boards.card.open', db: true },
      { key: 'boards.card.description', label: tk("Card description"), levels: V, requires: 'boards.card.open' },
      { key: 'boards.card.due', label: tk("Due dates (amber when close, red when late)"), levels: V, requires: 'boards' },
      { key: 'boards.card.labels', label: tk("Labels (edit: put labels on cards)"), levels: VE, requires: 'boards', db: true },
      { key: 'boards.card.assignees', label: tk("Who is on a card (edit: assign people)"), levels: VE, requires: 'boards', db: true },
      { key: 'boards.card.checklists', label: tk("Checklists, sub-tasks and % done (edit: add tasks and sub-tasks, mark them complete, remove them)"), levels: VE, requires: 'boards', db: true },
      { key: 'boards.task.assign', label: tk("Who does a task or sub-task (edit: assign or change, also while it is running)"), levels: VE, requires: 'boards.card.checklists', db: true },
      { key: 'boards.task.due', label: tk("Due date of a task or sub-task (edit: set or change)"), levels: VE, requires: 'boards.card.checklists', db: true },
      { key: 'boards.card.timing', label: tk("Start / Pause / Resume / Finish, active time, pause history and the usual time (edit: press the buttons)"), levels: VE, requires: 'boards.card.open', db: true },
      { key: 'boards.card.comments', label: tk("Comments (edit: write comments)"), levels: VE, requires: 'boards.card.open', db: true },
      { key: 'boards.card.history', label: tk("Card history"), levels: V, requires: 'boards.card.open', db: true },
      { key: 'boards.card.link', label: tk("Link to an order, customer or machine, or free text (edit: change the link)"), levels: VE, requires: 'boards', db: true },
      { key: 'boards.card.archive', label: tk("Archive a card"), levels: E, requires: 'boards.card.open', db: true },
      { key: 'boards.card.attachments', label: tk("Photos and files on cards (coming later)"), levels: V, requires: 'boards.card.open' },
    ],
    Production: [
      { key: 'production.create_board', label: tk("Create a production board for an order by hand (boards are made automatically when an order is confirmed)"), levels: E, requires: 'boards', db: true },
      { key: 'production.stage_times', label: tk("Time per stage on machine cards (when each stage started and finished)"), levels: V, requires: 'boards.card.open', db: true },
    ],
    Notifications: [
      { key: 'notifications.bell', label: tk("Notifications bell in the top bar (board messages)"), levels: V },
    ],
  }),
  ...group('Notice Board', {
    Page: [
      { key: 'notices', label: tk("Notice Board page (notices posted for them; unread dot and “New notices” count; can be their start page)"), levels: V, page: true, db: true },
      { key: 'notices.board.print', label: tk("Print button on the Notice Board (the notices shown)"), levels: V, requires: 'notices' },
      { key: 'notices.filters', label: tk("Filters (category, priority, for my department) and search"), levels: V, requires: 'notices' },
      { key: 'notices.archive', label: tk("Archive: expired and archived notices, with search"), levels: V, requires: 'notices', db: true },
      { key: 'notices.holidays', label: tk("Upcoming holidays and office closures panel"), levels: V, requires: 'notices' },
      { key: 'notices.whos_off', label: tk("Who’s off today panel (approved time off; the reason only with “Absence Calendar”)"), levels: V, requires: 'notices', db: true },
      { key: 'notices.banner', label: tk("Red banner at the top of every page for Urgent notices until they acknowledge them"), levels: V, requires: 'notices', needs: ['notices.acknowledge'] },
      { key: 'notices.closures', label: tk("Closure and delay alerts: the warning banner on every page (office closed, delayed opening) and their updates (everyone receives them by app, phone and email)"), levels: V, db: true },
      { key: 'notices.closures.post', label: tk("Post closure and delay alerts, post updates and end them (notifies everyone)"), levels: E, requires: 'notices', db: true },
    ],
    'Posting notices': [
      { key: 'notices.post.everyone', label: tk("Post to everyone, or to any mix of people, groups and departments"), levels: E, requires: 'notices', db: true },
      { key: 'notices.post.department', label: tk("Post to their own departments only"), levels: E, requires: 'notices', db: true },
      { key: 'notices.priority.important', label: tk("Post Important notices (also sent to the app and phones)"), levels: E, requires: 'notices', db: true },
      { key: 'notices.priority.urgent', label: tk("Post Urgent notices (also emailed, red banner, pinned at the top)"), levels: E, requires: 'notices', db: true },
      { key: 'notices.pin', label: tk("Pin their notices to the top of the board"), levels: E, requires: 'notices', db: true },
      { key: 'notices.manage', label: tk("Manage every notice: edit, pin, archive and restore anyone’s notice, see scheduled ones and who acknowledged"), levels: E, requires: 'notices', db: true },
    ],
    'On each notice': [
      { key: 'notices.acknowledge', label: tk("Acknowledge Important and Urgent notices"), levels: E, requires: 'notices', db: true },
      { key: 'notices.acks', label: tk("See who has and hasn’t acknowledged their own notices (edit: Remind the Rest)"), levels: VE, requires: 'notices', db: true },
      { key: 'notices.react', label: tk("Add reactions"), levels: E, requires: 'notices', db: true },
      { key: 'notices.comments', label: tk("Comments under notices (edit: write comments)"), levels: VE, requires: 'notices', db: true },
      { key: 'notices.print', label: tk("Print a notice on one page with the company letterhead"), levels: V, requires: 'notices' },
    ],
    Events: [
      { key: 'notices.events', label: tk("Upcoming events panel: events meant for them, with the countdown (also in the Calendar for people who can open it)"), levels: V, requires: 'notices', db: true },
      { key: 'notices.events.post', label: tk("Post events (add, edit and archive their own events; choose who they are for; see who answered)"), levels: E, requires: 'notices.events', db: true },
      { key: 'notices.events.rsvp', label: tk("Answer events: Going, Not going or Maybe"), levels: E, requires: 'notices.events', db: true },
      { key: 'notices.events.calendar', label: tk("Add to My Calendar (Apple, Google or Outlook)"), levels: V, requires: 'notices.events' },
    ],
    'My notes': [
      { key: 'notices.my_notes', label: tk("My notes: private sticky notes with checklists and reminders, archive and restore (nobody else can see them, admins included)"), levels: E, requires: 'notices', db: true },
    ],
  }),

  ...group('Service / Training', {
    Page: [
      { key: 'service', label: tk("Service / Training page (on-site training, commissioning and service calls)"), levels: V, page: true, db: true },
      { key: 'service.print', label: tk("Print button on the Service / Training pages (lists, day log, by machine)"), levels: V, requires: 'service' },
      { key: 'service.filters', label: tk("Search and “Only mine”"), levels: V, requires: 'service' },
      { key: 'service.list.in_progress', label: tk("List: in progress"), levels: V, requires: 'service' },
      { key: 'service.list.upcoming', label: tk("List: upcoming"), levels: V, requires: 'service' },
      { key: 'service.list.completed', label: tk("List: completed"), levels: V, requires: 'service' },
      { key: 'service.summary', label: tk("Summary boxes: travel, on-site training and service call days so far and scheduled, with dates"), levels: V, requires: 'service', db: true },
      { key: 'service.training.done', label: tk("Mark Training as Done on training orders (also completes the chosen board cards and the order’s calendar entries)"), levels: E, requires: 'service', db: true },
    ],
    'Service log': [
      { key: 'service.log', label: tk("Day log and timeline (edit: add and change days, machines worked on, notes)"), levels: VE, requires: 'service', db: true },
      { key: 'service.log.by_machine', label: tk("Notes per machine across all days"), levels: V, requires: 'service.log' },
      { key: 'service.log.archive', label: tk("Archive a day"), levels: E, requires: 'service.log', db: true },
      { key: 'service.photos', label: tk("Photos (available in a future update)"), levels: V, requires: 'service.log' },
    ],
    'Service calls': [
      { key: 'service.calls', label: tk("Service calls (list on the Service page, call pages, details on the Service Calls board)"), levels: V, requires: 'service', db: true, hint: tk("Moving cards on the board also needs the Boards permissions (the “Technician” preset has them).") },
      { key: 'service.calls.create', label: tk("Create a service call"), levels: E, requires: 'service.calls', db: true },
      { key: 'service.calls.edit', label: tk("Change a call’s customer, machines, technician and planned dates"), levels: E, requires: 'service.calls', db: true },
    ],
    'Commissioning certificate and service report': [
      { key: 'service.certificate', label: tk("See certificates and service reports"), levels: V, requires: 'service', db: true },
      { key: 'service.certificate.create', label: tk("Create a certificate (order) or service report (service call)"), levels: E, requires: 'service.certificate', db: true },
      { key: 'service.certificate.edit_text', label: tk("Change the text of one certificate (not the template)"), levels: E, requires: 'service.certificate', db: true },
      { key: 'service.certificate.machines', label: tk("Remove, restore and add machine rows"), levels: E, requires: 'service.certificate', db: true },
      { key: 'service.certificate.details', label: tk("Change start and end dates, site address, technician name"), levels: VE, requires: 'service.certificate', db: true },
      { key: 'service.certificate.sign', label: tk("Sign (technician and customer, on screen)"), levels: E, requires: 'service.certificate', db: true },
      { key: 'service.certificate.pdf', label: tk("Download PDF"), levels: V, requires: 'service.certificate' },
      { key: 'service.certificate.email', label: tk("Email the signed certificate (preview, Send, Resend, sent history)"), levels: VE, requires: 'service.certificate', db: true },
      { key: 'service.certificate.correct', label: tk("Create a corrected version of a signed certificate"), levels: E, requires: 'service.certificate', db: true },
    ],
  }),

  ...group('Calendar', {
    Calendar: [
      { key: 'service.calendar', label: tk("Calendar page and their own entries (add, change, archive; private or shared with the Service / Training team)"), levels: V, db: true, hint: tk("Separate from Service / Training: without that page people only see their own entries, entries shared with them and company events.") },
      { key: 'service.calendar.print', label: tk("Print the calendar (the day, week or month shown)"), levels: V, requires: 'service.calendar' },
      { key: 'service.calendar.navigate', label: tk("Month and week view, earlier and later dates"), levels: V, requires: 'service.calendar' },
      { key: 'service.calendar.share', label: tk("Share their entries with chosen people, groups and departments"), levels: E, requires: 'service.calendar', db: true },
      { key: 'service.calendar.all', label: tk("See other people’s calendars (choose one or everyone; private entries are never shown)"), levels: V, requires: 'service.calendar', db: true },
      { key: 'service.calendar.manage', label: tk("Add entries to other people’s calendars and change shared entries they can see (never private ones)"), levels: E, requires: 'service.calendar', db: true },
      { key: 'service.calendar.import', label: tk("Link their own phone calendar (Calendar Connection: paste, replace, remove the link, Refresh Now)"), levels: E, requires: 'service.calendar', db: true },
      { key: 'service.calendar.classify', label: tk("Set the type of entries from phones and link them to a customer or order"), levels: E, requires: 'service.calendar', db: true },
      { key: 'service.calendar.sync', label: tk("Phone calendar link (show, copy, make a new one)"), levels: E, requires: 'service.calendar', db: true },
    ],
  }),
  ...group('Timesheets', {
    'Weekly hours': [
      { key: 'timesheets', label: tk("Timesheets page: every employee’s weekly hours, overtime, banked hours and approval status"), levels: V, page: true, db: true },
      { key: 'timesheets.print', label: tk("Print button on the Timesheets pages (weekly hours, absence calendar, reports, one employee’s week)"), levels: V, requires: 'timesheets' },
      { key: 'timesheets.fill_all', label: tk("Fill Weekday Hours for Everyone (the chosen week; skips time off, days off, approved weeks and days that already have hours)"), levels: E, requires: 'timesheets.enter', db: true },
      { key: 'timesheets.enter', label: tk("Enter and change hours (per day or per week), bank hours, mark imported hours as reviewed (employees never enter their own)"), levels: E, requires: 'timesheets', db: true },
      { key: 'timesheets.approve', label: tk("Approve and lock weeks of every department (department managers can always approve their own departments)"), levels: E, requires: 'timesheets', db: true },
      { key: 'timesheets.unlock', label: tk("Unlock an approved week (with a reason)"), levels: E, requires: 'timesheets', db: true },
      { key: 'timesheets.history', label: tk("Week history: who entered, approved, unlocked, and the overtime or regular pay choices"), levels: V, requires: 'timesheets' },
      { key: 'timesheets.adjust', label: tk("Change an employee’s vacation and sick day entitlement and correct banked hour balances (with a reason; history kept)"), levels: E, db: true },
    ],
    'My timesheet': [
      { key: 'timesheets.mine', label: tk("My Timesheet: their own hours, banked hours, vacation and sick days (read only)"), levels: V, page: true, db: true },
      { key: 'timesheets.mine.print', label: tk("Print their own timesheet"), levels: V, requires: 'timesheets.mine' },
    ],
    'Time off': [
      { key: 'timesheets.time_off', label: tk("Time Off page (their own requests, and requests they decide)"), levels: V, page: true },
      { key: 'timesheets.time_off.print', label: tk("Print button on the Time Off page"), levels: V, requires: 'timesheets.time_off' },
      { key: 'timesheets.time_off.request', label: tk("Request time off for themselves (vacation, sick, banked time, unpaid)"), levels: E, requires: 'timesheets.time_off', db: true },
      { key: 'timesheets.time_off.manage', label: tk("See every request (edit: approve or decline for every department; department managers always decide their own departments)"), levels: VE, requires: 'timesheets.time_off', db: true },
      { key: 'timesheets.absences', label: tk("Absence Calendar (managers see their departments; time off managers and approvers see everyone)"), levels: V, db: true },
    ],
    Reports: [
      { key: 'timesheets.reports', label: tk("Timesheet reports: hours per employee per week or month, overtime, banked hours, leave taken (all years, imported ones too)"), levels: V, db: true },
      { key: 'timesheets.reports.export', label: tk("Export reports as CSV for payroll"), levels: V, requires: 'timesheets.reports' },
    ],
    'Pay and labour cost': [
      { key: 'payroll.pay', label: tk("View pay rates and labour cost (edit: change pay rates). Owners and payroll only."), levels: VE, db: true, hint: tk("Pay rates and costs are never shown without this, even to people who enter hours.") },
      { key: 'timesheets.labour_cost', label: tk("Labour cost: cost per hour, day, week, month and year per employee, department totals, years compared, charts"), levels: V, needs: ['payroll.pay'] },
      { key: 'timesheets.labour_cost.print', label: tk("Print the labour cost report"), levels: V, requires: 'timesheets.labour_cost' },
    ],
  }),

  ...group('Chat', {
    Page: [
      { key: 'chat', label: tk("Chat page (read the conversations they belong to; unread count in the menu)"), levels: V, page: true, db: true },
      { key: 'chat.send', label: tk("Write in direct messages and group chats (also reply, react, edit and delete own messages)"), levels: E, requires: 'chat', db: true },
      { key: 'chat.direct', label: tk("Start direct messages"), levels: E, requires: 'chat', db: true },
      { key: 'chat.groups', label: tk("Start group chats (name, people; add, remove, rename, leave)"), levels: E, requires: 'chat', db: true },
      { key: 'chat.channels.post', label: tk("Write in department, group and other channels"), levels: E, requires: 'chat', db: true },
      { key: 'chat.pin', label: tk("Pin and unpin messages"), levels: E, requires: 'chat', db: true },
      { key: 'chat.unsend', label: tk("Unsend their own message within 30 seconds (removed for everyone, no trace)"), levels: E, requires: 'chat', db: true },
      { key: 'chat.list_actions', label: tk("Their own conversation list: Archive, Hide, Clear chat, Delete for me, Mark read / unread (swipe on a phone, buttons on a computer)"), levels: E, requires: 'chat', db: true },
      { key: 'chat.time_off', label: tk("Notice above the message box when someone in the conversation is on approved time off"), levels: V, requires: 'chat', db: true },
      { key: 'chat.search', label: tk("Search across their conversations"), levels: V, requires: 'chat', db: true },
      { key: 'chat.presence', label: tk("See who is online or away"), levels: V, requires: 'chat' },
      { key: 'chat.members', label: tk("Conversation details (who started it and when, members, shared links, pinned messages, notifications for the conversation)"), levels: V, requires: 'chat' },
      { key: 'chat.attachments', label: tk("Photos and files in chat (available in a future update)"), levels: V, requires: 'chat' },
    ],
  }),

  ...group('Reports', {
    'Department delays': [
      { key: 'reports.department_delays', label: tk("Department delays report (on-time %, days late per department)"), levels: V, page: true, db: true },
      { key: 'reports.department_delays.print', label: tk("Print the department delays report"), levels: V, requires: 'reports.department_delays' },
      { key: 'reports.department_delays.summary', label: tk("Summary boxes: on time %, average days early, average days late, worst department this month"), levels: V, requires: 'reports.department_delays' },
      { key: 'reports.department_delays.by_month', label: tk("Table: by month"), levels: V, requires: 'reports.department_delays' },
      { key: 'reports.department_delays.period', label: tk("Choose the period (last 3 / 6 / 12 months, all time)"), levels: V, requires: 'reports.department_delays' },
    ],
    'Build times': [
      { key: 'reports.build_times', label: tk("Build times report (average time per machine type and step)"), levels: V, page: true, db: true },
      { key: 'reports.build_times.print', label: tk("Print the build times report"), levels: V, requires: 'reports.build_times' },
      { key: 'reports.build_times.tasks', label: tk("Table: time per build checklist task"), levels: V, requires: 'reports.build_times', db: true },
      { key: 'reports.build_times.filters', label: tk("Machine type and period filters"), levels: V, requires: 'reports.build_times' },
      { key: 'reports.build_times.trend', label: tk("Table: trend by month"), levels: V, requires: 'reports.build_times' },
    ],
    'Freight: crating tables': [

      { key: 'reports.crating', label: tk("Freight page: Crating Tables (the former Crating Report)"), levels: V, needs: ['crating'], page: true },
      { key: 'reports.crating.filters', label: tk("Date and machine type filters"), levels: V, requires: 'reports.crating' },
      { key: 'reports.crating.by_type', label: tk("Table: by machine type"), levels: V, requires: 'reports.crating' },
      { key: 'reports.crating.every_crate', label: tk("Table: every crate"), levels: V, requires: 'reports.crating' },
      { key: 'reports.crating.export_csv', label: tk("Export CSV (every crate)"), levels: V, requires: 'reports.crating.every_crate' },
      { key: 'reports.crating.export_summary', label: tk("Summary CSV"), levels: V, requires: 'reports.crating.by_type' },
    ],
  }),

  ...group('Automations', {
    Automations: [
      {
        key: 'automations',
        label: tk("Use automations: create rules (When … If … Then …) for the things they have access to; view: see automations shared with them and board automations"),
        levels: VE,
        db: true,
        defaultOn: true,
        hint: tk("On for everyone by default. An automation always runs with its owner’s permissions, checked on every run."),
      },
      { key: 'automations.share', label: tk("Share their automations with people, groups or departments (view only or allowed to edit)"), levels: E, requires: 'automations', db: true },
    ],
  }),

  ...group('Agent', {
    Page: [{ key: 'agent', label: tk("Agent page (available in a future update)"), levels: V, page: true }],
  }),

  ...group('Settings', {
    Page: [
      { key: 'settings', label: tk("Settings page"), levels: V, page: true },
      { key: 'settings.account', label: tk("Your account (email, role, departments)"), levels: V, requires: 'settings' },
      { key: 'settings.language', label: tk("Choose their own language for the app (follows them to every device)"), levels: E, requires: 'settings', db: true, defaultOn: true },
      { key: 'settings.theme', label: tk("Choose their theme: Light, Dark or System"), levels: E, requires: 'settings', db: true },
      { key: 'settings.search', label: tk("Find a setting: search box at the top of Settings and Admin pages (only finds what they may open)"), levels: V },
      { key: 'settings.start_page', label: tk("Choose their own start page (the page that opens after signing in)"), levels: E, requires: 'settings', db: true },
      { key: 'settings.units', label: tk("Units for crate sizes"), levels: V, requires: 'settings', needs: ['crating.units'] },
      { key: 'settings.notifications', label: tk("Desktop notifications on this computer (turn on or off)"), levels: V, requires: 'settings', db: true },
      { key: 'settings.notification_channels', label: tk("Notifications page: in the app, phone push, email (each time or daily summary) and desktop, per type (edit: change them)"), levels: VE, requires: 'settings', db: true },
      { key: 'settings.push', label: tk("Phone notifications on their own phone or computer (enable, test, disable)"), levels: E, requires: 'settings', db: true },
      { key: 'settings.quiet_hours', label: tk("Quiet hours: no phone notifications at night (edit their own)"), levels: E, requires: 'settings', db: true },
      { key: 'settings.chat_status', label: tk("Hide their online / away status in chat"), levels: E, requires: 'settings', db: true },
      { key: 'settings.chat_swipe', label: tk("Choose what swiping a conversation left or right does in chat"), levels: E, requires: 'settings', needs: ['chat.list_actions'], db: true },
      { key: 'settings.daily_summary', label: tk("Daily summary: “Today’s Agenda” and “What I Did Today” (turn on, time, what is included, how it is sent)"), levels: E, requires: 'settings', db: true, hint: tk("A summary only ever holds what that person is allowed to see.") },
      { key: 'settings.mailbox', label: tk("Email: connect their own sending mailbox (emails they send come from their own address; password stored encrypted)"), levels: VE, requires: 'settings', db: true, hint: tk("Without one, their emails come from the office address with their name and Reply-To set to their email.") },
      { key: 'settings.change_email', label: tk("Change their own sign-in email (confirmed at the old and the new address; admins are told)"), levels: E, requires: 'settings', db: true },
      { key: 'settings.signature', label: tk("My signature: upload a scanned signature and sign with it (“Use my saved signature”); only they can see or use it (edit: upload, replace, remove)"), levels: VE, requires: 'settings', db: true },
    ],
    Alerts: [
      { key: 'alerts.bell', label: tk("Alerts bell in the top bar"), levels: V, hint: tk("Payment alerts also need “payments”.") },
      { key: 'alerts.popups', label: tk("Pop-ups and desktop notifications for red alerts"), levels: V, requires: 'alerts.bell' },
      { key: 'alerts.snooze', label: tk("Snooze and dismiss alerts"), levels: E, requires: 'alerts.bell' },
    ],
  }),

  ...group('Admin', {
    Pages: [
      { key: 'admin.users', label: tk("Users: add, rename, remove, departments (only full admins change permissions or make admins)"), levels: E, db: true },
      { key: 'admin.departments', label: tk("Departments (and each department’s manager, who approves timesheets and time off)"), levels: E, db: true },
      { key: 'admin.employees', label: tk("Employee setup: pay type, start date, payroll department, hours per day (pay rates also need “View pay and labour cost”)"), levels: E, db: true },
      { key: 'admin.payroll', label: tk("Payroll settings: overtime threshold, banked overtime, vacation and sick day rules, PEI minimums"), levels: E, db: true },
      { key: 'admin.timesheets', label: tk("Timesheets: employees without a login, import of old timesheet sheets, import layouts"), levels: E, db: true },
      { key: 'admin.machine_types', label: tk("Machine types"), levels: E, db: true },
      { key: 'admin.dropdowns', label: tk("Dropdown lists"), levels: E, db: true },
      { key: 'admin.checklists', label: tk("Checklist templates (edit checklist templates)"), levels: E, db: true },
      { key: 'admin.chat', label: tk("Chat channels (department, group and other channels; never private chats)"), levels: E, db: true },
      { key: 'admin.templates', label: tk("Templates (commissioning certificate and service report text)"), levels: E, db: true },
      { key: 'admin.calendar', label: tk("Calendar: the Service / Training team that service and training entries are shared with"), levels: E, db: true },
      { key: 'admin.email_templates', label: tk("Email templates (default subject and CC of the commissioning certificate and service report emails)"), levels: E, db: true },
      { key: 'admin.automations', label: tk("Manage all automations: see, pause and edit everyone’s automations, limits, templates, automations of removed people"), levels: E, db: true },
      { key: 'admin.dashboards', label: tk("Dashboard templates: build templates, give them to people or departments as their starting dashboards, lock them"), levels: E, db: true },
      { key: 'admin.dashboard_charts', label: tk("Dashboard charts: green / amber / red targets of the gauges and the charts a new dashboard starts with"), levels: E, db: true },
      { key: 'admin.freight', label: tk("Freight settings (broker fee, hourly and plywood rates, insurance rule, margin buttons, pick-up locations, shipping agents)"), levels: E, db: true },
      { key: 'admin.ce', label: tk("Declaration of Conformity: CE template and settings (EC or EU type, authorised person, signer, email text) and the register of all declarations"), levels: E, db: true },
      { key: 'admin.build_checklists', label: tk("Build checklists (parts and tasks per machine type and step)"), levels: E, db: true },
      { key: 'admin.production', label: tk("Production boards (default stages and their departments, office, colour)"), levels: E, db: true },
      { key: 'admin.production_assignments', label: tk("Production assignments: default people per production stage (optionally per machine type or department)"), levels: VE, db: true },
      { key: 'admin.stages', label: tk("Stage names (rename what people see, for example “Ready / testing”)"), levels: E, db: true },
      { key: 'admin.order_defaults', label: tk("Order defaults (currency, voltage, crate, payment due days)"), levels: E, db: true },
      { key: 'admin.email', label: tk("Email setup (mailbox check, test email, automatic sending, daily summary time)"), levels: E, db: true },
      { key: 'admin.email_log', label: tk("Email log (edit: Resend)"), levels: VE, db: true },
      { key: 'admin.email_log.print', label: tk("Print the email log"), levels: V, requires: 'admin.email_log' },
      { key: 'admin.groups', label: tk("Groups of people (for example Procurement, Techs) for sharing and notifications"), levels: E, db: true },
      { key: 'admin.board_templates', label: tk("Board templates (save a board as a template, edit, archive)"), levels: E, db: true },
      { key: 'admin.scheduling', label: tk("Scheduling (working days, buffer, machines one after another)"), levels: E, db: true },
      { key: 'admin.holidays', label: tk("Company holidays (PEI statutory holidays, company holidays, office closures; used for ship dates)"), levels: E, db: true },
      { key: 'admin.records', label: tk("Orders, customers & machines: edit any field, archive"), levels: E, db: true },
      { key: 'admin.serials', label: tk("Serial numbers"), levels: E, db: true },
      { key: 'admin.board', label: tk("Shop queue repair"), levels: E, db: true },
      { key: 'admin.alerts', label: tk("Alert settings"), levels: E, db: true },
      { key: 'admin.company', label: tk("Company details"), levels: E, db: true },
      { key: 'admin.import', label: tk("Import & backup"), levels: E, db: true },
      { key: 'admin.archive', label: tk("Archive: bring back, delete for good"), levels: E, db: true },
      { key: 'admin.status', label: tk("System status: health of the database, email, push, scheduled jobs and calendar sync; storage used, active users, recent errors"), levels: E, db: true },
      { key: 'admin.activity', label: tk("Activity: every change, who and when"), levels: V, db: true },
      { key: 'admin.activity.print', label: tk("Print the activity list"), levels: V, requires: 'admin.activity' },
    ],
  }),
]

export const CATALOG_BY_KEY = new Map(CATALOG.map((i) => [i.key, i]))

/** Permissions everyone starts with (added to the starting permissions of new people). */
export const DEFAULT_PERMS: Record<string, Level> = Object.fromEntries(
  CATALOG.filter((i) => i.defaultOn).map((i) => [i.key, i.levels.includes('edit') ? 'edit' : 'view']),
)

/** Every Admin page key (the Admin menu shows when any of them is allowed). */
/** Any of these opens the Freight page (each tab has its own key). */
export const FREIGHT_KEYS = ['freight.dashboard', 'freight.breakdowns', 'freight.insurance', 'reports.crating', 'freight.quote', 'freight.incoming']

/** Any of these opens the Timesheets page (each tab has its own key). */
export const TIMESHEET_KEYS = ['timesheets', 'timesheets.absences', 'timesheets.reports', 'timesheets.labour_cost']

export const ADMIN_KEYS = CATALOG.filter((i) => i.group === 'Admin').map((i) => i.key)
