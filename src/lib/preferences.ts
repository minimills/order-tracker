import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAuth } from './auth'
import { friendlyError } from './format'
import { supabase } from './supabase'
import { applyTheme, readLocal, writeLocal, type GlassBase, type Theme } from './theme'
import type { Units } from './units'
import { currentLang, isLang, setLanguage, tr, type Lang } from '../i18n'

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
  /** Light, Dark, System (follows the computer or phone) or Glass. */
  theme: Theme
  /** The colours of Glass: light, dark or as the device. */
  glassBase: GlassBase
  /** Sidebar shows icons only. */
  sidebarCollapsed: boolean
  /** Show computer notifications at all (each type can still be turned off). */
  desktopNotifications: boolean
  /** Shop board: across (rows), list or cards. */
  shopBoardView: ShopBoardView
  /** Shop board: order numbers lowest first (asc) or highest first (desc) (0051). */
  shopBoardSort: 'asc' | 'desc'
  /** The language chosen in Settings (null = not chosen yet). */
  language: Lang | null
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
    glassBase: (p.data?.glass_base as GlassBase | undefined) ?? current.glassBase,
    sidebarCollapsed: (p.data?.sidebar_collapsed as boolean | undefined) ?? current.sidebarCollapsed,
    desktopNotifications: (p.data?.desktop_notifications as boolean | undefined) ?? current.desktopNotifications,
    shopBoardView: (p.data?.shop_board_view as ShopBoardView | undefined) ?? current.shopBoardView,
    shopBoardSort: (p.data?.shop_board_sort as 'asc' | 'desc' | undefined) ?? current.shopBoardSort,
    language: isLang(p.data?.language) ? p.data.language : null,
    loaded: true,
  }
  byEmail.set(email, next)
  saveLocal(units)
  rememberLook(next)
  // The language saved on the profile always wins over this browser's language.
  if (next.language) {
    writeLocal('bmm.lang', next.language)
    if (next.language !== currentLang()) await setLanguage(next.language)
  }
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
    glassBase: (readLocal('bmm.glassbase') as GlassBase | null) ?? 'system',
    sidebarCollapsed: readLocal('bmm.sidebar') === 'collapsed',
    desktopNotifications: readLocal('bmm.desktop') !== 'off',
    shopBoardView: (readLocal('bmm.shopview') as ShopBoardView | null) ?? 'rows',
    shopBoardSort: readLocal('bmm.shopsort') === 'desc' ? 'desc' : 'asc',
    language: null,
    loaded: false,
  }
}
function rememberLook(p: Prefs) {
  writeLocal('bmm.theme', p.theme)
  writeLocal('bmm.glassbase', p.glassBase)
  writeLocal('bmm.sidebar', p.sidebarCollapsed ? 'collapsed' : 'open')
  writeLocal('bmm.desktop', p.desktopNotifications ? 'on' : 'off')
  writeLocal('bmm.shopview', p.shopBoardView)
  writeLocal('bmm.shopsort', p.shopBoardSort)
  applyTheme(p.theme, p.glassBase)
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
    if (error) toast.error(`${tr('Could not remember your choice:')} ${friendlyError(error)}`)
  }

  /** Sets my own start page (needs "settings.start_page"). */
  async function setStartPage(page: string | null) {
    if (!email) return
    const { error } = await supabase!.rpc('set_start_page', { p_email: email, p_page: page })
    if (error) return toast.error(friendlyError(error))
    byEmail.set(email, { ...prefs, startPage: page })
    emit()
    toast.success(tr('Start page saved.'))
  }

  /** Saves theme / sidebar / desktop choices for me (shown straight away, then saved). */
  async function setLook(patch: Partial<Pick<Prefs, 'theme' | 'glassBase' | 'sidebarCollapsed' | 'desktopNotifications' | 'shopBoardView' | 'shopBoardSort'>>) {
    const next = { ...prefs, ...patch }
    if (email) byEmail.set(email, next)
    else Object.assign(fallback, patch)
    rememberLook(next)
    emit()
    if (!email || !supabase) return
    const p: Record<string, unknown> = {}
    if (patch.theme) p.theme = patch.theme
    if (patch.glassBase) p.glass_base = patch.glassBase
    if (patch.sidebarCollapsed !== undefined) p.sidebar_collapsed = patch.sidebarCollapsed
    if (patch.desktopNotifications !== undefined) p.desktop_notifications = patch.desktopNotifications
    if (patch.shopBoardView) p.shop_board_view = patch.shopBoardView
    if (patch.shopBoardSort) p.shop_board_sort = patch.shopBoardSort
    const { error } = await supabase.rpc('set_my_preferences', { p })
    if (error) toast.error(`${tr('Could not remember your choice:')} ${friendlyError(error)}`)
  }

  /** Switches every screen to this language now, and saves it on my profile (any device). */
  async function setMyLanguage(language: Lang) {
    await setLanguage(language)
    writeLocal('bmm.lang', language)
    if (email) byEmail.set(email, { ...prefs, language })
    emit()
    if (!email || !supabase) return
    const { error } = await supabase.rpc('set_my_preferences', { p: { language } })
    if (error) toast.error(`${tr('Could not remember your choice:')} ${friendlyError(error)}`)
  }

  return {
    language: prefs.language,
    setMyLanguage,
    units: prefs.units,
    theme: prefs.theme,
    glassBase: prefs.glassBase,
    sidebarCollapsed: prefs.sidebarCollapsed,
    desktopNotifications: prefs.desktopNotifications,
    shopBoardView: prefs.shopBoardView,
    shopBoardSort: prefs.shopBoardSort,
    setLook,
    myName: prefs.name ?? email,
    startPage: prefs.startPage,
    loaded: prefs.loaded || !email,
    setUnits,
    setStartPage,
  }
}
