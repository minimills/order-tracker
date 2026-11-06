import { createContext, useContext } from 'react'
import { CATALOG_BY_KEY, type Level } from './catalog'

export type Perms = Record<string, Level>

/**
 * Is this allowed by these permissions? Edit includes view. The item's `requires`
 * (usually its page) and `needs` (data it shows) must be allowed too.
 * Unknown keys are never allowed.
 */
export function allowedBy(perms: Perms, key: string, level: Level = 'view', depth = 0): boolean {
  const item = CATALOG_BY_KEY.get(key)
  if (!item || depth > 10) return false
  const own = perms[key]
  const ok = level === 'edit' ? own === 'edit' : own === 'view' || own === 'edit'
  if (!ok) return false
  if (item.requires && !allowedBy(perms, item.requires, 'view', depth + 1)) return false
  return (item.needs ?? []).every((n) => allowedBy(perms, n, 'view', depth + 1))
}

export type PermissionState = {
  /** True until the signed-in person's permissions are known. */
  loading: boolean
  /** Admins can do everything. */
  isAdmin: boolean
  perms: Perms
  can: (key: string, level?: Level) => boolean
  /** Any of these keys allowed (at this level)? */
  canAny: (keys: string[], level?: Level) => boolean
  reload: () => void
}

export const PermissionsContext = createContext<PermissionState>({
  loading: true,
  isAdmin: false,
  perms: {},
  can: () => false,
  canAny: () => false,
  reload: () => {},
})

/** What the signed-in person may see and do. Use <Can> for screen elements. */
export function usePermissions() {
  return useContext(PermissionsContext)
}
