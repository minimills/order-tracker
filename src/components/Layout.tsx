import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { usePermissions } from '../lib/permissions'
import { NAV_ITEMS } from '../lib/permissions/nav'
import { useStageLabels } from '../lib/stages'
import AlertsBell from './alerts/AlertsBell'
import NotificationsBell from './NotificationsBell'
import AlertsProvider from './alerts/AlertsProvider'
import NotificationPrompt from './alerts/NotificationPrompt'
import { isSupabaseConfigured } from '../lib/supabase'
import { ACTION } from '../lib/wording'
import Icon from './Icon'
import { useChatUnread } from '../lib/chat'


export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { session, role, signOut } = useAuth()
  const { can, canAny } = usePermissions()
  // Loads the stage names an admin may have renamed (Admin → Stage names).
  useStageLabels()
  // The menu is built from permissions: pages someone can't see are not in it.
  const chatUnread = useChatUnread(can('chat'))
  const items = NAV_ITEMS.filter(
    (i) => (!i.permission || can(i.permission, i.level)) && (!i.anyOf || canAny(i.anyOf, i.level)),
  )
  const page = (
    <div className="flex h-full">
      {/* Dark backdrop behind the menu on phones */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-60 flex-col bg-slate-900 text-slate-100 transition-transform md:static md:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-5 py-5">
          <div className="text-lg font-semibold">Belfast Mini Mills</div>
          <div className="text-sm text-slate-400">Order Tracker</div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : undefined}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <Icon name={item.icon} className="h-4 w-4 opacity-80" />
              {item.label}
              {item.badge === 'chat' && chatUnread > 0 && (
                <span className="ml-auto rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white" aria-label={`${chatUnread} unread`}>
                  {chatUnread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {session && (
          <div className="border-t border-slate-800 px-5 py-4 text-sm">
            <div className="truncate text-slate-400" title={session.user.email}>
              {session.user.email}
            </div>
            {role && <div className="text-xs text-slate-500">{role === 'admin' ? 'Admin (full access)' : 'User'}</div>}
            <button type="button" onClick={signOut} className="mt-2 text-slate-300 underline hover:text-white">
              {ACTION.signOut}
            </button>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: menu button (phones) and the alerts bell */}
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 md:px-8">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm md:hidden"
          >
            <span className="flex items-center gap-1.5">
              <Icon name="menu" /> Menu
            </span>
          </button>
          <span className="font-semibold md:hidden">Belfast Mini Mills</span>
          <div className="ml-auto flex items-center gap-2">
            {isSupabaseConfigured && can('notifications.bell') && <NotificationsBell />}
            {isSupabaseConfigured && can('alerts.bell') && <AlertsBell />}
          </div>
        </header>
        {isSupabaseConfigured && can('alerts.popups') && <NotificationPrompt />}

        {!isSupabaseConfigured && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            The app is not connected to the database. Copy <code>.env.example</code> to <code>.env.local</code> and
            enter your Supabase details (see the README).
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
  // Alerts need the database; without it the app still opens and shows a warning.
  return isSupabaseConfigured ? <AlertsProvider>{page}</AlertsProvider> : page
}
