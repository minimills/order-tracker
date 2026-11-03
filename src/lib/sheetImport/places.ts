/**
 * The sheet has "Customer, Country", but often the last part is a US state or a
 * Canadian province ("Maine", "NY", "BC - Canada", "Ontario (CA)").
 * These lists turn that into a country plus a state/province.
 */
const US: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
}
const CA: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  PEI: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
}
const COUNTRY_WORDS: Record<string, string> = {
  canada: 'Canada', ca: 'Canada', can: 'Canada',
  usa: 'USA', us: 'USA', 'u.s.': 'USA', 'u.s.a.': 'USA', 'united states': 'USA', 'united states of america': 'USA',
}

const norm = (s: string) => s.toLowerCase().replace(/[.\s]+/g, ' ').trim()
const byName = (list: Record<string, string>) => {
  const m = new Map<string, string>()
  for (const [abbr, name] of Object.entries(list)) {
    m.set(norm(abbr), abbr)
    m.set(norm(name), abbr)
  }
  m.set('quebec', 'QC')
  m.set('québec', 'QC')
  return m
}
const US_NAMES = byName(US)
const CA_NAMES = byName(CA)

export type Place = { country: string | null; state: string | null; note: string | null }

/** "Maine" → USA / ME; "BC - Canada" → Canada / BC; "Ontario (CA)" → Canada / ON; "Iceland" → Iceland. */
export function readPlace(raw: string): Place {
  const text = raw.trim()
  if (!text) return { country: null, state: null, note: null }
  const parts = text
    .split(/[-–(),/]+|\.\s+/)
    .map((p) => p.trim().replace(/\.$/, ''))
    .filter(Boolean)
  let country: string | null = null
  let state: string | null = null
  for (const p of parts) {
    const n = norm(p)
    if (CA_NAMES.has(n) && !(n === 'ca' && parts.length === 1)) {
      // "CA" alone is ambiguous; handled below
      state = CA_NAMES.get(n)!
      country = country ?? 'Canada'
      continue
    }
    if (COUNTRY_WORDS[n] && !(n === 'ca' && parts.length === 1)) {
      country = COUNTRY_WORDS[n]
      continue
    }
    if (US_NAMES.has(n) && n !== 'ca') {
      state = US_NAMES.get(n)!
      country = country ?? 'USA'
      continue
    }
  }
  if (parts.length === 1 && norm(parts[0]) === 'ca') {
    return { country: 'CA', state: null, note: '"CA" could mean California or Canada; saved as "CA". Please check.' }
  }
  if (state && country) {
    const pretty = country === 'USA' ? US[state] : CA[state]
    return { country, state, note: `"${text}" read as ${pretty ?? state}, ${country}.` }
  }
  if (country) return { country, state: null, note: null }
  return { country: text, state: null, note: null }
}
