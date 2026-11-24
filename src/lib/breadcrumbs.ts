import { useEffect, useSyncExternalStore } from 'react'
import { ADMIN_PAGES } from './adminPages'
import { NAV_ITEMS } from './permissions/nav'
import { tr } from '../i18n'

/** One part of the breadcrumb trail ("Orders > Order 86 > Carder - Large LCR-2073"). */
export type Crumb = { label: string; to?: string }

// What the open page says about itself (for example the order number), if anything.
let pageCrumbs: Crumb[] | null = null
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const usePageCrumbs = () => useSyncExternalStore(subscribe, () => pageCrumbs)

/**
 * A page with a name of its own (an order, a board, a conversation) calls this
 * with its full trail, for example
 * useBreadcrumbs(order && [{ label: 'Orders', to: '/orders' }, { label: `Order ${order.order_code}` }]).
 * Pass null while loading; the address-based trail is shown until then.
 */
export function useBreadcrumbs(crumbs: Crumb[] | null | undefined | false) {
  const key = crumbs ? JSON.stringify(crumbs) : ''
  useEffect(() => {
    pageCrumbs = key ? (JSON.parse(key) as Crumb[]) : null
    listeners.forEach((l) => l())
    return () => {
      pageCrumbs = null
      listeners.forEach((l) => l())
    }
  }, [key])
}

const navLabel = (to: string) => NAV_ITEMS.find((n) => n.to === to)?.label

/** The trail worked out from the address alone (pages with ids add their own names). */
export function crumbsForPath(path: string): Crumb[] {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/') return []
  const admin = ADMIN_PAGES.find((a) => a.to === p)
  if (admin) return [{ get label() {
    return tr("Admin")
  }, to: '/admin' }, { label: admin.title }]
  if (p.startsWith('/admin')) return [{ get label() {
    return tr("Admin")
  }, to: '/admin' }]
  const exact: Record<string, Crumb[]> = {
    '/orders': [{ get label() {
    return tr("Orders")
  } }],
    '/orders/new': [{ get label() {
    return tr("Orders")
  }, to: '/orders' }, { get label() {
    return tr("New Order")
  } }],
    '/settings/notifications': [{ get label() {
    return tr("Settings")
  }, to: '/settings' }, { get label() {
    return tr("Notifications")
  } }],
    '/reports/department-delays': [{ get label() {
    return tr("Reports")
  } }, { get label() {
    return tr("Department Delays")
  } }],
    '/reports/build-times': [{ get label() {
    return tr("Reports")
  } }, { get label() {
    return tr("Build Times")
  } }],
  }
  if (exact[p]) return exact[p]
  if (navLabel(p)) return [{ label: navLabel(p)! }]
  const parts = p.split('/').filter(Boolean)
  const section: Record<string, Crumb> = {
    orders: { get label() {
    return tr("Orders")
  }, to: '/orders' },
    checklists: { get label() {
    return tr("Orders")
  }, to: '/orders' },
    boards: { get label() {
    return tr("Boards")
  }, to: '/boards' },
    chat: { get label() {
    return tr("Chat")
  }, to: '/chat' },
    service: { get label() {
    return tr("Service / Training")
  }, to: '/service' },
    notices: { get label() {
    return tr("Notice Board")
  }, to: '/notices' },
    settings: { get label() {
    return tr("Settings")
  }, to: '/settings' },
    freight: { get label() {
    return tr("Freight")
  }, to: '/freight' },
    timesheets: { get label() {
    return tr("Timesheets")
  }, to: '/timesheets' },
    automations: { get label() {
    return tr("Automations")
  }, to: '/automations' },
  }
  const first = section[parts[0]]
  if (!first) return []
  const rest: Record<string, string> = {
    orders: 'Order',
    checklists: 'Final Check',
    timesheets: 'Employee',
    automations: 'Automation',
    boards: 'Board',
    chat: 'Conversation',
    service: parts[1] === 'calls' ? 'Service Call' : parts[1] === 'certificates' ? 'Certificate' : 'Order',
  }
  return [first, { label: rest[parts[0]] ?? '…' }]
}
