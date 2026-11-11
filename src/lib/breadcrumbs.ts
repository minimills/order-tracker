import { useEffect, useSyncExternalStore } from 'react'
import { ADMIN_PAGES } from './adminPages'
import { NAV_ITEMS } from './permissions/nav'

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

const NAV_LABEL = new Map(NAV_ITEMS.map((n) => [n.to, n.label]))

/** The trail worked out from the address alone (pages with ids add their own names). */
export function crumbsForPath(path: string): Crumb[] {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/') return []
  const admin = ADMIN_PAGES.find((a) => a.to === p)
  if (admin) return [{ label: 'Admin', to: '/admin' }, { label: admin.title }]
  if (p.startsWith('/admin')) return [{ label: 'Admin', to: '/admin' }]
  const exact: Record<string, Crumb[]> = {
    '/orders': [{ label: 'Orders' }],
    '/orders/new': [{ label: 'Orders', to: '/orders' }, { label: 'New Order' }],
    '/settings/notifications': [{ label: 'Settings', to: '/settings' }, { label: 'Notifications' }],
    '/service/calendar': [{ label: 'Service', to: '/service' }, { label: 'Tech Calendar' }],
    '/reports/department-delays': [{ label: 'Reports' }, { label: 'Department Delays' }],
    '/reports/build-times': [{ label: 'Reports' }, { label: 'Build Times' }],
    '/crating': [{ label: 'Reports' }, { label: 'Crating Report' }],
  }
  if (exact[p]) return exact[p]
  if (NAV_LABEL.has(p)) return [{ label: NAV_LABEL.get(p)! }]
  const parts = p.split('/').filter(Boolean)
  const section: Record<string, Crumb> = {
    orders: { label: 'Orders', to: '/orders' },
    checklists: { label: 'Orders', to: '/orders' },
    boards: { label: 'Boards', to: '/boards' },
    chat: { label: 'Chat', to: '/chat' },
    service: { label: 'Service', to: '/service' },
    notices: { label: 'Notice Board', to: '/notices' },
    settings: { label: 'Settings', to: '/settings' },
  }
  const first = section[parts[0]]
  if (!first) return []
  const rest: Record<string, string> = {
    orders: 'Order',
    checklists: 'Final Check',
    boards: 'Board',
    chat: 'Conversation',
    service: parts[1] === 'calls' ? 'Service Call' : parts[1] === 'certificates' ? 'Certificate' : 'Order',
  }
  return [first, { label: rest[parts[0]] ?? '…' }]
}
