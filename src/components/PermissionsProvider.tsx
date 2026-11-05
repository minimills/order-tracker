import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { allowedBy, PermissionsContext, type Perms } from '../lib/permissions'
import type { Level } from '../lib/permissions/catalog'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

/** Loads the signed-in person's permissions (admins can do everything). */
export default function PermissionsProvider({ children }: { children: ReactNode }) {
  const { session, role } = useAuth()
  const email = session?.user.email ?? null
  const [loaded, setLoaded] = useState<{ email: string; perms: Perms } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!supabase || !email || role !== 'staff') return
    let cancelled = false
    supabase.rpc('my_permissions').then(({ data }) => {
      if (!cancelled) setLoaded({ email, perms: (data as Perms | null) ?? {} })
    })
    return () => {
      cancelled = true
    }
  }, [email, role, reloadKey])

  // Without a database (first set-up) everything shows, so the warning can be read.
  const isAdmin = role === 'admin' || !isSupabaseConfigured
  const perms = loaded && loaded.email === email ? loaded.perms : null
  const loading = !isAdmin && (role === null || perms === null)
  const can = useCallback(
    (key: string, level: Level = 'view') => isAdmin || (perms !== null && allowedBy(perms, key, level)),
    [isAdmin, perms],
  )
  const canAny = useCallback((keys: string[], level: Level = 'view') => keys.some((k) => can(k, level)), [can])

  return (
    <PermissionsContext.Provider
      value={{ loading, isAdmin, perms: perms ?? {}, can, canAny, reload: () => setReloadKey((k) => k + 1) }}
    >
      {children}
    </PermissionsContext.Provider>
  )
}
