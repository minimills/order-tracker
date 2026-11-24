import type { IconName } from '../../components/Icon'
import { ADMIN_KEYS, FREIGHT_KEYS, TIMESHEET_KEYS, type Level } from './catalog'
import { tr } from '../../i18n'

/** The left menu. Each item shows only when its permission is allowed. */
export type NavItem = {
  to: string
  label: string
  icon: IconName
  permission?: string
  anyOf?: string[]
  level?: Level
  end?: boolean
  /** Shows a live count next to the item (unread chat messages) or a dot (new notices). */
  badge?: 'chat' | 'notices'
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', get label() {
    return tr("Dashboard")
  }, icon: 'home', permission: 'dashboard' },
  { to: '/board', get label() {
    return tr("Orders Board")
  }, icon: 'queue', permission: 'orders.board' },
  { to: '/orders/new', get label() {
    return tr("New Order")
  }, icon: 'plus', permission: 'orders.new', level: 'edit' },
  { to: '/orders', get label() {
    return tr("Orders List")
  }, icon: 'list', permission: 'orders.list', end: true },
  { to: '/machines', get label() {
    return tr("Machines")
  }, icon: 'hash', permission: 'machines' },
  { to: '/boards', get label() {
    return tr("Boards")
  }, icon: 'boards', permission: 'boards' },
  { to: '/notices', get label() {
    return tr("Notice Board")
  }, icon: 'pin', permission: 'notices', badge: 'notices' },
  { to: '/chat', get label() {
    return tr("Chat")
  }, icon: 'chat', permission: 'chat', badge: 'chat' },
  { to: '/service', get label() {
    return tr("Service / Training")
  }, icon: 'cog', permission: 'service' },
  { to: '/calendar', get label() {
    return tr("Calendar")
  }, icon: 'calendar', permission: 'service.calendar' },
  { to: '/timesheets', get label() {
    return tr("Timesheets")
  }, icon: 'timer', anyOf: TIMESHEET_KEYS },
  { to: '/my-timesheet', get label() {
    return tr("My Timesheet")
  }, icon: 'clock', permission: 'timesheets.mine' },
  { to: '/time-off', get label() {
    return tr("Time Off")
  }, icon: 'calendar', permission: 'timesheets.time_off' },
  { to: '/automations', get label() {
    return tr("Automations")
  }, icon: 'bolt', permission: 'automations' },
  { to: '/payments', get label() {
    return tr("Payments")
  }, icon: 'money', permission: 'payments.page' },
  { to: '/freight', get label() {
    return tr("Freight")
  }, icon: 'truck', anyOf: FREIGHT_KEYS },
  { to: '/reports/department-delays', get label() {
    return tr("Department Delays")
  }, icon: 'clock', permission: 'reports.department_delays' },
  { to: '/reports/build-times', get label() {
    return tr("Build Times")
  }, icon: 'clock', permission: 'reports.build_times' },
  { to: '/agent', get label() {
    return tr("Agent")
  }, icon: 'chat', permission: 'agent' },
  { to: '/settings', get label() {
    return tr("Settings")
  }, icon: 'settings', permission: 'settings' },
  { to: '/admin', get label() {
    return tr("Admin")
  }, icon: 'wrench', anyOf: ADMIN_KEYS },
]

/** Pages someone can land on after signing in, in order of preference. */
export const START_PAGES: NavItem[] = [
  ...NAV_ITEMS,
  { to: '/shop-board', get label() {
    return tr("Shop Board")
  }, icon: 'printer', permission: 'shop_board' },
]

/** The pages a start page can be (the same addresses the database accepts). */
export function startPageChoices(allowed: (p: NavItem) => boolean) {
  return START_PAGES.filter(allowed)
}
