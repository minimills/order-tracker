import { Navigate } from 'react-router-dom'
import { usePermissions } from '../lib/permissions'
import { START_PAGES } from '../lib/permissions/nav'

/** "/" goes to the first page the person may see (so with one page, they land on it). */
export default function HomeRedirect() {
  const { loading, can, canAny } = usePermissions()
  if (loading) return <div className="p-8 text-center text-slate-500">Loading…</div>
  const first = START_PAGES.find(
    (p) => (!p.permission || can(p.permission, p.level)) && (!p.anyOf || canAny(p.anyOf, p.level)),
  )
  if (first) return <Navigate to={first.to} replace />
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center">
      <h1 className="text-lg font-semibold">Nothing switched on yet</h1>
      <p className="mt-2 text-sm text-slate-600">
        You can sign in, but no pages have been switched on for you yet. Ask an admin to tick what you need in Admin →
        Users.
      </p>
    </div>
  )
}
