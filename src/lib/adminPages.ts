import type { IconName } from '../components/Icon'

/** Every Admin page: shown on the Admin home, in the breadcrumbs and in the settings search. */
export type AdminPage = { to: string; permission: string; icon: IconName; title: string; text: string }

/** View-only admin pages (every other admin page needs "edit"). */
export const ADMIN_VIEW_ONLY = new Set(['admin.activity', 'admin.email_log'])

export const ADMIN_PAGES: AdminPage[] = [
  { to: '/admin/users', permission: 'admin.users', icon: 'user' as const, title: 'Users', text: 'Who can sign in, their departments, and what each person can see and do.' },
  { to: '/admin/departments', permission: 'admin.departments', icon: 'factory' as const, title: 'Departments', text: 'Create, rename, reorder and archive departments.' },
  { to: '/admin/machine-types', permission: 'admin.machine_types', icon: 'cog' as const, title: 'Machine Types', text: 'Names, codes and next serial numbers.' },
  { to: '/admin/dropdowns', permission: 'admin.dropdowns', icon: 'dropdown' as const, title: 'Dropdown Lists', text: 'Voltage, delivery equipment, freight and payment types, notice categories.' },
  { to: '/admin/stages', permission: 'admin.stages', icon: 'tag' as const, title: 'Stage Names', text: 'Rename what people see for each stage, for example “Ready / testing”.' },
  { to: '/admin/checklists', permission: 'admin.checklists', icon: 'checklist' as const, title: 'Checklists', text: 'Final check templates: general items for every machine, plus extras per machine type.' },
  { to: '/admin/build-checklists', permission: 'admin.build_checklists', icon: 'checklist' as const, title: 'Build Checklists', text: 'Parts and tasks per machine type for Fabrication, Sandblasting, Powder coating and Assembly.' },
  { to: '/admin/production', permission: 'admin.production', icon: 'boards' as const, title: 'Production', text: 'Stages every new production board starts with, their departments, and board settings.' },
  { to: '/admin/templates', permission: 'admin.templates', icon: 'template' as const, title: 'Templates', text: 'The commissioning certificate text, with placeholders such as {customer_name}.' },
  { to: '/admin/ce', permission: 'admin.ce', icon: 'template' as const, title: 'Declaration of Conformity', text: 'CE / EU declaration template, settings and the register of issued declarations.' },
  { to: '/admin/chat', permission: 'admin.chat', icon: 'chat' as const, title: 'Chat Channels', text: 'Department, group and other channels: rename, archive, members. Private chats are not shown.' },
  { to: '/admin/holidays', permission: 'admin.holidays', icon: 'calendar' as const, title: 'Company Holidays', text: 'PEI statutory holidays (imported every year), company holidays and office closures. Used for ship dates.' },
  { to: '/admin/email', permission: 'admin.email', icon: 'inbox' as const, title: 'Email', text: 'Mailbox set-up, test email, automatic sending and phone notification keys.' },
  { to: '/admin/email-templates', permission: 'admin.email_templates', icon: 'template' as const, title: 'Email Templates', text: 'Default subject and CC of the commissioning certificate and service report emails.' },
  { to: '/admin/email-log', permission: 'admin.email_log', icon: 'list' as const, title: 'Email Log', text: 'Every email sent, with Resend.' },
  { to: '/admin/groups', permission: 'admin.groups', icon: 'users' as const, title: 'Groups', text: 'Groups of people (for example Procurement, Techs) for sharing boards and notifications.' },
  { to: '/admin/board-templates', permission: 'admin.board_templates', icon: 'template' as const, title: 'Board Templates', text: 'Stages, labels and checklists new boards can start with.' },
  { to: '/admin/order-defaults', permission: 'admin.order_defaults', icon: 'receipt' as const, title: 'Order Defaults', text: 'Currency, voltage, crate and payment due days for new orders.' },
  { to: '/admin/scheduling', permission: 'admin.scheduling', icon: 'calendar' as const, title: 'Scheduling', text: 'Working days, buffer, and how machines are built. Holidays are in Company Holidays.' },
  { to: '/admin/records', permission: 'admin.records', icon: 'records' as const, title: 'Orders, Customers and Machines', text: 'Edit any field, or archive a record.' },
  { to: '/admin/serials', permission: 'admin.serials', icon: 'hash' as const, title: 'Serial Numbers', text: 'Correct a single serial number, or renumber a machine type.' },
  { to: '/admin/board', permission: 'admin.board', icon: 'queue' as const, title: 'Shop Queue', text: 'Move an order to a set place in the queue, or renumber the whole queue.' },
  { to: '/admin/alerts', permission: 'admin.alerts', icon: 'bell' as const, title: 'Alert Settings', text: 'How many days in advance alerts appear.' },
  { to: '/admin/company', permission: 'admin.company', icon: 'building' as const, title: 'Company Details', text: 'Name, address and logo for printouts.' },
  { to: '/admin/import', permission: 'admin.import', icon: 'download' as const, title: 'Import and Backup', text: 'Import orders from a spreadsheet, or download a full backup.' },
  { to: '/admin/archive', permission: 'admin.archive', icon: 'archive' as const, title: 'Archive', text: 'Restore archived records, or delete them permanently.' },
  { to: '/admin/status', permission: 'admin.status', icon: 'pulse' as const, title: 'System Status', text: 'Health of the database, email, phone push, scheduled jobs and calendar sync; storage used and recent errors.' },
  { to: '/admin/activity', permission: 'admin.activity', icon: 'history' as const, title: 'Activity', text: 'Every change: who made it, what changed and when.' },
]
