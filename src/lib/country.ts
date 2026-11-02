/**
 * Turns a country name typed by a person ("Canada", "USA", "UK") into a flag
 * emoji. Uses the browser's own list of country names, so nothing is
 * hard-coded except a few common short forms.
 */
const aliases: Record<string, string> = {
  usa: 'US',
  us: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  'united states of america': 'US',
  uk: 'GB',
  'u.k.': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  holland: 'NL',
  'the netherlands': 'NL',
  'czech republic': 'CZ',
  'south korea': 'KR',
  korea: 'KR',
  russia: 'RU',
  'new zealand': 'NZ',
  nz: 'NZ',
}

let byName: Map<string, string> | null = null

function nameMap() {
  if (byName) return byName
  byName = new Map()
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    const A = 65
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(A + i, A + j)
        const name = names.of(code)
        if (name && name !== code) byName.set(name.toLowerCase(), code)
      }
    }
  } catch {
    // Very old browser: no flags, names still show.
  }
  return byName
}

export function countryCode(country: string | null | undefined) {
  if (!country) return null
  const key = country.trim().toLowerCase()
  if (!key) return null
  if (aliases[key]) return aliases[key]
  if (/^[a-z]{2}$/.test(key)) return key.toUpperCase()
  return nameMap().get(key) ?? null
}

export function countryFlag(country: string | null | undefined) {
  const code = countryCode(country)
  if (!code) return ''
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}
