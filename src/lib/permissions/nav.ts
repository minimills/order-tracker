import type { IconName } from '../../components/Icon'
import { ADMIN_KEYS, type Level } from './catalog'

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
  { to: '/dashboard', label: 'Dashboard', icon: 'home', permission: 'dashboard' },
  { to: '/board', label: 'Orders Board', icon: 'queue', permission: 'orders.board' },
  { to: '/orders/new', label: 'New Order', icon: 'plus', permission: 'orders.new', level: 'edit' },
  { to: '/orders', label: 'Orders List', icon: 'list', permission: 'orders.list', end: true },
  { to: '/machines', label: 'Machines', icon: 'hash', permission: 'machines' },
  { to: '/boards', label: 'Boards', icon: 'boards', permission: 'boards' },
  { to: '/notices', label: 'Notice Board', icon: 'pin', permission: 'notices', badge: 'notices' },
  { to: '/chat', label: 'Chat', icon: 'chat', permission: 'chat', badge: 'chat' },
  { to: '/service', label: 'Service', icon: 'cog', permission: 'service' },
  { to: '/service/calendar', label: 'Tech Calendar', icon: 'calendar', permission: 'service.calendar' },
  { to: '/payments', label: 'Payments', icon: 'money', permission: 'payments.page' },
  { to: '/crating', label: 'Crating Report', icon: 'box', permission: 'reports.crating' },
  { to: '/reports/department-delays', label: 'Department Delays', icon: 'clock', permission: 'reports.department_delays' },
  { to: '/reports/build-times', label: 'Build Times', icon: 'clock', permission: 'reports.build_times' },
  { to: '/agent', label: 'Agent', icon: 'chat', permission: 'agent' },
  { to: '/settings', label: 'Settings', icon: 'settings', permission: 'settings' },
  { to: '/admin', label: 'Admin', icon: 'wrench', anyOf: ADMIN_KEYS },
]

/** Pages someone can land on after signing in, in order of preference. */
export const START_PAGES: NavItem[] = [
  ...NAV_ITEMS,
  { to: '/shop-board', label: 'Shop Board', icon: 'printer', permission: 'shop_board' },
]

/** The pages a start page can be (the same addresses the database accepts). */
export function startPageChoices(allowed: (p: NavItem) => boolean) {
  return START_PAGES.filter(allowed)
}
