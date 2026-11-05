import type { ReactNode } from 'react'
import { usePermissions } from '../lib/permissions'
import type { Level } from '../lib/permissions/catalog'

/**
 * Shows its children only when the signed-in person has the permission
 * (`permission`), or any one of several (`anyOf`).
 * EVERY screen element sits inside one of these (checked before each commit).
 * Keys must come from src/lib/permissions/catalog.ts.
 */
export default function Can({
  permission,
  anyOf,
  level = 'view',
  children,
  fallback = null,
}: {
  permission?: string
  anyOf?: string[]
  level?: Level
  children: ReactNode
  fallback?: ReactNode
}) {
  const { can, canAny } = usePermissions()
  const ok = (permission ? can(permission, level) : true) && (anyOf ? canAny(anyOf, level) : true)
  return <>{ok ? children : fallback}</>
}
