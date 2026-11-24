#!/usr/bin/env node
/**
 * Language check (runs in `npm run build`, the pre-commit hook and the deploy).
 *
 * Fails when:
 *  1. A screen text is typed in English instead of going through tr()
 *     (JSX text, text attributes such as placeholder / title / aria-label /
 *     label, toast / confirmAction / askText / setError / new Error messages,
 *     strings shown from a ternary or ||, and label / title / hint … of data
 *     objects). See scripts/i18n-scan.mjs.
 *  2. A key used with tr('…') / tk('…') (or a permission catalog label,
 *     group or section) is missing in fr-CA, es, ru or de, or a plural key
 *     lacks one of the language's plural forms.
 *
 * Run: npm run check:i18n          (fix: node scripts/i18n-convert.mjs <file>, then translate)
 *      npm run check:i18n -- --list fr-CA   (prints the missing keys of one language)
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceFiles } from './i18n-convert.mjs'
import { keysIn, scan } from './i18n-scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const LANGS = ['fr-CA', 'es', 'ru', 'de']
const read = (lang) => JSON.parse(readFileSync(join(root, 'src/i18n/locales', `${lang}.json`), 'utf8'))
const en = read('en-CA')

let failed = false
const problems = []

// 1. Text typed in English
for (const file of sourceFiles()) {
  for (const f of scan(file, readFileSync(file, 'utf8'))) {
    const text = readFileSync(file, 'utf8')
    const line = text.slice(0, f.start).split('\n').length
    problems.push(`${relative(root, file)}:${line}: “${f.text.slice(0, 70)}” is typed in English (${f.kind}); use tr(…)`)
  }
}

// 2. Keys and their translations
const keys = new Map()
for (const file of sourceFiles()) {
  for (const k of keysIn(file, readFileSync(file, 'utf8'))) {
    const prev = keys.get(k.key)
    keys.set(k.key, { plural: (prev?.plural ?? false) || k.plural, file: prev?.file ?? relative(root, file) })
  }
}
const { CATALOG } = await import(join(root, 'src/lib/permissions/catalog.ts'))
for (const i of CATALOG) for (const k of [i.group, i.section]) if (!keys.has(k)) keys.set(k, { plural: false, file: 'src/lib/permissions/catalog.ts' })

const missing = {}
for (const lang of LANGS) {
  const dict = read(lang)
  const forms = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
  missing[lang] = []
  for (const [key, info] of keys) {
    if (info.plural) {
      for (const f of forms) if (!(`${key}_${f}` in dict)) missing[lang].push(`${key}_${f}`)
    } else if (!(key in dict) || dict[key] === '') missing[lang].push(key)
  }
}
for (const [key, info] of keys) {
  if (!info.plural) continue
  for (const f of new Intl.PluralRules('en-CA').resolvedOptions().pluralCategories) {
    if (!(`${key}_${f}` in en)) problems.push(`en-CA.json: plural form "${key}_${f}" is missing (used in ${info.file})`)
  }
}

const list = process.argv.indexOf('--list')
if (list > 0) {
  const lang = process.argv[list + 1]
  console.log((missing[lang] ?? []).join('\n'))
  process.exit(0)
}

for (const lang of LANGS) {
  if (missing[lang].length) problems.push(`${lang}.json: ${missing[lang].length} texts are not translated, for example “${missing[lang][0]}” (npm run check:i18n -- --list ${lang})`)
}

if (problems.length) {
  failed = true
  console.error(problems.slice(0, 60).join('\n'))
  if (problems.length > 60) console.error(`… and ${problems.length - 60} more.`)
  console.error(`\n✗ Language check failed. Every screen text goes through tr('…') and is translated in en-CA (plurals), fr-CA, es, ru and de (see LANGUAGES in CLAUDE.md).`)
}
if (failed) process.exit(1)
console.log(`✓ Language check passed: ${keys.size} texts, translated in ${LANGS.length + 1} languages.`)
