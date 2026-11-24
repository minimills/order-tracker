import type { IconName } from '../components/Icon'
import { tr } from '../i18n'

/** Every Admin page: shown on the Admin home, in the breadcrumbs and in the settings search. */
export type AdminPage = { to: string; permission: string; icon: IconName; title: string; text: string }

/** View-only admin pages (every other admin page needs "edit"). */
export const ADMIN_VIEW_ONLY = new Set(['admin.activity', 'admin.email_log'])

export const ADMIN_PAGES: AdminPage[] = [
  { to: '/admin/users', permission: 'admin.users', icon: 'user' as const, get title() {
    return tr("Users")
  }, get text() {
    return tr("Who can sign in, their departments, and what each person can see and do.")
  } },
  { to: '/admin/departments', permission: 'admin.departments', icon: 'factory' as const, get title() {
    return tr("Departments")
  }, get text() {
    return tr("Create, rename, reorder and archive departments.")
  } },
  { to: '/admin/timesheets', permission: 'admin.timesheets', icon: 'timer' as const, get title() {
    return tr("Timesheets")
  }, get text() {
    return tr("Employees, people without a login, and import of the old timesheet sheets (Excel or CSV).")
  } },
  { to: '/admin/payroll', permission: 'admin.payroll', icon: 'money' as const, get title() {
    return tr("Payroll Settings")
  }, get text() {
    return tr("Overtime threshold, banked overtime, vacation and sick day rules, statutory holiday pay, PEI minimums.")
  } },
  { to: '/admin/machine-types', permission: 'admin.machine_types', icon: 'cog' as const, get title() {
    return tr("Machine Types")
  }, get text() {
    return tr("Names, codes and next serial numbers.")
  } },
  { to: '/admin/dropdowns', permission: 'admin.dropdowns', icon: 'dropdown' as const, get title() {
    return tr("Dropdown Lists")
  }, get text() {
    return tr("Voltage, delivery equipment, freight and payment types, notice categories.")
  } },
  { to: '/admin/stages', permission: 'admin.stages', icon: 'tag' as const, get title() {
    return tr("Stage Names")
  }, get text() {
    return tr("Rename what people see for each stage, for example “Ready / testing”.")
  } },
  { to: '/admin/checklists', permission: 'admin.checklists', icon: 'checklist' as const, get title() {
    return tr("Checklists")
  }, get text() {
    return tr("Final check templates: general items for every machine, plus extras per machine type.")
  } },
  { to: '/admin/build-checklists', permission: 'admin.build_checklists', icon: 'checklist' as const, get title() {
    return tr("Build Checklists")
  }, get text() {
    return tr("Parts and tasks per machine type for Fabrication, Sandblasting, Powder coating and Assembly.")
  } },
  { to: '/admin/production', permission: 'admin.production', icon: 'boards' as const, get title() {
    return tr("Production")
  }, get text() {
    return tr("Stages every new production board starts with, their departments, and board settings.")
  } },
  { to: '/admin/production-assignments', permission: 'admin.production_assignments', icon: 'users' as const, get title() {
    return tr("Production Assignments")
  }, get text() {
    return tr("Default people per production stage (optionally per machine type or department), put on cards and tasks automatically.")
  } },
  { to: '/admin/templates', permission: 'admin.templates', icon: 'template' as const, get title() {
    return tr("Templates")
  }, get text() {
    return tr("The commissioning certificate text, with placeholders such as {customer_name}.")
  } },
  { to: '/admin/ce', permission: 'admin.ce', icon: 'template' as const, get title() {
    return tr("Declaration of Conformity")
  }, get text() {
    return tr("CE / EU declaration template, settings and the register of issued declarations.")
  } },
  { to: '/admin/chat', permission: 'admin.chat', icon: 'chat' as const, get title() {
    return tr("Chat Channels")
  }, get text() {
    return tr("Department, group and other channels: rename, archive, members. Private chats are not shown.")
  } },
  { to: '/admin/holidays', permission: 'admin.holidays', icon: 'calendar' as const, get title() {
    return tr("Company Holidays")
  }, get text() {
    return tr("PEI statutory holidays (imported every year), company holidays and office closures. Used for ship dates.")
  } },
  { to: '/admin/email', permission: 'admin.email', icon: 'inbox' as const, get title() {
    return tr("Email")
  }, get text() {
    return tr("Mailbox set-up, test email, automatic sending and phone notification keys.")
  } },
  { to: '/admin/dashboard-charts', permission: 'admin.dashboard_charts', icon: 'pulse' as const, get title() {
    return tr("Dashboard Charts")
  }, get text() {
    return tr("Green, amber and red targets for the gauges, and the charts a new dashboard starts with.")
  } },
  { to: '/admin/dashboard-templates', permission: 'admin.dashboards', icon: 'home' as const, get title() {
    return tr("Dashboard Templates")
  }, get text() {
    return tr("Starting dashboards for people or departments, and locked dashboards.")
  } },
  { to: '/admin/freight', permission: 'admin.freight', icon: 'truck' as const, get title() {
    return tr("Freight Settings")
  }, get text() {
    return tr("Broker fee, handling rates, insurance rule, margin buttons, pick-up locations and shipping agents.")
  } },
  { to: '/admin/calendar', permission: 'admin.calendar', icon: 'calendar' as const, get title() {
    return tr("Calendar")
  }, get text() {
    return tr("The Service / Training team that service and training calendar entries are shared with.")
  } },
  { to: '/admin/email-templates', permission: 'admin.email_templates', icon: 'template' as const, get title() {
    return tr("Email Templates")
  }, get text() {
    return tr("Default subject and CC of the commissioning certificate and service report emails.")
  } },
  { to: '/admin/email-log', permission: 'admin.email_log', icon: 'list' as const, get title() {
    return tr("Email Log")
  }, get text() {
    return tr("Every email sent, with Resend.")
  } },
  { to: '/admin/automations', permission: 'admin.automations', icon: 'bolt' as const, get title() {
    return tr("Automations")
  }, get text() {
    return tr("Everyone’s automations: pause or edit, limits, templates, and automations of people who were removed.")
  } },
  { to: '/admin/groups', permission: 'admin.groups', icon: 'users' as const, get title() {
    return tr("Groups")
  }, get text() {
    return tr("Groups of people (for example Procurement, Techs) for sharing boards and notifications.")
  } },
  { to: '/admin/board-templates', permission: 'admin.board_templates', icon: 'template' as const, get title() {
    return tr("Board Templates")
  }, get text() {
    return tr("Stages, labels and checklists new boards can start with.")
  } },
  { to: '/admin/order-defaults', permission: 'admin.order_defaults', icon: 'receipt' as const, get title() {
    return tr("Order Defaults")
  }, get text() {
    return tr("Currency, voltage, crate and payment due days for new orders.")
  } },
  { to: '/admin/scheduling', permission: 'admin.scheduling', icon: 'calendar' as const, get title() {
    return tr("Scheduling")
  }, get text() {
    return tr("Working days, buffer, and how machines are built. Holidays are in Company Holidays.")
  } },
  { to: '/admin/records', permission: 'admin.records', icon: 'records' as const, get title() {
    return tr("Orders, Customers and Machines")
  }, get text() {
    return tr("Edit any field, or archive a record.")
  } },
  { to: '/admin/serials', permission: 'admin.serials', icon: 'hash' as const, get title() {
    return tr("Serial Numbers")
  }, get text() {
    return tr("Correct a single serial number, or renumber a machine type.")
  } },
  { to: '/admin/board', permission: 'admin.board', icon: 'queue' as const, get title() {
    return tr("Shop Queue")
  }, get text() {
    return tr("Move an order to a set place in the queue, or renumber the whole queue.")
  } },
  { to: '/admin/alerts', permission: 'admin.alerts', icon: 'bell' as const, get title() {
    return tr("Alert Settings")
  }, get text() {
    return tr("How many days in advance alerts appear.")
  } },
  { to: '/admin/company', permission: 'admin.company', icon: 'building' as const, get title() {
    return tr("Company Details")
  }, get text() {
    return tr("Name, address and logo for printouts.")
  } },
  { to: '/admin/import', permission: 'admin.import', icon: 'download' as const, get title() {
    return tr("Import and Backup")
  }, get text() {
    return tr("Import orders from a spreadsheet, or download a full backup.")
  } },
  { to: '/admin/archive', permission: 'admin.archive', icon: 'archive' as const, get title() {
    return tr("Archive")
  }, get text() {
    return tr("Restore archived records, or delete them permanently.")
  } },
  { to: '/admin/status', permission: 'admin.status', icon: 'pulse' as const, get title() {
    return tr("System Status")
  }, get text() {
    return tr("Health of the database, email, phone push, scheduled jobs and calendar sync; storage used and recent errors.")
  } },
  { to: '/admin/activity', permission: 'admin.activity', icon: 'history' as const, get title() {
    return tr("Activity")
  }, get text() {
    return tr("Every change: who made it, what changed and when.")
  } },
]
