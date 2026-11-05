import DOMPurify from 'dompurify'

/**
 * Notes with simple formatting (bold, italic, bullet / numbered / checkbox
 * lists) are stored as a small, cleaned piece of HTML. Old notes are plain
 * text and still show as they are. Everything goes through clean() before it
 * is shown, so no scripts, links, pictures or styles can get in. The database
 * also refuses anything script-like (migration 0021).
 */
const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'label', 'input', 'div', 'span']
const ALLOWED_ATTR = ['data-type', 'data-checked', 'type', 'checked']

let hooked = false
function purifier() {
  if (!hooked) {
    // Only tick boxes are allowed as inputs.
    DOMPurify.addHook('uponSanitizeElement', (node, data) => {
      if (data.tagName === 'input' && (node as Element).getAttribute('type') !== 'checkbox') node.parentNode?.removeChild(node)
    })
    hooked = true
  }
  return DOMPurify
}

/** True for notes saved by the editor (HTML), false for old plain-text notes. */
export function isRichText(text: string | null | undefined) {
  return !!text && /^\s*<(p|ul|ol|div)[\s>]/i.test(text)
}

function escapeHtml(text: string) {
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

/** Plain text of a note, e.g. for CSV files and the activity history. */
export function richTextToPlain(text: string | null | undefined) {
  if (!text) return ''
  if (!isRichText(text)) return text
  const doc = new DOMParser().parseFromString(cleanRichText(text), 'text/html')
  const lines: string[] = []
  const walk = (el: Element, prefix = '') => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'ul' || tag === 'ol') {
        Array.from(child.children).forEach((li, i) => {
          const task = li.getAttribute('data-type') === 'taskItem'
          const mark = task ? (li.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ') : tag === 'ol' ? `${i + 1}. ` : '- '
          const text = (li.querySelector('p')?.textContent ?? li.textContent ?? '').trim()
          lines.push(prefix + mark + text)
        })
      } else if (tag === 'p') lines.push(prefix + (child.textContent ?? ''))
      else walk(child, prefix)
    }
  }
  walk(doc.body)
  return lines.join('\n')
}
