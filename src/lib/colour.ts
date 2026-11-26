/**
 * Colour codes for the full colour picker: HEX ↔ RGB ↔ CMYK ↔ HSV, and the
 * recently used colours (per person, in this browser only).
 */

export type Rgb = { r: number; g: number; b: number }
export type Cmyk = { c: number; m: number; y: number; k: number }
export type Hsv = { h: number; s: number; v: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** "#AbC", "abc", "#aabbcc" → "#aabbcc"; anything else → null. */
export function normalizeHex(text: string): string | null {
  let t = text.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(t)) t = t.split('').map((c) => c + c).join('')
  return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : null
}

export const isHex = (text: string | null | undefined) => !!text && /^#[0-9a-fA-F]{6}$/.test(text)

export function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(hex) ?? '#000000'
  return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const p = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return `#${p(r)}${p(g)}${p(b)}`
}

/** CMYK in whole percent (0–100), the usual print notation. */
export function rgbToCmyk({ r, g, b }: Rgb): Cmyk {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const k = 1 - Math.max(rr, gg, bb)
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 }
  const pct = (x: number) => Math.round(((1 - x - k) / (1 - k)) * 100)
  return { c: pct(rr), m: pct(gg), y: pct(bb), k: Math.round(k * 100) }
}

export function cmykToRgb({ c, m, y, k }: Cmyk): Rgb {
  const kk = clamp(k, 0, 100) / 100
  const ch = (x: number) => Math.round(255 * (1 - clamp(x, 0, 100) / 100) * (1 - kk))
  return { r: ch(c), g: ch(m), b: ch(y) }
}

/** h 0–360, s and v 0–1. */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const [r1, g1, b1] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  const m = v - c
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) }
}

/** Mix a colour with white (amount 0–1), for paper tints of custom note colours. */
export function tint(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex({ r: r + (255 - r) * amount, g: g + (255 - g) * amount, b: b + (255 - b) * amount })
}

/** Darken a colour (amount 0–1), for edges. */
export function shade(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex)
  return rgbToHex({ r: r * (1 - amount), g: g * (1 - amount), b: b * (1 - amount) })
}

// ---------------------------------------------------------------------------
// Recently used colours (a per-viewer convenience: localStorage only)
// ---------------------------------------------------------------------------
const RECENT_KEY = 'bmm.recentColours'
const RECENT_MAX = 10

export function recentColours(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string' && isHex(c)).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function rememberColour(hex: string) {
  const h = normalizeHex(hex)
  if (!h) return
  try {
    const next = [h, ...recentColours().filter((c) => c !== h)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Private window or blocked storage: the list just is not remembered.
  }
}
