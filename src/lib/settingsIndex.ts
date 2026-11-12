import { ADMIN_PAGES, ADMIN_VIEW_ONLY } from './adminPages'
import type { Level } from './permissions/catalog'

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
  { label: 'Your account and departments', where: 'Settings', keywords: 'email role department name', to: '/settings', find: 'account', permission: 'settings.account' },
  { label: 'Theme: Light, Dark or System', where: 'Settings', keywords: 'dark mode night colours appearance look', to: '/settings', find: 'theme', permission: 'settings.theme', level: 'edit' },
  { label: 'Start page', where: 'Settings', keywords: 'home first page after sign in', to: '/settings', find: 'start-page', permission: 'settings.start_page', level: 'edit' },
  { label: 'Units for crate sizes and weights', where: 'Settings', keywords: 'imperial metric inches pounds kg cm', to: '/settings', find: 'units', permission: 'settings.units' },
  { label: 'Phone calendar link (calendar to app)', where: 'Settings', keywords: 'ical icloud google calendar sync', to: '/settings', find: 'calendar-import', permission: 'service.calendar.import', level: 'edit' },
  { label: 'Hide my chat status', where: 'Settings', keywords: 'online away presence', to: '/settings', find: 'chat-status', permission: 'settings.chat_status', level: 'edit' },
  { label: 'Notification settings (in-app, phone push, email, desktop)', where: 'Settings → Notifications', keywords: 'alerts emails push bell switches', to: '/settings/notifications', permission: 'settings.notification_channels' },
  { label: 'Quiet hours', where: 'Settings → Notifications', keywords: 'night do not disturb phone silent', to: '/settings/notifications', find: 'quiet-hours', permission: 'settings.quiet_hours', level: 'edit' },
  { label: 'Phone notifications on this device', where: 'Settings → Notifications', keywords: 'push iphone android enable test', to: '/settings/notifications', find: 'phone', permission: 'settings.push', level: 'edit' },
  { label: 'Desktop notifications', where: 'Settings → Notifications', keywords: 'computer browser pop-ups turn off', to: '/settings/notifications', find: 'desktop', permission: 'settings.notifications' },
  { label: 'Email: each time or daily summary', where: 'Settings → Notifications', keywords: 'digest once a day', to: '/settings/notifications', find: 'email-mode', permission: 'settings.notification_channels', level: 'edit' },
]

const A = (page: string) => ADMIN_PAGES.find((p) => p.to === page)!
const inner = (page: string, label: string, find: string, keywords = ''): SettingEntry => {
  const p = A(page)
  return { label, where: `Admin → ${p.title}`, keywords, to: p.to, find, permission: p.permission, level: ADMIN_VIEW_ONLY.has(p.permission) ? 'view' : 'edit' }
}

const ADMIN_INNER: SettingEntry[] = [
  inner('/admin/users', 'Add a user', 'new-email', 'invite login new person staff'),
  inner('/admin/order-defaults', 'Default currency (Canada / other countries)', 'od-cad', 'cad usd money'),
  inner('/admin/order-defaults', 'Default voltage on new orders', 'od-volt', '120v 240v'),
  inner('/admin/order-defaults', 'Crate machines by default', 'od-crate', 'crating'),
  inner('/admin/order-defaults', 'Down payment due (days)', 'od-down', 'deposit'),
  inner('/admin/order-defaults', 'Balance due before shipping (days)', 'od-bal', 'payment'),
  inner('/admin/order-defaults', 'Full payment when shipping soon (days)', 'od-full-within', 'full payment 90 days no down payment'),
  inner('/admin/order-defaults', 'Full payment due (days after the order)', 'od-full-due', 'full payment 30 days'),
  inner('/admin/dropdowns', 'Voltage colours on the Orders board', 'voltage-colours', 'chip colour 120v 240v'),
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
  inner('/admin/production', 'Production board sharing level', 'prod-level', 'share'),
  inner('/admin/serials', 'Re-sequence serial numbers', 'st-type', 'renumber'),
  inner('/admin/templates', 'Commissioning certificate text', 'tpl-title', 'service report'),
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
