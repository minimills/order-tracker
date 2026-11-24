#!/usr/bin/env node
/**
 * One-time (and repeatable) conversion: wraps interface text found by
 * scripts/i18n-scan.mjs in tr() and adds the import. Run: node scripts/i18n-convert.mjs [files…]
 * Review the result; `npm run check:i18n` lists what is left.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEdits, scan } from './i18n-scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
export function sourceFiles() {
  const files = []
  const w = (d) =>
    readdirSync(d).forEach((f) => {
      const p = join(d, f)
      if (statSync(p).isDirectory()) return f !== 'i18n' && w(p)
      if (/\.tsx?$/.test(f) && !f.endsWith('.d.ts')) files.push(p)
    })
  w(src)
  return files
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

function main() {
const targets = process.argv.slice(2).length ? process.argv.slice(2).map((f) => join(root, f)) : sourceFiles()
let changed = 0
for (const file of targets) {
  const text = readFileSync(file, 'utf8')
  let edits = scan(file, text).filter((e) => e.replacement !== null)
  if (!edits.length) continue
  const isCatalog = file.endsWith('lib/permissions/catalog.ts')
  if (isCatalog) {
    edits = edits.map((e) => (e.kind === 'data' || e.kind === 'prose' ? { ...e, replacement: text.slice(e.start, e.end).replace(/:\s*(['"`])[\s\S]*\1\s*$/, `: tk(${JSON.stringify(e.text)})`) } : e))
  }
  let out = applyEdits(text, edits)
  const need = ['tr', 'tk'].filter((n) => new RegExp(`\\b${n}\\(`).test(out))
  const rel = relative(dirname(file), join(src, 'i18n')).replace(/\\/g, '/')
  const spec = rel.startsWith('.') ? rel : `./${rel}`
  const existing = out.match(new RegExp(`import \\{([^}]*)\\} from '${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  if (existing) {
    const names = new Set(existing[1].split(',').map((s) => s.trim()).filter(Boolean))
    need.forEach((n) => names.add(n))
    out = out.replace(existing[0], `import { ${[...names].join(', ')} } from '${spec}'`)
  } else if (need.length) {
    const lines = out.split('\n')
    let last = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^import\b/.test(lines[i])) {
        last = i
        while (last < lines.length - 1 && !/from\s+['"].*['"]\s*;?\s*$|^import\s+['"].*['"]\s*;?\s*$/.test(lines[last])) last++
        i = last
      } else if (last >= 0 && lines[i].trim() && !/^\s*(\/\/|\/\*|\*)/.test(lines[i])) break
    }
    const at = last >= 0 ? last + 1 : lines[0].startsWith('// @permission-scope') ? 1 : 0
    lines.splice(at, 0, `import { ${need.join(', ')} } from '${spec}'`)
    out = lines.join('\n')
  }
  writeFileSync(file, out)
  changed++
}
console.log(`Converted ${changed} files.`)
}
