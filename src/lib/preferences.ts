import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAuth } from './auth'
import { friendlyError } from './format'
import { supabase } from './supabase'
import type { Units } from './units'

/**
 * Each person's own preferences (saved in the user_preferences table, and kept
 * in this browser too so the right units show straight away).
 * Also gives the person's name from allowed_users, used as a default ("Crated by").
 */
type Prefs = { units: Units; name: string | null }

const LOCAL_KEY = 'bmm.units'
const byEmail = new Map<string, Prefs>()
const loading = new Set<string>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function localUnits(): Units {
  try {
    return localStorage.getItem(LOCAL_KEY) === 'metric' ? 'metric' : 'imperial'
  } catch {
    return 'imperial'
  }
}

function saveLocal(units: Units) {
  try {
    localStorage.setItem(LOCAL_KEY, units)
  } catch {
    // Private window or storage blocked: the database still remembers it.
  }
}

async function load(email: string) {
  if (!supabase || loading.has(email)) return
  loading.add(email)
  const [p, u] = await Promise.all([
    supabase.from('user_preferences').select('units').eq('user_email', email).maybeSingle(),
    supabase.from('allowed_users').select('name').eq('email', email).maybeSingle(),
  ])
  const current = byEmail.get(email) ?? { units: localUnits(), name: null }
  const units = (p.data?.units as Units | undefined) ?? current.units
  byEmail.set(email, { units, name: (u.data?.name as string | null) ?? null })
  saveLocal(units)
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const fallback: Prefs = { units: localUnits(), name: null }

export function usePreferences() {
  const { session } = useAuth()
  const email = session?.user.email?.toLowerCase() ?? null
  const prefs = useSyncExternalStore(subscribe, () => (email && byEmail.get(email)) || fallback)

  useEffect(() => {
    if (email) load(email)
  }, [email])

  async function setUnits(units: Units) {
    if (!email) return
    byEmail.set(email, { ...prefs, units })
    saveLocal(units)
    emit()
    const { error } = await supabase!.rpc('set_my_units', { p_units: units })
    if (error) toast.error(`Could not remember your choice: ${friendlyError(error)}`)
  }

  return { units: prefs.units, myName: prefs.name ?? email, setUnits }
}
