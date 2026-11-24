/**
 * Finds interface text typed in English in a .ts / .tsx file (shared by
 * `npm run check:i18n` and the one-time conversion in scripts/i18n-convert.mjs).
 *
 * Interface text = JSX text, text attributes (placeholder, title, aria-label,
 * label, hint …), the message of toast / confirmAction / askText / setError /
 * new Error, strings in an "output position" inside JSX (a ternary or ||
 * branch, a template), and text properties of data objects (label: '…').
 * Comparisons (x === 'Shipped'), keys, ids and class names are never text.
 *
 * Each finding has { start, end, text, replacement, kind } (UTF-16 offsets).
 */
import { parseAst } from 'rolldown/parseAst'

export const TEXT_ATTRS = new Set([
  'placeholder', 'title', 'aria-label', 'alt', 'label', 'hint', 'description', 'subtitle', 'heading', 'caption',
  'tooltip', 'legend', 'emptyText', 'empty', 'confirmLabel', 'aria-description', 'aria-roledescription', 'what', 'note',
])
export const DATA_KEYS = new Set(['label', 'title', 'hint', 'description', 'text', 'heading', 'placeholder', 'help', 'empty', 'emptyText', 'confirmLabel', 'caption', 'subtitle', 'unitLabel', 'short', 'long'])
const TOAST = new Set(['success', 'error', 'info', 'warning', 'message', 'loading'])
const MESSAGE_FNS = new Set(['confirmAction', 'askText', 'setError', 'setMessage', 'setProblem', 'setNotice', 'setWarning', 'setStatusText'])
/** Calls whose object arguments are data for the database, never shown text. */
const DB_CALLS = new Set(['insert', 'update', 'upsert', 'rpc', 'eq', 'neq', 'in', 'match', 'select', 'order', 'from', 'filter', 'callFunction', 'adminUsers', 'invoke'])

/** Proper names and codes that stay as they are in every language. */
export const KEEP = new Set([
  'Belfast Mini Mills', 'BMM', 'CSV', 'PDF', 'ZIP', 'iCal', 'webcal', 'Google Calendar', 'Apple Calendar', 'Outlook', 'iCloud', 'Supabase',
  'Gmail', 'SMTP', 'IMAP', 'VAPID', 'CE', 'EU', 'EC', 'PEI', 'CAD', 'USD', 'LTL', 'FTL', 'LCL', 'FCL', 'SSL', 'STARTTLS', 'TLS', 'HostGator',
  'Livingston', 'iPhone', 'Android', 'Chrome', 'Safari', 'Firefox', 'Edge', 'Excel', 'Ankit Luthra', 'DoC', 'JSON', 'URL', 'API', 'pg_cron', 'pg_net',
])

const LETTERS = /[A-Za-zÀ-ÿ]{2}/
const CODE_LIKE = /^(?=.*[_.:/#?=&@+\d-])[a-z0-9_.:/#?=&@+-]*$/ // ids, keys, routes, class names (a plain lowercase word shown on screen is text)
const URL_LIKE = /^(https?:|mailto:|tel:|\/|#|\.\/)/

/** Is this string interface text (worth translating)? */
export function isText(raw) {
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s || !LETTERS.test(s)) return false
  if (CODE_LIKE.test(s) || URL_LIKE.test(s)) return false
  if (KEEP.has(s)) return false
  if (/^[A-Z0-9_]+$/.test(s) && s.length <= 4) return false // codes such as LCR, OK-ish abbreviations
  if (/^\{[\w.]+\}$/.test(s)) return false
  if (/^[\w-]+\.(png|jpe?g|svg|pdf|csv|json|ics|zip|xlsx)$/i.test(s)) return false
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return false
  return true
}

const quote = (s) => JSON.stringify(s)

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&times;': '×', '&middot;': '·', '&rarr;': '→', '&larr;': '←' }
const decode = (s) => s.replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e)

function walk(node, parent, fn) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const n of node) walk(n, parent, fn)
    return
  }
  if (typeof node.type !== 'string') return
  node.parent = parent
  fn(node)
  for (const k of Object.keys(node)) {
    if (k === 'parent') continue
    const v = node[k]
    if (v && typeof v === 'object') walk(v, node, fn)
  }
}

const unwrap = (n) => {
  while (n && ['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression', 'TSNonNullExpression'].includes(n.type)) n = n.expression
  return n
}

/** Name for a template variable: the identifier or the last property name. */
function varName(expr, used) {
  const e = unwrap(expr)
  let base =
    e.type === 'Identifier' ? e.name : e.type === 'MemberExpression' && !e.computed && e.property?.name ? e.property.name : e.type === 'CallExpression' && e.callee?.type === 'Identifier' ? e.callee.name : 'value'
  base = base.replace(/[^A-Za-z0-9_]/g, '') || 'value'
  if (base === 'count') base = 'number' // count = plural forms in tr()
  let name = base
  let i = 2
  while (used.has(name)) name = `${base}${i++}`
  used.add(name)
  return name
}

/**
 * Edits for a value in an output position (shown as text). Returns a list of
 * {start, end, text, replacement}. Template literals with expressions become
 * tr('… {{name}} …', { name: expr }).
 */
function outputEdits(src, node, kind) {
  const n = unwrap(node)
  if (!n) return []
  if (n.type === 'Literal' && typeof n.value === 'string') {
    return isText(n.value) ? [{ start: n.start, end: n.end, text: n.value, replacement: `tr(${quote(n.value)})`, kind }] : []
  }
  if (n.type === 'TemplateLiteral') {
    const cooked = n.quasis.map((q) => q.value.cooked ?? q.value.raw)
    const plain = cooked.join(' ')
    if (n.expressions.length === 0) {
      const text = cooked.join('')
      return isText(text) ? [{ start: n.start, end: n.end, text, replacement: `tr(${quote(text)})`, kind }] : []
    }
    if (!isText(plain)) {
      // only placeholders and punctuation: translate inside the expressions
      return n.expressions.flatMap((e) => outputEdits(src, e, kind))
    }
    const used = new Set()
    let text = ''
    const vars = []
    n.quasis.forEach((q, i) => {
      text += cooked[i]
      const e = n.expressions[i]
      if (!e) return
      const name = varName(e, used)
      const inner = outputEdits(src, e, kind)
      vars.push(`${name}: ${applyEdits(src.slice(e.start, e.end), inner, e.start)}`)
      text += `{{${name}}}`
    })
    return [{ start: n.start, end: n.end, text, replacement: `tr(${quote(text)}, { ${vars.join(', ')} })`, kind }]
  }
  if (n.type === 'ConditionalExpression') return [...outputEdits(src, n.consequent, kind), ...outputEdits(src, n.alternate, kind)]
  if (n.type === 'LogicalExpression') {
    if (n.operator === '&&') return outputEdits(src, n.right, kind)
    return [...outputEdits(src, n.left, kind), ...outputEdits(src, n.right, kind)]
  }
  if (n.type === 'SequenceExpression') return outputEdits(src, n.expressions[n.expressions.length - 1], kind)
  return []
}

export function applyEdits(text, edits, offset = 0) {
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of sorted) out = out.slice(0, e.start - offset) + e.replacement + out.slice(e.end - offset)
  return out
}

const calleeName = (c) => (c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' ? (c.property?.name ?? null) : null)
const calleeObject = (c) => (c?.type === 'MemberExpression' ? calleeName(c.object) ?? (c.object?.type === 'Identifier' ? c.object.name : null) : null)

function insideDbCall(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'CallExpression' && DB_CALLS.has(calleeName(p.callee))) return true
    if (p.type === 'Program') break
  }
  return false
}

function isTrCall(node) {
  return node?.type === 'CallExpression' && ['tr', 'tk'].includes(calleeName(node.callee))
}

/** Every finding in one file. */
export function scan(file, src) {
  let ast
  try {
    ast = parseAst(src, { lang: file.endsWith('x') ? 'tsx' : 'ts' })
  } catch {
    return []
  }
  const found = []
  const add = (list) => found.push(...list)
  walk(ast, null, (node) => {
    // never look inside tr() / tk()
    if (isTrCall(node.parent)) return
    if (node.type === 'JSXText') {
      const value = decode(node.value)
      if (!isText(value)) return
      const core = value.trim()
      const lead = node.value.match(/^\s*/)[0]
      const trail = node.value.match(/\s*$/)[0]
      const key = core.replace(/\s+/g, ' ')
      // a "{" or "}" in text cannot be written inside JSX without an expression
      found.push({ start: node.start, end: node.end, text: key, replacement: `${lead}{tr(${quote(key)})}${trail}`, kind: 'jsx-text' })
      return
    }
    if (node.type === 'JSXAttribute' && TEXT_ATTRS.has(node.name?.name ?? node.name?.namespace?.name)) {
      const v = node.value
      if (!v) return
      if (v.type === 'Literal' && typeof v.value === 'string') {
        if (isText(v.value)) found.push({ start: v.start, end: v.end, text: v.value, replacement: `{tr(${quote(v.value)})}`, kind: 'attribute' })
      } else if (v.type === 'JSXExpressionContainer') {
        add(outputEdits(src, v.expression, 'attribute'))
      }
      return
    }
    if (node.type === 'JSXExpressionContainer' && (node.parent?.type === 'JSXElement' || node.parent?.type === 'JSXFragment')) {
      add(outputEdits(src, node.expression, 'jsx-expression'))
      return
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = calleeName(node.callee)
      const obj = calleeObject(node.callee)
      const isToast = obj === 'toast' && TOAST.has(name)
      if (isToast || MESSAGE_FNS.has(name) || (node.type === 'NewExpression' && name === 'Error')) {
        if (node.arguments[0]) add(outputEdits(src, node.arguments[0], 'message'))
        const opts = node.arguments[1]
        if (opts?.type === 'ObjectExpression') {
          for (const p of opts.properties) {
            if (p.type === 'Property' && ['confirmLabel', 'label', 'description'].includes(p.key?.name)) add(outputEdits(src, p.value, 'message'))
          }
        }
      }
      return
    }
    if (node.type === 'Property' && !node.computed && !node.shorthand && node.kind === 'init' && !node.method && DATA_KEYS.has(node.key?.name ?? node.key?.value)) {
      const v = unwrap(node.value)
      if (!v || insideDbCall(node)) return
      if (node.parent?.type !== 'ObjectExpression') return
      const isStr = (v.type === 'Literal' && typeof v.value === 'string') || (v.type === 'TemplateLiteral' && v.expressions.length === 0)
      if (!isStr) return
      const text = v.type === 'Literal' ? v.value : v.quasis.map((q) => q.value.cooked).join('')
      if (!isText(text)) return
      const key = node.key.name ?? node.key.value
      found.push({ start: node.start, end: node.end, text, replacement: `get ${key}() {\n    return tr(${quote(text)})\n  }`, kind: 'data' })
    }
  })
  // drop findings nested inside another finding (the outer one carries them)
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const out = []
  for (const f of found) {
    const last = out[out.length - 1]
    if (last && f.start >= last.start && f.end <= last.end) continue
    out.push(f)
  }
  return out
}

/** Every key used with tr('…') / tk('…') in a file (first argument, a plain string). */
export function keysIn(file, src) {
  let ast
  try {
    ast = parseAst(src, { lang: file.endsWith('x') ? 'tsx' : 'ts' })
  } catch {
    return []
  }
  const keys = []
  walk(ast, null, (node) => {
    if (node.type !== 'CallExpression' || !['tr', 'tk'].includes(calleeName(node.callee))) return
    const a = unwrap(node.arguments[0])
    if (!a) return
    let key = null
    if (a.type === 'Literal' && typeof a.value === 'string') key = a.value
    else if (a.type === 'TemplateLiteral' && a.expressions.length === 0) key = a.quasis.map((q) => q.value.cooked).join('')
    if (key === null) return
    const opts = node.arguments[1]
    const plural = opts?.type === 'ObjectExpression' && opts.properties.some((p) => p.type === 'Property' && (p.key?.name ?? p.key?.value) === 'count')
    keys.push({ key, plural })
  })
  return keys
}
