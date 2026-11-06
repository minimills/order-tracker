import { ADMIN_KEYS, type Level } from './catalog'

/** The left menu. Each item shows only when its permission is allowed. */
export type NavItem = {
  to: string
  label: string
  icon: string
  permission?: string
  anyOf?: string[]
  level?: Level
  end?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: '🏠', permission: 'dashboard' },
  { to: '/board', label: 'Orders board', icon: '📋', permission: 'orders.board' },
  { to: '/orders/new', label: 'New order', icon: '➕', permission: 'orders.new', level: 'edit' },
  { to: '/orders', label: 'Orders list', icon: '📄', permission: 'orders.list', end: true },
  { to: '/payments', label: 'Payments', icon: '💵', permission: 'payments.page' },
  { to: '/crating', label: 'Crating report', icon: '📦', permission: 'reports.crating' },
  { to: '/reports/department-delays', label: 'Department delays', icon: '⏱', permission: 'reports.department_delays' },
  { to: '/agent', label: 'Agent', icon: '💬', permission: 'agent' },
  { to: '/settings', label: 'Settings', icon: '⚙️', permission: 'settings' },
  { to: '/admin', label: 'Admin', icon: '🛠', anyOf: ADMIN_KEYS },
]

/** Pages someone can land on after signing in, in order of preference. */
export const START_PAGES: NavItem[] = [
  ...NAV_ITEMS,
  { to: '/shop-board', label: 'Shop board', icon: '🖨', permission: 'shop_board' },
]

/** The pages a start page can be (the same addresses the database accepts). */
export function startPageChoices(allowed: (p: NavItem) => boolean) {
  return START_PAGES.filter(allowed)
}
