import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAuth } from './auth'
import { friendlyError } from './format'
import { supabase } from './supabase'
import { applyTheme, readLocal, writeLocal, type Theme } from './theme'
import type { Units } from './units'

export type ShopBoardView = 'rows' | 'list' | 'cards'

/**
 * Each person's own preferences (saved in the user_preferences table, and kept
 * in this browser too so the right units show straight away).
 * Also gives the person's name from allowed_users, used as a default ("Crated by").
 */
type Prefs = {
  units: Units
  name: string | null
  /** The page to open after signing in (null = first allowed page). */
  startPage: string | null
  /** Light, Dark or System (follows the computer or phone). */
  theme: Theme
  /** Sidebar shows icons only. */
  sidebarCollapsed: boolean
  /** Show computer notifications at all (each type can still be turned off). */
  desktopNotifications: boolean
  /** Shop board: across (rows), list or cards. */
  shopBoardView: ShopBoardView
  /** True once the database has answered. */
  loaded: boolean
}

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
    // select * so this still works before migration 0036 adds theme / sidebar / desktop.
    supabase.from('user_preferences').select('*').eq('user_email', email).maybeSingle(),
    supabase.from('allowed_users').select('name').eq('email', email).maybeSingle(),
  ])
  const current = byEmail.get(email) ?? localPrefs()
  const units = (p.data?.units as Units | undefined) ?? current.units
  const next: Prefs = {
    units,
    name: (u.data?.name as string | null) ?? null,
    startPage: (p.data?.start_page as string | null) ?? null,
    theme: (p.data?.theme as Theme | undefined) ?? current.theme,
    sidebarCollapsed: (p.data?.sidebar_collapsed as boolean | undefined) ?? current.sidebarCollapsed,
    desktopNotifications: (p.data?.desktop_notifications as boolean | undefined) ?? current.desktopNotifications,
    shopBoardView: (p.data?.shop_board_view as ShopBoardView | undefined) ?? current.shopBoardView,
    loaded: true,
  }
  byEmail.set(email, next)
  saveLocal(units)
  rememberLook(next)
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The look is also kept in this browser, so the right theme shows before the database answers. */
function localPrefs(): Prefs {
  return {
    units: localUnits(),
    name: null,
    startPage: null,
    theme: (readLocal('bmm.theme') as Theme | null) ?? 'system',
    sidebarCollapsed: readLocal('bmm.sidebar') === 'collapsed',
    desktopNotifications: readLocal('bmm.desktop') !== 'off',
    shopBoardView: (readLocal('bmm.shopview') as ShopBoardView | null) ?? 'rows',
    loaded: false,
  }
}
function rememberLook(p: Prefs) {
  writeLocal('bmm.theme', p.theme)
  writeLocal('bmm.sidebar', p.sidebarCollapsed ? 'collapsed' : 'open')
  writeLocal('bmm.desktop', p.desktopNotifications ? 'on' : 'off')
  writeLocal('bmm.shopview', p.shopBoardView)
  applyTheme(p.theme)
}

const fallback: Prefs = localPrefs()

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

  /** Sets my own start page (needs "settings.start_page"). */
  async function setStartPage(page: string | null) {
    if (!email) return
    const { error } = await supabase!.rpc('set_start_page', { p_email: email, p_page: page })
    if (error) return toast.error(friendlyError(error))
    byEmail.set(email, { ...prefs, startPage: page })
    emit()
    toast.success('Start page saved.')
  }

  /** Saves theme / sidebar / desktop choices for me (shown straight away, then saved). */
  async function setLook(patch: Partial<Pick<Prefs, 'theme' | 'sidebarCollapsed' | 'desktopNotifications' | 'shopBoardView'>>) {
    const next = { ...prefs, ...patch }
    if (email) byEmail.set(email, next)
    else Object.assign(fallback, patch)
    rememberLook(next)
    emit()
    if (!email || !supabase) return
    const p: Record<string, unknown> = {}
    if (patch.theme) p.theme = patch.theme
    if (patch.sidebarCollapsed !== undefined) p.sidebar_collapsed = patch.sidebarCollapsed
    if (patch.desktopNotifications !== undefined) p.desktop_notifications = patch.desktopNotifications
    if (patch.shopBoardView) p.shop_board_view = patch.shopBoardView
    const { error } = await supabase.rpc('set_my_preferences', { p })
    if (error) toast.error(`Could not remember your choice: ${friendlyError(error)}`)
  }

  return {
    units: prefs.units,
    theme: prefs.theme,
    sidebarCollapsed: prefs.sidebarCollapsed,
    desktopNotifications: prefs.desktopNotifications,
    shopBoardView: prefs.shopBoardView,
    setLook,
    myName: prefs.name ?? email,
    startPage: prefs.startPage,
    loaded: prefs.loaded || !email,
    setUnits,
    setStartPage,
  }
}
