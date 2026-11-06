import { Navigate } from 'react-router-dom'
import { usePermissions } from '../lib/permissions'
import { START_PAGES, type NavItem } from '../lib/permissions/nav'
import { usePreferences } from '../lib/preferences'

/**
 * "/" opens the person's start page (set in Admin → Users or Settings) when
 * they may see it; otherwise their first allowed page (so with one page, they
 * land on it).
 */
export default function HomeRedirect() {
  const { loading, can, canAny } = usePermissions()
  const { startPage, loaded } = usePreferences()
  if (loading || !loaded) return <div className="p-8 text-center text-slate-500">Loading…</div>
  const allowed = (p: NavItem) => (!p.permission || can(p.permission, p.level)) && (!p.anyOf || canAny(p.anyOf, p.level))
  const chosen = START_PAGES.find((p) => p.to === startPage && allowed(p))
  const first = chosen ?? START_PAGES.find(allowed)
  if (first) return <Navigate to={first.to} replace />
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center">
      <h1 className="text-lg font-semibold">No Pages Enabled Yet</h1>
      <p className="mt-2 text-sm text-slate-600">
        You can sign in, but no pages have been enabled for your account yet. Ask an administrator to allow what you need in Admin →
        Users.
      </p>
    </div>
  )
}
