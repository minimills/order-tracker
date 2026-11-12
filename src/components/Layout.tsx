import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useChatUnread } from '../lib/chat'
import { useNoticeUnread } from '../lib/notices'
import { usePermissions } from '../lib/permissions'
import { NAV_ITEMS } from '../lib/permissions/nav'
import { usePreferences } from '../lib/preferences'
import { useStageLabels } from '../lib/stages'
import { isSupabaseConfigured } from '../lib/supabase'
import { ACTION } from '../lib/wording'
import Breadcrumbs from './Breadcrumbs'
import Icon from './Icon'
import NotificationsBell from './NotificationsBell'
import AlertsBell from './alerts/AlertsBell'
import AlertsProvider from './alerts/AlertsProvider'
import NotificationPrompt from './alerts/NotificationPrompt'
import UrgentBanner from './notices/UrgentBanner'
import ClosureBanner from './notices/ClosureBanner'
import NewOrderBanner from './NewOrderBanner'

/**
 * Jumps to a setting found with the settings search: ?find=<id> scrolls to the
 * element with data-setting="<id>" (or that id) and highlights it briefly.
 */
function useFindTarget() {
  const location = useLocation()
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('find')
    if (!id) return
    let tries = 0
    const t = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(id)}"]`) ?? document.getElementById(id)
      if (el || ++tries > 30) window.clearInterval(t)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.remove('setting-flash')
      void el.offsetWidth
      el.classList.add('setting-flash')
      const field = el.matches('input, select, textarea, button') ? el : el.querySelector<HTMLElement>('input, select, textarea, button')
      field?.focus({ preventScroll: true })
    }, 150)
    return () => window.clearInterval(t)
  }, [location.key, location.search])
}

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null)
  const { session, role, signOut } = useAuth()
  const { can, canAny } = usePermissions()
  const { sidebarCollapsed: collapsed, setLook } = usePreferences()
  // Loads the stage names an admin may have renamed (Admin → Stage names).
  useStageLabels()
  useFindTarget()
  const chatUnread = useChatUnread(can('chat'))
  const noticesUnread = useNoticeUnread(can('notices'))
  // The menu is built from permissions: pages someone can't see are not in it.
  const items = NAV_ITEMS.filter((i) => (!i.permission || can(i.permission, i.level)) && (!i.anyOf || canAny(i.anyOf, i.level)))

  // Tooltips beside the icons when the menu is collapsed (fixed, so the scrolling menu doesn't cut them off).
  const showTip = (text: string) => (e: { currentTarget: HTMLElement }) => {
    if (!collapsed) return
    const r = e.currentTarget.getBoundingClientRect()
    setTip({ text, top: r.top + r.height / 2, left: r.right + 8 })
  }
  const tipProps = (text: string) => ({ onMouseEnter: showTip(text), onFocus: showTip(text), onMouseLeave: () => setTip(null), onBlur: () => setTip(null) })
  const toggle = () => {
    setTip(null)
    setMenuOpen(false)
    void setLook({ sidebarCollapsed: !collapsed })
  }

  const page = (
    <div className="flex h-full">
      {/* Dark backdrop behind the open menu on phones */}
      {menuOpen && !collapsed && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <aside
        className={`keep-dark fixed inset-y-0 left-0 z-30 flex flex-col bg-slate-900 text-slate-100 transition-[width,transform] md:static md:translate-x-0 ${
          collapsed ? 'w-14 translate-x-0' : `w-60 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`
        }`}
        aria-label="Main menu"
      >
        <div className={`flex items-center gap-2 py-4 ${collapsed ? 'justify-center px-2' : 'px-5'}`}>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold">Belfast Mini Mills</div>
              <div className="text-sm text-slate-400">Order Tracker</div>
            </div>
          )}
          <button
            type="button"
            onClick={toggle}
            className="rounded-md p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
            aria-label={collapsed ? 'Expand Menu' : 'Collapse Menu'}
            aria-expanded={!collapsed}
            {...tipProps('Expand Menu')}
          >
            <Icon name="panel" className="h-5 w-5" />
          </button>
        </div>
        <nav className={`flex-1 space-y-1 overflow-y-auto ${collapsed ? 'px-2' : 'px-3'}`}>
          {items.map((item) => {
            const count = item.badge === 'chat' ? chatUnread : item.badge === 'notices' ? noticesUnread : 0
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={'end' in item ? item.end : undefined}
                onClick={() => setMenuOpen(false)}
                aria-label={collapsed ? `${item.label}${count ? ` (${count} new)` : ''}` : undefined}
                {...tipProps(item.label)}
                className={({ isActive }) =>
                  `relative flex items-center rounded-md py-2 text-sm font-medium ${collapsed ? 'justify-center px-2' : 'gap-3 px-3'} ${
                    isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`
                }
              >
                <Icon name={item.icon} className={`${collapsed ? 'h-5 w-5' : 'h-4 w-4'} opacity-80`} />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {count > 0 &&
                  (collapsed ? (
                    <span className={`absolute right-1 top-1 h-2.5 w-2.5 rounded-full ${item.badge === 'chat' ? 'bg-blue-500' : 'bg-red-500'}`} aria-hidden="true" />
                  ) : item.badge === 'chat' ? (
                    <span className="ml-auto rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white" aria-label={`${count} unread`}>
                      {count}
                    </span>
                  ) : (
                    <span className="ml-auto h-2.5 w-2.5 rounded-full bg-red-500" aria-label={`${count} new ${count === 1 ? 'notice' : 'notices'}`} title={`${count} new`} />
                  ))}
              </NavLink>
            )
          })}
        </nav>
        {session && (
          <div className={`border-t border-slate-800 py-4 text-sm ${collapsed ? 'flex justify-center px-2' : 'px-5'}`}>
            {collapsed ? (
              <button type="button" onClick={signOut} className="rounded-md p-2 text-slate-300 hover:bg-slate-800 hover:text-white" aria-label={ACTION.signOut} {...tipProps(`${ACTION.signOut} (${session.user.email})`)}>
                <Icon name="signOut" className="h-5 w-5" />
              </button>
            ) : (
              <>
                <div className="truncate text-slate-400" title={session.user.email}>
                  {session.user.email}
                </div>
                {role && <div className="text-xs text-slate-500">{role === 'admin' ? 'Admin (full access)' : 'User'}</div>}
                <button type="button" onClick={signOut} className="mt-2 text-slate-300 underline hover:text-white">
                  {ACTION.signOut}
                </button>
              </>
            )}
          </div>
        )}
      </aside>
      {tip && (
        <div role="tooltip" className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs font-medium text-white shadow-lg" style={{ top: tip.top, left: tip.left }}>
          {tip.text}
        </div>
      )}

      {/* With the collapsed menu always showing on phones, the page starts after it. */}
      <div className={`flex min-w-0 flex-1 flex-col ${collapsed ? 'pl-14 md:pl-0' : ''}`}>
        {/* Top bar: menu button (phones, expanded menu) and the bells */}
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 md:px-8">
          {!collapsed && (
            <button type="button" onClick={() => setMenuOpen(true)} className="rounded-md border border-slate-300 px-3 py-1 text-sm md:hidden">
              <span className="flex items-center gap-1.5">
                <Icon name="menu" /> Menu
              </span>
            </button>
          )}
          <span className="truncate font-semibold md:hidden">Belfast Mini Mills</span>
          <div className="ml-auto flex items-center gap-2">
            {isSupabaseConfigured && can('notifications.bell') && <NotificationsBell />}
            {isSupabaseConfigured && can('alerts.bell') && <AlertsBell />}
          </div>
        </header>
        {isSupabaseConfigured && canAny(['notices.closures', 'notices.closures.post']) && <ClosureBanner />}
        {isSupabaseConfigured && can('notices.banner') && <UrgentBanner />}
        {isSupabaseConfigured && can('orders.board.new_order_banner') && <NewOrderBanner />}
        {isSupabaseConfigured && can('alerts.popups') && <NotificationPrompt />}

        {!isSupabaseConfigured && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            The app is not connected to the database. Copy <code>.env.example</code> to <code>.env.local</code> and enter your Supabase details (see the
            README).
          </div>
        )}

        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-8">
          <Breadcrumbs />
          <Outlet />
        </main>
      </div>
    </div>
  )
  // Alerts need the database; without it the app still opens and shows a warning.
  return isSupabaseConfigured ? <AlertsProvider>{page}</AlertsProvider> : page
}
