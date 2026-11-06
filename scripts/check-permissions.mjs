#!/usr/bin/env node
/**
 * Permission check (runs before every commit and before every deploy).
 *
 * Fails when:
 *  1. A screen element (any JSX element in src/**.tsx) is not inside
 *     <Can permission="…"> or <Page permission="…"> – unless the whole file is
 *     marked with `// @permission-scope <key>` (a dialog or admin page that is
 *     only reachable through that permission), the element is inside a function
 *     marked `/* @layout-helper *\/` (pure layout that only arranges children;
 *     where it is used is checked) or `/* @rendered-inside-can *\/` (e.g. a table
 *     column's cell renderer, drawn inside that column's <Can>), or the file is
 *     one of the EXEMPT files below.
 *  2. Code (or a database migration from 0018 on) uses a permission key that is
 *     not in src/lib/permissions/catalog.ts.
 *  3. A button, input, select or text box is covered only by a page switch
 *     (catalog items marked `page: true`): controls need their own item.
 *  4. The catalog has a key that nothing in the code uses (so every tick box
 *     in Admin → Users really does something).
 *
 * Run it: npm run check:perms
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rolldown/parseAst'

const root = fileURLToPath(new URL('..', import.meta.url))
const { CATALOG } = await import(join(root, 'src/lib/permissions/catalog.ts'))
const KEYS = new Set(CATALOG.map((i) => i.key))
const PAGE_KEYS = new Set(CATALOG.filter((i) => i.page).map((i) => i.key))
/** Controls that need their own permission item (not just the page's). */
const CONTROLS = new Set(['button', 'input', 'select', 'textarea'])

/** Files with no permission-specific elements, and why. */
const EXEMPT = {
  'src/main.tsx': 'starts the app',
  'src/components/form.tsx': 'shared building blocks; every place they are used is checked',
  'src/components/Can.tsx': 'the permission check itself',
  'src/components/Page.tsx': 'the page permission check and the “You don’t have access” message',
  'src/components/HomeRedirect.tsx': 'sends people to their first allowed page',
  'src/components/RequireAuth.tsx': 'sign-in check (before permissions are known)',
  'src/components/AuthProvider.tsx': 'sign-in state',
  'src/components/PermissionsProvider.tsx': 'loads permissions',
  'src/components/Layout.tsx': 'menu is built from NAV_ITEMS (each item has a permission); menu button and sign-out are for everyone',
  'src/components/ConfirmHost.tsx': 'the shared Confirm / Cancel box; every place that opens it is checked',
  'src/components/PlaceholderPage.tsx': 'layout helper; where it is used is checked',
  'src/components/alerts/AlertsProvider.tsx': 'loads alerts and shows nothing itself (needs alerts.bell; pop-ups need alerts.popups)',
  'src/pages/LoginPage.tsx': 'shown before signing in',
  'src/pages/NotFoundPage.tsx': '“page not found” message',
}

/** Routing elements in App.tsx (each page inside them is wrapped in <Page>). */
const STRUCTURAL = new Set(['Routes', 'Route', 'Navigate', 'Outlet', 'RequireAuth', 'Layout', 'LoginPage', 'HomeRedirect', 'NotFoundPage'])
const COVERING = new Set(['Can', 'Page'])
const KEY_ATTRS = new Set(['permission', 'anyOf'])
const KEY_PROPS = new Set(['permission', 'perm', 'anyOf'])
const KEY_CALLS = new Set(['can', 'canAny', 'allowedBy'])

const errors = []
const used = new Map() // key -> first place it is used

function walkDir(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkDir(p, out)
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p)
  }
  return out
}

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length

function recordKey(key, where) {
  if (!KEYS.has(key)) errors.push(`${where}: "${key}" is not in the permissions catalog (src/lib/permissions/catalog.ts)`)
  else if (!used.has(key)) used.set(key, where)
}

/** String values of a literal, a template without ${}, or an array of those. */
function literals(node) {
  if (!node) return []
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value]
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return [node.quasis[0].value.cooked]
  if (node.type === 'ArrayExpression') return node.elements.flatMap(literals)
  if (node.type === 'JSXExpressionContainer') return literals(node.expression)
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') return literals(node.expression)
  return []
}

function jsxName(n) {
  if (!n) return '?'
  if (n.type === 'JSXIdentifier') return n.name
  if (n.type === 'JSXMemberExpression') return `${jsxName(n.object)}.${jsxName(n.property)}`
  return '?'
}

function checkFile(file) {
  const rel = relative(root, file).replaceAll('\\', '/')
  if (rel === 'src/lib/permissions/catalog.ts') return
  const text = readFileSync(file, 'utf8')
  const isTsx = file.endsWith('.tsx')
  let ast
  try {
    ast = parseAst(text, { lang: isTsx ? 'tsx' : 'ts' })
  } catch (e) {
    errors.push(`${rel}: could not be read (${e.message})`)
    return
  }

  // File-level scope: // @permission-scope key, key2
  const scope = /@permission-scope\s+([^\n*]+)/.exec(text)
  if (scope) for (const k of scope[1].split(/[\s,]+/).filter(Boolean)) recordKey(k, `${rel} (@permission-scope)`)

  // Functions marked /* @layout-helper */ or /* @rendered-inside-can */ (the comment right before them).
  const helperStarts = [...text.matchAll(/\/\*\s*@(?:layout-helper|rendered-inside-can)\s*\*\/\s*/g)].map((m) => m.index + m[0].length)
  const isHelper = (node) => helperStarts.some((s) => node.start >= s && node.start <= s + 30)

  const exempt = EXEMPT[rel] !== undefined
  const checkCoverage = isTsx && rel.startsWith('src/') && !exempt && !scope
  let reported = 0

  // covered: inside a permission; key: the nearest permission key ('' = unknown / scope)
  function visit(node, covered, nearest) {
    if (!node || typeof node.type !== 'string') return
    let cov = covered
    let key = nearest

    if ((node.type === 'FunctionDeclaration' || node.type === 'VariableDeclarator' || node.type === 'ArrowFunctionExpression') && isHelper(node)) {
      cov = true
      key = ''
    }

    if (node.type === 'JSXElement') {
      const name = jsxName(node.openingElement.name)
      const attrs = node.openingElement.attributes.filter((a) => a.type === 'JSXAttribute')
      let hasKeyAttr = false
      let ownKey = ''
      for (const a of attrs) {
        if (!KEY_ATTRS.has(a.name?.name)) continue
        hasKeyAttr = true
        const ks = literals(a.value)
        for (const k of ks) recordKey(k, `${rel}:${lineOf(text, a.start)}`)
        if (a.name.name === 'permission' && ks.length === 1) ownKey = ks[0]
      }
      if (COVERING.has(name) && hasKeyAttr) {
        cov = true
        key = ownKey
      } else if (checkCoverage && cov && CONTROLS.has(name) && PAGE_KEYS.has(key)) {
        errors.push(`${rel}:${lineOf(text, node.start)}: <${name}> is only covered by the page switch "${key}"; give it its own permission item`)
      } else if (checkCoverage && !cov && !STRUCTURAL.has(name)) {
        if (reported < 15) {
          errors.push(`${rel}:${lineOf(text, node.start)}: <${name}> is not inside <Can permission="…">`)
        }
        reported++
      }
    }

    if (node.type === 'CallExpression') {
      const callee = node.callee
      const fname = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property?.name : null
      if (KEY_CALLS.has(fname)) {
        const arg = fname === 'allowedBy' ? node.arguments[1] : node.arguments[0]
        for (const k of literals(arg)) recordKey(k, `${rel}:${lineOf(text, node.start)}`)
      }
    }

    if (node.type === 'Property' && KEY_PROPS.has(node.key?.name ?? node.key?.value)) {
      for (const k of literals(node.value)) recordKey(k, `${rel}:${lineOf(text, node.start)}`)
    }

    for (const [k, v] of Object.entries(node)) {
      if (k === 'parent' || k === 'start' || k === 'end') continue
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && visit(c, cov, key))
      else if (v && typeof v === 'object') visit(v, cov, key)
    }
  }

  visit(ast, false, '')
  if (reported > 15) errors.push(`${rel}: … and ${reported - 15} more elements without a permission`)
}

for (const f of walkDir(join(root, 'src'))) checkFile(f)

// Keys used by the database (migrations from 0018 on) must be in the catalog.
const KEY_LIKE = /'((?:dashboard|orders|order|payments|crating|customer|admin|reports|shop_board|settings|alerts|agent)(?:\.[a-z0-9_]+)+)'|(?:has_perm|require_perm)\('([a-z_]+)'/g
for (const name of readdirSync(join(root, 'supabase/migrations')).sort()) {
  const n = Number(name.slice(0, 4))
  if (!(n >= 18)) continue
  const text = readFileSync(join(root, 'supabase/migrations', name), 'utf8')
  for (const m of text.matchAll(KEY_LIKE)) recordKey(m[1] ?? m[2], `supabase/migrations/${name}:${lineOf(text, m.index)}`)
  for (const m of text.matchAll(/(?:can_admin|require_admin_area)\('([a-z_]+)'\)/g)) {
    recordKey(`admin.${m[1]}`, `supabase/migrations/${name}:${lineOf(text, m.index)}`)
  }
}

// Every catalog key must be used.
for (const item of CATALOG) {
  if (!used.has(item.key)) errors.push(`catalog: "${item.key}" (${item.label}) is not used anywhere in the code`)
}
// requires / needs must point at real keys.
for (const item of CATALOG) {
  for (const k of [item.requires, ...(item.needs ?? [])].filter(Boolean)) {
    if (!KEYS.has(k)) errors.push(`catalog: "${item.key}" refers to unknown key "${k}"`)
  }
}

if (errors.length) {
  console.error(`✗ Permission check failed (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n`)
  for (const e of errors) console.error('  ' + e)
  console.error('\nEvery screen element needs <Can permission="…"> with a key from src/lib/permissions/catalog.ts.')
  process.exit(1)
}
console.log(`✓ Permission check passed: ${KEYS.size} catalog items, all used; every screen element has a permission.`)
