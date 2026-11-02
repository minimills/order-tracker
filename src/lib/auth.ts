import type { Session } from '@supabase/supabase-js'
import { createContext, useContext } from 'react'

export type AuthState = {
  /** True until we know whether someone is signed in. */
  loading: boolean
  session: Session | null
  /** Whether the signed-in email is in allowed_users. Null while checking. */
  allowed: boolean | null
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState>({
  loading: true,
  session: null,
  allowed: null,
  signOut: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}
