import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { isSupabaseConfigured } from '../lib/supabase'

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { to: '/board', label: 'Orders board', icon: '📋' },
  { to: '/orders/new', label: 'New order', icon: '➕' },
  { to: '/orders', label: 'Orders list', icon: '📄', end: true },
  { to: '/payments', label: 'Payments', icon: '💵' },
  { to: '/agent', label: 'Agent', icon: '💬' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
]

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { session, role, signOut } = useAuth()
  return (
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
          <div className="text-sm text-slate-400">Order tracker</div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {navItems.map((item) => (
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
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        {session && (
          <div className="border-t border-slate-800 px-5 py-4 text-sm">
            <div className="truncate text-slate-400" title={session.user.email}>
              {session.user.email}
            </div>
            {role && <div className="text-xs text-slate-500">{role === 'admin' ? 'Admin' : 'Staff'}</div>}
            <button type="button" onClick={signOut} className="mt-2 text-slate-300 underline hover:text-white">
              Sign out
            </button>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar with menu button – phones only */}
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm"
          >
            ☰ Menu
          </button>
          <span className="font-semibold">Belfast Mini Mills</span>
        </header>

        {!isSupabaseConfigured && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            Not connected to the database yet. Copy <code>.env.example</code> to <code>.env.local</code> and fill in
            your Supabase details (see README).
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
