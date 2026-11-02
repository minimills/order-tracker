import type { Session } from '@supabase/supabase-js'
import { useEffect, useState, type ReactNode } from 'react'
import { AuthContext, type Role } from '../lib/auth'
import { supabase } from '../lib/supabase'

/** Keeps track of who is signed in and whether they are on the allowed list. */
export default function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(Boolean(supabase))
  const [session, setSession] = useState<Session | null>(null)
  // Result of the allowed-list check, remembered per email.
  const [check, setCheck] = useState<{ email: string; role: Role | null } | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setLoading(false)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const email = session?.user.email ?? null
  useEffect(() => {
    if (!supabase || !email) return
    let cancelled = false
    supabase.rpc('current_user_role').then(({ data, error }) => {
      const role = !error && (data === 'admin' || data === 'staff') ? (data as Role) : null
      if (!cancelled) setCheck({ email, role })
    })
    return () => {
      cancelled = true
    }
  }, [email])
  const checked = email !== null && check?.email === email
  const role = checked ? check.role : null
  const allowed = checked ? role !== null : null

  const signOut = async () => {
    await supabase?.auth.signOut()
  }

  return <AuthContext.Provider value={{ loading, session, allowed, role, isAdmin: role === 'admin', signOut }}>{children}</AuthContext.Provider>
}
