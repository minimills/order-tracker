import type { Session } from '@supabase/supabase-js'
import { useEffect, useState, type ReactNode } from 'react'
import { AuthContext, type Role } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { browserLang, isLang, setLanguage } from '../i18n'
import { readLocal } from '../lib/theme'

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
    const read = async () => {
      const { data, error } = await supabase!.rpc('current_user_role')
      return !error && (data === 'admin' || data === 'staff') ? (data as Role) : null
    }
    ;(async () => {
      let role = await read()
      if (role === null) {
        // A sign-in email change confirmed at both addresses is finished here (migration 0043).
        const { data: applied } = await supabase!.rpc('apply_my_email_change')
        if (applied === true) role = await read()
      }
      if (!cancelled) setCheck({ email, role })
    })()
    return () => {
      cancelled = true
    }
  }, [email])
  const checked = email !== null && check?.email === email
  const role = checked ? check.role : null
  const allowed = checked ? role !== null : null

  const signOut = async () => {
    await supabase?.auth.signOut()
    // The sign-in page uses this device's own choice (or the browser's language), not the last person's.
    try {
      localStorage.removeItem('bmm.lang')
    } catch {
      // storage blocked
    }
    const own = readLocal('bmm.lang.signin')
    setLanguage(isLang(own) ? own : browserLang())
  }

  return <AuthContext.Provider value={{ loading, session, allowed, role, isAdmin: role === 'admin', signOut }}>{children}</AuthContext.Provider>
}
