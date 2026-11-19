import DOMPurify from 'dompurify'

/**
 * Longer texts (notes, descriptions, comments, notices, templates…) are stored
 * as a small, cleaned piece of HTML made by the shared editor
 * (components/RichTextEditor): bold, italic, underline, strikethrough,
 * headings, bullet / numbered / checkbox lists and links. Old notes are plain
 * text and still show as they are. Everything goes through cleanRichText()
 * before it is shown or saved, so no scripts, pictures, styles or unsafe
 * links can get in. The database also refuses anything script-like
 * (is_safe_rich_text, migrations 0021 and 0049).
 */
const ALLOWED_TAGS = ['h2', 'h3', 'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'label', 'input', 'div', 'span']
const ALLOWED_ATTR = ['data-type', 'data-checked', 'type', 'checked', 'href', 'target', 'rel']

/** A link address that is allowed in notes (web, email or phone), or null. */
export function safeLink(href: string | null | undefined): string | null {
  const h = String(href ?? '').trim()
  if (!h || h.length > 2000) return null
  if (/^(https?:\/\/|mailto:|tel:)/i.test(h)) return h
  return null
}

let hooked = false
function purifier() {
  if (!hooked) {
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
      // Only checkboxes are allowed as inputs.
      if (data.tagName === 'input' && (node as Element).getAttribute('type') !== 'checkbox') node.parentNode?.removeChild(node)
    })
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      const el = node as Element
      if (el.tagName !== 'A') return
      const href = safeLink(el.getAttribute('href'))
      if (!href) {
        el.removeAttribute('href')
        el.removeAttribute('target')
        el.removeAttribute('rel')
        return
      }
      // Links always open in a new tab and never pass on who sent the visitor.
      el.setAttribute('href', href)
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    })
    hooked = true
  }
  return DOMPurify
}

/** True for notes saved by the editor (HTML), false for old plain-text notes. */
export function isRichText(text: string | null | undefined) {
  return !!text && /^\s*<(p|ul|ol|div|h2|h3)[\s>]/i.test(text)
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Plain text → paragraphs (for old notes opened in the editor). */
export function plainToHtml(text: string | null | undefined) {
  if (!text) return ''
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** Safe HTML for showing a note (plain text is converted). */
export function cleanRichText(text: string | null | undefined) {
  if (!text) return ''
  const html = isRichText(text) ? text : plainToHtml(text)
  return purifier().sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR }) as string
}

/** True when the editor content is effectively empty. */
export function isEmptyRichText(html: string | null | undefined) {
  return !html || richTextToPlain(html).trim() === ''
}

/** Plain text of a note, for example for CSV files, emails' text part and the activity history. */
export function richTextToPlain(text: string | null | undefined) {
  if (!text) return ''
  if (!isRichText(text)) return text
  const doc = new DOMParser().parseFromString(cleanRichText(text), 'text/html')
  const lines: string[] = []
  // Text of an element with link addresses written after the link text.
  const inline = (el: Element) => {
    let out = ''
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.textContent ?? ''
      else if (n.nodeType === 1) {
        const c = n as Element
        const tag = c.tagName.toLowerCase()
        if (tag === 'br') out += '\n'
        else if (tag === 'ul' || tag === 'ol') return
        else if (tag === 'a') {
          const t = c.textContent ?? ''
          const href = (c.getAttribute('href') ?? '').replace(/^mailto:/, '')
          out += href && href !== t ? `${t} (${href})` : t
        } else out += inline(c)
      }
    })
    return out
  }
  const walk = (el: Element, prefix = '') => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'ul' || tag === 'ol') {
        Array.from(child.children).forEach((li, i) => {
          const task = li.getAttribute('data-type') === 'taskItem'
          const mark = task ? (li.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ') : tag === 'ol' ? `${i + 1}. ` : '- '
          const body = li.querySelector(':scope > p, :scope > div > p') ?? li
          lines.push(prefix + mark + inline(body).trim())
          // Nested lists inside a list item
          li.querySelectorAll(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol').forEach((sub) => {
            const wrap = doc.createElement('div')
            wrap.appendChild(sub.cloneNode(true))
            walk(wrap, `${prefix}  `)
          })
        })
      } else if (tag === 'p' || tag === 'h2' || tag === 'h3') lines.push(prefix + inline(child))
      else walk(child, prefix)
    }
  }
  walk(doc.body)
  return lines.join('\n')
}

/** One line of plain text from text that may hold pieces of notes (for short summaries such as a history line). */
export function richTextInline(text: string | null | undefined) {
  if (!text) return ''
  if (!/<[a-z]/i.test(text)) return text
  const doc = new DOMParser().parseFromString(purifier().sanitize(text, { ALLOWED_TAGS, ALLOWED_ATTR }) as string, 'text/html')
  doc.querySelectorAll('p, li, h2, h3, br').forEach((el) => el.after(doc.createTextNode(' ')))
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}
