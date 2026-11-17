/** Light, Dark, System (follows the computer or phone setting) or Glass. */
export type Theme = 'light' | 'dark' | 'system' | 'glass'
/** The colours Glass uses. */
export type GlassBase = 'light' | 'dark' | 'system'

export const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'light', label: 'Light', hint: 'Dark text on a light background.' },
  { value: 'dark', label: 'Dark', hint: 'Light text on a dark background, easier on the eyes at night.' },
  { value: 'system', label: 'System', hint: 'Follows the setting of this computer or phone.' },
  {
    value: 'glass',
    label: 'Glass',
    hint: 'A frosted, see-through menu, top bar, dialogs and widget frames over a soft background. Text, tables and forms stay on solid backgrounds. It turns itself off on slow devices or when the device asks for less transparency or motion.',
  },
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
let base: GlassBase = 'system'
const mq = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null)
const media = mq('(prefers-color-scheme: dark)')
const lessGlass = [mq('(prefers-reduced-transparency: reduce)'), mq('(prefers-reduced-motion: reduce)'), mq('(prefers-contrast: more)')]

/** A small or saving-data device: no blur (it is costly to draw). */
function slowDevice() {
  const n = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  return (n.hardwareConcurrency ?? 8) <= 2 || (n.deviceMemory ?? 8) <= 2 || !!n.connection?.saveData || readLocal('bmm.glasslite') === 'slow'
}

let measured = false
/** Watches the first second of drawing with Glass on; a jerky page turns the blur off for this device. */
function measureOnce() {
  if (measured || typeof requestAnimationFrame === 'undefined') return
  measured = true
  let frames = 0
  const start = performance.now()
  const step = () => {
    frames++
    if (performance.now() - start < 1000) return requestAnimationFrame(step)
    if (frames < 30) {
      writeLocal('bmm.glasslite', 'slow')
      document.documentElement.classList.add('glass-lite')
    }
  }
  requestAnimationFrame(step)
}

function paint() {
  const scheme = current === 'glass' ? base : current
  const dark = scheme === 'dark' || (scheme === 'system' && !!media?.matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('glass', current === 'glass')
  root.classList.toggle('glass-lite', current === 'glass' && (slowDevice() || lessGlass.some((m) => m?.matches)))
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1220' : '#0f172a')
  if (current === 'glass' && !root.classList.contains('glass-lite')) measureOnce()
}
media?.addEventListener('change', () => paint())
for (const m of lessGlass) m?.addEventListener('change', () => paint())

/** Puts the theme on the page (classes "dark", "glass" and "glass-lite" on <html>; see src/dark.css and src/index.css). */
export function applyTheme(theme: Theme, glassBase: GlassBase = 'system') {
  current = theme
  base = glassBase
  paint()
}
