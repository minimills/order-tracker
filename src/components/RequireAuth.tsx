import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { isSupabaseConfigured } from '../lib/supabase'

/** Shows the page only to signed-in users whose email is on the allowed list. */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, session, allowed, signOut } = useAuth()
  const location = useLocation()

  // Without database settings there is nothing to sign in to; the Layout shows a warning.
  if (!isSupabaseConfigured) return <>{children}</>

  if (loading || (session && allowed === null)) {
    return <div className="p-8 text-center text-slate-500">Loading…</div>
  }

  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />

  if (!allowed) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">No access yet</h1>
        <p className="mt-2 text-sm text-slate-600">
          You are signed in as <strong>{session.user.email}</strong>, but this email is not on the list of allowed
          users. Ask the office to add it, then sign in again.
        </p>
        <button
          type="button"
          onClick={signOut}
          className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700"
        >
          Sign out
        </button>
      </div>
    )
  }

  return <>{children}</>
}
