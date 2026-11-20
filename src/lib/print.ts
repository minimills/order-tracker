// The shared print preview (components/print/PrintButton + PrintPreview).
//
// Every page that shows data has a Print button. It opens a preview: a
// snapshot of what the page shows right now, on a white sheet with the
// company letterhead. The person chooses which parts to include, the paper
// direction and the text size, then prints (or saves as PDF in the browser's
// print window). Nothing is stored.
//
// Parts that can be left out: elements with data-print-section="Label"
// (every <Section> has one), otherwise each <section> with a heading.
// data-print="hide" (or the Tailwind class print:hidden) leaves an element
// out of every printout; buttons and the menu are always left out.

export type PrintPart = { id: string; label: string; el: Element }

/** The parts of a snapshot a person can leave out. */
export function findParts(root: Element): PrintPart[] {
  let found = Array.from(root.querySelectorAll('[data-print-section]'))
  if (found.length === 0) found = Array.from(root.querySelectorAll('section')).filter((s) => s.querySelector('h2, h3'))
  // Only the outermost ones (a part inside another part goes with it).
  const outer = found.filter((el) => !found.some((other) => other !== el && other.contains(el)))
  const seen = new Map<string, number>()
  return outer.map((el, i) => {
    const raw = (el.getAttribute('data-print-section') || el.querySelector('h2, h3')?.textContent || `Part ${i + 1}`).trim().replace(/\s+/g, ' ')
    const n = (seen.get(raw) ?? 0) + 1
    seen.set(raw, n)
    return { id: `part-${i}`, label: n > 1 ? `${raw} (${n})` : raw, el }
  })
}

/**
 * A printable copy of `source`: typed values of inputs and dropdowns are
 * written in as text, charts drawn on a canvas become pictures, and things
 * that only make sense on screen are removed.
 */
export function snapshot(source: Element): HTMLElement {
  const copy = source.cloneNode(true) as HTMLElement
  const originals = source.querySelectorAll('input, select, textarea, canvas')
  const copies = copy.querySelectorAll('input, select, textarea, canvas')
  originals.forEach((orig, i) => {
    const el = copies[i]
    if (!el) return
    if (orig instanceof HTMLCanvasElement) {
      try {
        const img = document.createElement('img')
        img.src = orig.toDataURL('image/png')
        img.style.width = '100%'
        el.replaceWith(img)
      } catch {
        el.remove()
      }
      return
    }
    if (orig instanceof HTMLInputElement && (orig.type === 'checkbox' || orig.type === 'radio')) {
      ;(el as HTMLInputElement).checked = orig.checked
      if (orig.checked) el.setAttribute('checked', '')
      else el.removeAttribute('checked')
      return
    }
    if (orig instanceof HTMLInputElement && ['hidden', 'file', 'color', 'range', 'submit', 'button'].includes(orig.type)) {
      el.remove()
      return
    }
    const value =
      orig instanceof HTMLSelectElement ? (orig.selectedOptions[0]?.textContent ?? '') : (orig as HTMLInputElement | HTMLTextAreaElement).value
    if (!value.trim()) {
      el.remove()
      return
    }
    const span = document.createElement('span')
    span.className = 'print-value'
    span.textContent = value
    el.replaceWith(span)
  })
  // Editors: keep the text, drop the toolbars.
  copy.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
  copy.querySelectorAll('[role="toolbar"], [data-print="hide"], script').forEach((el) => el.remove())
  // Ids must stay unique on the page.
  copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
  copy.removeAttribute('id')
  return copy
}
