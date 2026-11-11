/** Light, Dark or System (follows the computer or phone setting). */
export type Theme = 'light' | 'dark' | 'system'

export const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'light', label: 'Light', hint: 'Dark text on a light background.' },
  { value: 'dark', label: 'Dark', hint: 'Light text on a dark background, easier on the eyes at night.' },
  { value: 'system', label: 'System', hint: 'Follows the setting of this computer or phone.' },
]

export function readLocal(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
export function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private window or storage blocked: the database still remembers it.
  }
}

let current: Theme = 'system'
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
function paint() {
  const dark = current === 'dark' || (current === 'system' && !!media?.matches)
  document.documentElement.classList.toggle('dark', dark)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1220' : '#0f172a')
}
media?.addEventListener('change', () => current === 'system' && paint())

/** Puts the theme on the page (the class "dark" on <html>, see src/dark.css). */
export function applyTheme(theme: Theme) {
  current = theme
  paint()
}
