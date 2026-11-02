import type { Session } from '@supabase/supabase-js'
import { useEffect, useState, type ReactNode } from 'react'
import { AuthContext } from '../lib/auth'
import { supabase } from '../lib/supabase'

/** Keeps track of who is signed in and whether they are on the allowed list. */
export default function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(Boolean(supabase))
  const [session, setSession] = useState<Session | null>(null)
  // Result of the allowed-list check, remembered per email.
  const [check, setCheck] = useState<{ email: string; allowed: boolean } | null>(null)

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
    supabase.rpc('is_allowed_user').then(({ data, error }) => {
      if (!cancelled) setCheck({ email, allowed: !error && data === true })
    })
    return () => {
      cancelled = true
    }
  }, [email])
  const allowed = email && check?.email === email ? check.allowed : null

  const signOut = async () => {
    await supabase?.auth.signOut()
  }

  return <AuthContext.Provider value={{ loading, session, allowed, signOut }}>{children}</AuthContext.Provider>
}
