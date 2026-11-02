import type { Session } from '@supabase/supabase-js'
import { createContext, useContext } from 'react'

export type Role = 'admin' | 'staff'

export type AuthState = {
  /** True until we know whether someone is signed in. */
  loading: boolean
  session: Session | null
  /** Whether the signed-in email is in allowed_users. Null while checking. */
  allowed: boolean | null
  /** 'admin' or 'staff' from allowed_users; null if not allowed or still checking. */
  role: Role | null
  /** Admins may delete, and change machine types, dropdown lists, settings and users. */
  isAdmin: boolean
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState>({
  loading: true,
  session: null,
  allowed: null,
  role: null,
  isAdmin: false,
  signOut: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}
