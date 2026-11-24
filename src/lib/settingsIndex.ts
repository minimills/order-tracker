import { ADMIN_PAGES, ADMIN_VIEW_ONLY } from './adminPages'
import type { Level } from './permissions/catalog'
import { tr } from '../i18n'

/**
 * Everything the settings search (top of Settings and Admin pages) can find.
 * `to` opens the page; `find` is the id or data-setting of the part to jump to
 * (it is scrolled into view and highlighted). Only entries the person may
 * open are offered.
 */
export type SettingEntry = {
  label: string
  /** Where it is, shown under the label ("Settings", "Admin → Email"). */
  where: string
  /** More words people might type. */
  keywords?: string
  to: string
  find?: string
  permission?: string
  anyOf?: string[]
  level?: Level
}

const MY: SettingEntry[] = [
  { get label() {
    return tr("Your account and departments")
  }, where: 'Settings', keywords: 'email role department name', to: '/settings', find: 'account', permission: 'settings.account' },
  { get label() {
    return tr("Language")
  }, where: 'Settings', keywords: 'language langue idioma язык sprache french english spanish russian german français español русский deutsch', to: '/settings', find: 'language', permission: 'settings.language', level: 'edit' },
  { get label() {
    return tr("Appearance: Light, Dark, System or Glass")
  }, where: 'Settings', keywords: 'theme dark mode night colours glass frosted blur transparent look', to: '/settings', find: 'theme', permission: 'settings.theme', level: 'edit' },
  { get label() {
    return tr("Start page")
  }, where: 'Settings', keywords: 'home first page after sign in', to: '/settings', find: 'start-page', permission: 'settings.start_page', level: 'edit' },
  { get label() {
    return tr("Units for crate sizes and weights")
  }, where: 'Settings', keywords: 'imperial metric inches pounds kg cm', to: '/settings', find: 'units', permission: 'settings.units' },
  { get label() {
    return tr("Phone calendar link (calendar to app)")
  }, where: 'Calendar → Calendar Connection', keywords: 'ical icloud google calendar sync refresh', to: '/calendar', find: 'calendar-import', permission: 'service.calendar.import', level: 'edit' },
  { get label() {
    return tr("My calendar link (app to phone calendar)")
  }, where: 'Calendar → Calendar Connection', keywords: 'ical webcal subscribe apple google outlook calendar feed', to: '/calendar', find: 'calendar-feed', permission: 'service.calendar.sync', level: 'edit' },
  { get label() {
    return tr("Daily summary: Today’s Agenda and What I Did Today")
  }, where: 'Settings', keywords: 'morning evening digest agenda recap email push', to: '/settings', find: 'daily-summary', permission: 'settings.daily_summary', level: 'edit' },
  { get label() {
    return tr("Email: send from my own address (my sending mailbox)")
  }, where: 'Settings', keywords: 'smtp mailbox from address sender reply-to sent folder imap test email password', to: '/settings', find: 'my-email', permission: 'settings.mailbox' },
  { get label() {
    return tr("Change sign-in email")
  }, where: 'Settings', keywords: 'login address account email change', to: '/settings', find: 'change-email', permission: 'settings.change_email', level: 'edit' },
  { get label() {
    return tr("My signature (upload, replace or remove)")
  }, where: 'Settings', keywords: 'sign scan saved signature picture', to: '/settings', find: 'my-signature', permission: 'settings.signature' },
  { get label() {
    return tr("Chat swipe actions (swipe left / right)")
  }, where: 'Settings', keywords: 'archive delete clear hide unread phone conversation list', to: '/settings', find: 'chat-swipe', permission: 'settings.chat_swipe', level: 'edit' },
  { get label() {
    return tr("Hide my chat status")
  }, where: 'Settings', keywords: 'online away presence', to: '/settings', find: 'chat-status', permission: 'settings.chat_status', level: 'edit' },
  { get label() {
    return tr("Notification settings (in-app, phone push, email, desktop)")
  }, where: 'Settings → Notifications', keywords: 'alerts emails push bell switches', to: '/settings/notifications', permission: 'settings.notification_channels' },
  { get label() {
    return tr("Quiet hours")
  }, where: 'Settings → Notifications', keywords: 'night do not disturb phone silent', to: '/settings/notifications', find: 'quiet-hours', permission: 'settings.quiet_hours', level: 'edit' },
  { get label() {
    return tr("Phone notifications on this device")
  }, where: 'Settings → Notifications', keywords: 'push iphone android enable test', to: '/settings/notifications', find: 'phone', permission: 'settings.push', level: 'edit' },
  { get label() {
    return tr("Desktop notifications")
  }, where: 'Settings → Notifications', keywords: 'computer browser pop-ups turn off', to: '/settings/notifications', find: 'desktop', permission: 'settings.notifications' },
  { get label() {
    return tr("Email: each time or daily summary")
  }, where: 'Settings → Notifications', keywords: 'digest once a day', to: '/settings/notifications', find: 'email-mode', permission: 'settings.notification_channels', level: 'edit' },
  { get label() {
    return tr("My automations (When … If … Then …)")
  }, where: 'Automations', keywords: 'automation rule trigger workflow automatic when then', to: '/automations', permission: 'automations' },
]

const A = (page: string) => ADMIN_PAGES.find((p) => p.to === page)!
const inner = (page: string, label: string, find: string, keywords = ''): SettingEntry => {
  const p = A(page)
  return { label, where: `Admin → ${p.title}`, keywords, to: p.to, find, permission: p.permission, level: ADMIN_VIEW_ONLY.has(p.permission) ? 'view' : 'edit' }
}

const ADMIN_INNER: SettingEntry[] = [
  inner('/admin/users', 'Add a user', 'new-email', 'invite login new person staff'),
  inner('/admin/automations', 'Automation limits (rules per person, runs per minute)', 'au-limits', 'automation rules limit runs per minute loop'),
  inner('/admin/automations', 'Automations of people who were removed', 'au-removed', 'automation owner removed paused reassign'),
  inner('/admin/automations', 'Automation templates', 'au-templates', 'automation example template'),
  inner('/admin/dashboard-templates', 'Dashboard templates for people or departments', 'dt-name', 'dashboard template starting layout lock department'),
  inner('/admin/payroll', 'Weekday fill hours (Fill Weekdays start, end and break)', 'pr-fill', 'timesheet fill 8 4:30 break auto'),
  inner('/admin/payroll', 'Overtime threshold (hours per week)', 'pr-overtime', 'overtime 44 hours week pei'),
  inner('/admin/payroll', 'Banked overtime: 1× or 1.5× the hours', 'pr-bank', 'bank banked time in lieu overtime'),
  inner('/admin/payroll', 'Vacation days by years of service', 'pr-vacation', 'vacation holidays weeks entitlement'),
  inner('/admin/payroll', 'Paid sick days', 'pr-sick', 'sick days leave entitlement'),
  inner('/admin/payroll', 'PEI minimum standards', 'pr-minimum', 'employment standards act minimum warning'),
  inner('/admin/payroll', 'Statutory holiday pay and employer costs', 'pr-stat', 'stat holiday pay cpp ei wcb labour cost'),
  inner('/admin/timesheets', 'Import old timesheets (Excel or CSV)', 'ts-import', 'import 2025 2026 sheet xlsx csv layout'),
  inner('/admin/timesheets', 'Employees without a login', 'ts-employees', 'employee former staff payroll'),
  inner('/admin/departments', 'Department managers (approve timesheets and time off)', 'dept-managers', 'manager approve timesheet time off'),
  inner('/admin/order-defaults', 'Default currency (Canada / other countries)', 'od-cad', 'cad usd money'),
  inner('/admin/order-defaults', 'Default voltage on new orders', 'od-volt', '120v 240v'),
  inner('/admin/order-defaults', 'Crate machines by default', 'od-crate', 'crating'),
  inner('/admin/order-defaults', 'Down payment due (days)', 'od-down', 'deposit'),
  inner('/admin/order-defaults', 'Balance due before shipping (days)', 'od-bal', 'payment'),
  inner('/admin/order-defaults', 'Full payment when shipping soon (days)', 'od-full-within', 'full payment 90 days no down payment'),
  inner('/admin/order-defaults', 'Full payment due (days after the order)', 'od-full-due', 'full payment 30 days'),
  inner('/admin/dropdowns', 'Voltage colours on the Orders board', 'voltage-colours', 'chip colour 120v 240v'),
  inner('/admin/machine-types', 'Declaration of conformity per machine type (product description, directives, standards)', 'ce-types', 'ce certificate directive standard'),
  inner('/admin/machine-types', 'Build times (working days per step)', 'build-times', 'fabrication assembly days schedule'),
  inner('/admin/scheduling', 'Buffer days before shipping', 'sc-buffer', 'ship date'),
  inner('/admin/scheduling', 'Machines in one order: one after another or at once', 'sc-parallel', 'parallel'),
  inner('/admin/scheduling', 'Working days', 'working-days', 'weekend saturday'),
  inner('/admin/holidays', 'Province for statutory holidays', 'hol-prov', 'pei import canada-holidays'),
  inner('/admin/email', 'Send a test email', 'test-to', 'smtp mailbox'),
  inner('/admin/email', 'Daily summary time', 'digest-hour', 'digest email hour'),
  inner('/admin/email', 'Wait before sending (group quick changes)', 'gather', 'minutes'),
  inner('/admin/email', 'At most one email per card every …', 'throttle', 'minutes limit'),
  inner('/admin/company', 'Company name', 'co-name', 'letterhead'),
  inner('/admin/company', 'Company address', 'co-address', 'letterhead'),
  inner('/admin/company', 'Company phone', 'co-phone', ''),
  inner('/admin/company', 'Company email', 'co-email', ''),
  inner('/admin/company', 'Office email for certificates', 'co-office', 'commissioning'),
  inner('/admin/company', 'Company logo', 'co-logo', 'letterhead picture'),
  inner('/admin/production', 'Office department for production boards', 'prod-office', ''),
  { get label() {
    return tr("Production assignments: default people per stage")
  }, where: 'Admin → Production Assignments', keywords: 'assign assignee default people stage machine type department automatic cards tasks', to: '/admin/production-assignments', permission: 'admin.production_assignments' },
  inner('/admin/production', 'Production board sharing level', 'prod-level', 'share'),
  inner('/admin/serials', 'Re-sequence serial numbers', 'st-type', 'renumber'),
  inner('/admin/templates', 'Commissioning certificate text', 'tpl-title', 'service report'),
  inner('/admin/dashboard-charts', 'Gauge targets (green, amber, red) for dashboard charts', 'dc-targets', 'threshold kpi chart'),
  inner('/admin/dashboard-charts', 'Good and bad colours of dashboard widgets (higher or lower is better, red and green limits)', 'dc-health', 'red green bad good threshold direction kpi colour color'),
  inner('/admin/dashboard-charts', 'Charts a new dashboard starts with', 'dc-defaults', 'default charts'),
  inner('/admin/calendar', 'Service / Training team for shared calendar entries', 'calendar-team', 'calendar share technicians group default'),
  inner('/admin/email-templates', 'Office sending address (used when a person has not connected their own mailbox)', 'et-sender', 'sender from reply accounts office address'),
  inner('/admin/email-templates', 'Customer reminder emails (down payment, balance, overdue, ship date)', 'et-reminders', 'reminder template payment'),
  inner('/admin/email-templates', 'Welcome email for new users', 'et-welcome', 'onboarding invite'),
  inner('/admin/freight', 'Standard broker fee, hourly and plywood rates', 'fr-broker', 'freight handling margin exchange rate cost breakdown'),
  inner('/admin/freight', 'Person who arranges shipping (told when crating is entered)', 'fr-shipping-contact', 'shipping quote crating notify freight contact'),
  inner('/admin/freight', 'Insurance rule for freight', 'fr-insurance', 'uplift minimum ocean air inland livingston'),
  inner('/admin/freight', 'Pick-up locations for freight quote requests', 'fr-locations', 'address belfast murray river'),
  inner('/admin/freight', 'Shipping agents and carriers', 'fr-agents', 'livingston fedex ups purolator dhl contact email'),
  inner('/admin/email-templates', 'Commissioning certificate email subject and CC', 'et-certificate', 'email template office cc subject'),
  inner('/admin/email-templates', 'Service report email subject and CC', 'et-service_report', 'email template office cc subject'),
  inner('/admin/ce', 'Declaration of Conformity settings (EC or EU type, signer, authorised person)', 'ce-settings', 'ce certificate 2006/42/ec 2023/1230 machinery'),
  inner('/admin/ce', 'EC Declaration of Conformity template', 'ce-template-ce_ec', 'ce certificate text'),
  inner('/admin/ce', 'EU Declaration of Conformity template', 'ce-template-ce_eu', 'ce regulation 2023/1230 text'),
  inner('/admin/ce', 'Register of declarations of conformity', 'ce-register', 'ce certificates issued sent'),
  inner('/admin/company', 'Contact person on declarations', 'co-contact', 'ce manufacturer'),
  inner('/admin/activity', 'Activity by person', 'ac-person', 'history who'),
  inner('/admin/status', 'Plan limits (database and file storage)', 'limits', 'free plan storage size'),
]

const ADMIN: SettingEntry[] = ADMIN_PAGES.map((p) => ({
  label: p.title,
  where: 'Admin',
  keywords: p.text,
  to: p.to,
  permission: p.permission,
  level: ADMIN_VIEW_ONLY.has(p.permission) ? 'view' : 'edit',
}))

export const SETTINGS_INDEX: SettingEntry[] = [...MY, ...ADMIN, ...ADMIN_INNER]

/** Best matches first: every typed word must appear in the label, place or keywords. */
export function searchSettings(query: string, allowed: (e: SettingEntry) => boolean, limit = 8) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return SETTINGS_INDEX.filter(allowed)
    .map((e) => {
      const label = e.label.toLowerCase()
      const hay = `${label} ${e.where.toLowerCase()} ${(e.keywords ?? '').toLowerCase()}`
      if (!words.every((w) => hay.includes(w))) return null
      const score = words.reduce((s, w) => s + (label.startsWith(w) ? 3 : label.includes(w) ? 2 : 1), 0)
      return { e, score }
    })
    .filter((x): x is { e: SettingEntry; score: number } => !!x)
    .sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label))
    .slice(0, limit)
    .map((x) => x.e)
}
