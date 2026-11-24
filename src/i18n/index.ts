/**
 * THE translation setup (see "LANGUAGES" in CLAUDE.md). Every text people see
 * goes through `tr()`:
 *
 *   tr('Save Changes')
 *   tr('Order {{number}} was shipped.', { number: '86' })
 *   tr('{{count}} runs', { count: n })        // plural forms per language
 *
 * The key is the Canadian English text itself, so English needs no file
 * (only plural forms live in en-CA.json). The other languages are in
 * src/i18n/locales/<code>.json, loaded when they are chosen. A missing
 * translation shows the English text, never an empty space.
 *
 * Texts that are declared in data (menus, lists) and shown later are marked
 * with `tk('…')` (returns the text unchanged) and shown with `tr(item.label)`.
 *
 * `npm run check:i18n` (also in `npm run build`) fails when a screen text is
 * typed in English without tr(), or when a key is missing in a language.
 */
import { useSyncExternalStore } from 'react'
import enCA from './locales/en-CA.json'

export const LANGUAGES = [
  { code: 'en-CA', name: 'English (Canada)' },
  { code: 'fr-CA', name: 'Français (Canada)' },
  { code: 'es', name: 'Español' },
  { code: 'ru', name: 'Русский' },
  { code: 'de', name: 'Deutsch' },
] as const
export type Lang = (typeof LANGUAGES)[number]['code']
export const DEFAULT_LANG: Lang = 'en-CA'
export const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.code === v)

type Dict = Record<string, string>
const loaders: Record<string, () => Promise<{ default: Dict }>> = {
  './locales/fr-CA.json': () => import('./locales/fr-CA.json'),
  './locales/es.json': () => import('./locales/es.json'),
  './locales/ru.json': () => import('./locales/ru.json'),
  './locales/de.json': () => import('./locales/de.json'),
}
const loaded: Partial<Record<Lang, Dict>> = { 'en-CA': enCA as Dict }

let current: Lang = DEFAULT_LANG
let dict: Dict = enCA as Dict
let plurals = new Intl.PluralRules(DEFAULT_LANG)
const listeners = new Set<() => void>()

/** The language the screens use now. */
export const currentLang = () => current

async function dictionary(lang: Lang): Promise<Dict> {
  if (loaded[lang]) return loaded[lang]!
  const load = loaders[`./locales/${lang}.json`]
  const d = load ? (await load()).default : {}
  loaded[lang] = d
  return d
}

/** Switches every screen to this language (no reload; the screens draw again). */
export async function setLanguage(lang: Lang) {
  const d = await dictionary(isLang(lang) ? lang : DEFAULT_LANG)
  if (lang === current && d === dict) return
  current = isLang(lang) ? lang : DEFAULT_LANG
  dict = d
  plurals = new Intl.PluralRules(current)
  if (typeof document !== 'undefined') document.documentElement.lang = current
  listeners.forEach((l) => l())
}

/** Re-renders when the language changes. Returns the current language. */
export function useLanguage(): Lang {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

/** Marks a text declared in data as a translation key (shown later with tr()). */
export const tk = <S extends string>(text: S): S => text

const fill = (text: string, vars?: Record<string, unknown>) =>
  vars ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))) : text

/** Translates a text (its Canadian English wording is the key). */
export function tr(key: string, vars?: Record<string, unknown>): string {
  if (!key) return key
  if (vars && typeof vars.count === 'number') {
    const form = plurals.select(vars.count as number)
    const text =
      dict[`${key}_${form}`] ?? dict[`${key}_other`] ?? (enCA as Dict)[`${key}_${new Intl.PluralRules('en-CA').select(vars.count as number)}`] ?? (enCA as Dict)[`${key}_other`] ?? key
    return fill(text, { ...vars, count: formatNumber(vars.count as number) })
  }
  return fill(dict[key] ?? key, vars)
}

/** The language the browser asks for, if we have it (used before signing in). */
export function browserLang(): Lang {
  const wanted = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language]
  for (const w of wanted) {
    if (!w) continue
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === w.toLowerCase())
    if (exact) return exact.code
    const base = w.slice(0, 2).toLowerCase()
    const near = LANGUAGES.find((l) => l.code.slice(0, 2) === base)
    if (near) return near.code
  }
  return DEFAULT_LANG
}

/** Numbers in the current language: 1,234.5 / 1 234,5 / 1.234,5. */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(current, options).format(n)
}

/** Money in the current language: $1,234.50 CAD / 1 234,50 $ CA. */
export function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat(current, { style: 'currency', currency, currencyDisplay: current === 'en-CA' ? 'code' : 'symbol' }).format(amount)
}

/** A date / time formatter that always uses the current language (Halifax time zone set by the caller). */
export function dtf(options: Intl.DateTimeFormatOptions) {
  return {
    format: (d: Date | number) => new Intl.DateTimeFormat(current, options).format(d),
    formatToParts: (d: Date | number) => new Intl.DateTimeFormat(current, options).formatToParts(d),
  }
}
