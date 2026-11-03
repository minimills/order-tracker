import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { isSupabaseConfigured } from '../../lib/supabase'

/**
 * Shows the admin pages only to admins. (The database also refuses admin
 * changes from staff, so this is not the only protection.)
 */
export default function RequireAdmin() {
  const { isAdmin, role } = useAuth()
  if (role === null && isSupabaseConfigured) return <div className="p-8 text-center text-slate-500">Loading…</div>
  if (!isAdmin) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold">Admins only</h1>
        <p className="mt-2 text-sm text-slate-600">This page is only for admins. Ask an admin if you need a change here.</p>
        <Link to="/dashboard" className="mt-4 inline-block text-sm underline">
          Back to the dashboard
        </Link>
      </div>
    )
  }
  return <Outlet />
}
