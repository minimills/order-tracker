import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { usePermissions } from '../lib/permissions'
import type { Level } from '../lib/permissions/catalog'

/**
 * A page that needs a permission. Someone without it (for example by typing
 * the address) sees "You don't have access" instead.
 * Use `permission` for one key, or `anyOf` when any of several keys will do.
 */
export default function Page({
  permission,
  anyOf,
  level = 'view',
  children,
}: {
  permission?: string
  anyOf?: string[]
  level?: Level
  children: ReactNode
}) {
  const { loading, can, canAny } = usePermissions()
  if (loading) return <div className="p-8 text-center text-slate-500">Loading…</div>
  const ok = (permission ? can(permission, level) : true) && (anyOf ? canAny(anyOf, level) : true)
  if (!ok) return <NoAccess />
  return <>{children}</>
}

export function NoAccess() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center">
      <h1 className="text-lg font-semibold">You Don’t Have Access</h1>
      <p className="mt-2 text-sm text-slate-600">
        This page is not enabled for your account. If you need it, ask an administrator to allow it in Admin → Users.
      </p>
      <Link to="/" className="mt-4 inline-block text-sm underline">
        Go to Your Start Page
      </Link>
    </div>
  )
}
