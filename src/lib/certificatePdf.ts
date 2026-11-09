// The commissioning certificate as a PDF, made on demand from the saved data
// (nothing is stored). Loaded only when someone downloads or emails it.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { showDate } from './dates'
import { cleanRichText } from './richText'
import { certificateValues, documentReference, fillPlaceholders, type Certificate, type CompanyInfo } from './service'

const PAGE = { w: 612, h: 792 } // Letter
const M = 54 // margin
const INK = rgb(0.06, 0.09, 0.16)
const GREY = rgb(0.39, 0.45, 0.55)
const LINE = rgb(0.8, 0.83, 0.87)

/** The standard PDF fonts only know Western characters: replace the rest. */
function plain(text: string) {
  return text
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    .replace(/→/g, '->')
    .replace(/[^\x20-\x7E\xA1-\xFF\n]/g, '?')
}

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont }
type Run = { text: string; bold: boolean; italic: boolean }
type Block = { kind: 'h2' | 'h3' | 'p' | 'li'; runs: Run[]; marker?: string }

/** Rich text (headings, paragraphs, lists, bold, italic) → blocks of runs. */
export function htmlToBlocks(html: string): Block[] {
  const doc = new DOMParser().parseFromString(cleanRichText(html), 'text/html')
  const blocks: Block[] = []
  const runsOf = (node: Node, bold = false, italic = false, out: Run[] = []) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) out.push({ text: child.textContent ?? '', bold, italic })
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = (child as Element).tagName.toLowerCase()
        if (tag === 'br') out.push({ text: '\n', bold, italic })
        else if (tag === 'ul' || tag === 'ol' || tag === 'input') return
        else runsOf(child, bold || tag === 'strong' || tag === 'b', italic || tag === 'em' || tag === 'i', out)
      }
    })
    return out
  }
  const walk = (parent: Element) => {
    Array.from(parent.children).forEach((el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === 'h2' || tag === 'h3' || tag === 'p') blocks.push({ kind: tag, runs: runsOf(el) })
      else if (tag === 'ul' || tag === 'ol') {
        Array.from(el.children).forEach((li, i) => {
          const checked = li.getAttribute('data-checked')
          const marker = checked === 'true' ? '[x]' : checked === 'false' ? '[ ]' : tag === 'ol' ? `${i + 1}.` : '•'
          const inner = li.querySelector(':scope > p, :scope > div') ?? li
          blocks.push({ kind: 'li', runs: runsOf(inner), marker })
          li.querySelectorAll(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol').forEach((sub) => walk({ children: [sub] } as unknown as Element))
        })
      } else if (tag === 'div') walk(el)
      else blocks.push({ kind: 'p', runs: runsOf(el) })
    })
  }
  walk(doc.body)
  return blocks
}

/** Writes the certificate pages; returns the PDF bytes. */
export async function buildCertificatePdf(c: Certificate, company: CompanyInfo, signatures: { tech: string | null; customer: string | null }, today: string) {
  const pdf = await PDFDocument.create()
  pdf.setTitle(plain(`${c.title} - ${documentReference(c)}`))
  pdf.setAuthor(plain(company.name || 'Belfast Mini Mills'))
  const f: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  }
  const fontOf = (r: { bold: boolean; italic: boolean }) => (r.bold ? (r.italic ? f.boldItalic : f.bold) : r.italic ? f.italic : f.regular)
  const values = certificateValues(c, company, today)

  let page: PDFPage = pdf.addPage([PAGE.w, PAGE.h])
  let y = PAGE.h - M
  const footer = plain(`${c.title} · ${documentReference(c)}${c.version > 1 ? ` · Version ${c.version}` : ''}`)
  const pages: PDFPage[] = [page]
  const newPage = () => {
    page = pdf.addPage([PAGE.w, PAGE.h])
    pages.push(page)
    y = PAGE.h - M
  }
  const need = (h: number) => {
    if (y - h < M + 24) newPage()
  }

  const embed = async (dataUrl: string | null | undefined): Promise<PDFImage | null> => {
    if (!dataUrl) return null
    try {
      if (dataUrl.startsWith('data:image/png')) return await pdf.embedPng(dataUrl)
      if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) return await pdf.embedJpg(dataUrl)
    } catch {
      return null
    }
    return null
  }

  // ---- Letterhead ----
  const logo = await embed(company.logo)
  let textX = M
  if (logo) {
    const s = Math.min(150 / logo.width, 54 / logo.height, 1)
    page.drawImage(logo, { x: M, y: y - logo.height * s, width: logo.width * s, height: logo.height * s })
    textX = M + logo.width * s + 14
  }
  page.drawText(plain(company.name || 'Belfast Mini Mills'), { x: textX, y: y - 16, size: 16, font: f.bold, color: INK })
  const contact = [company.address, [company.phone, company.email, company.website].filter(Boolean).join(' · ')].filter(Boolean) as string[]
  contact.forEach((line, i) => page.drawText(plain(line), { x: textX, y: y - 32 - i * 12, size: 9, font: f.regular, color: GREY, maxWidth: PAGE.w - M - textX }))
  y -= Math.max(logo ? 58 : 0, 36 + contact.length * 12)
  page.drawRectangle({ x: M, y, width: PAGE.w - 2 * M, height: 2, color: INK })
  y -= 34

  // ---- Title ----
  const title = plain(c.title)
  page.drawText(title, { x: (PAGE.w - f.bold.widthOfTextAtSize(title, 18)) / 2, y, size: 18, font: f.bold, color: INK })
  y -= 30

  // ---- Rich text ----
  const writeBlocks = (html: string) => {
    for (const b of htmlToBlocks(fillPlaceholders(html, values))) {
      const size = b.kind === 'h2' ? 14 : b.kind === 'h3' ? 12 : 11
      const lead = size * 1.4
      const indent = b.kind === 'li' ? 16 : 0
      const width = PAGE.w - 2 * M - indent
      const runs = b.kind === 'h2' || b.kind === 'h3' ? b.runs.map((r) => ({ ...r, bold: true })) : b.runs
      // Words with their font, wrapped into lines.
      const lines: { text: string; font: PDFFont; w: number }[][] = [[]]
      let lineW = 0
      for (const r of runs) {
        const font = fontOf(r)
        for (const part of plain(r.text).split(/(\n|\s+)/)) {
          if (!part) continue
          if (part === '\n') {
            lines.push([])
            lineW = 0
            continue
          }
          const space = /^\s+$/.test(part)
          const w = font.widthOfTextAtSize(space ? ' ' : part, size)
          if (!space && lineW + w > width && lineW > 0) {
            lines.push([])
            lineW = 0
          }
          if (space && lineW === 0) continue
          lines[lines.length - 1].push({ text: space ? ' ' : part, font, w })
          lineW += w
        }
      }
      if (b.kind === 'h2' || b.kind === 'h3') y -= 4
      lines.forEach((line, i) => {
        need(lead)
        if (i === 0 && b.marker) page.drawText(plain(b.marker), { x: M + 2, y, size, font: f.regular, color: INK })
        let x = M + indent
        for (const w of line) {
          page.drawText(w.text, { x, y, size, font: w.font, color: INK })
          x += w.w
        }
        y -= lead
      })
      y -= b.kind === 'li' ? 2 : 6
    }
  }
  writeBlocks(c.part1)

  // ---- Machines ----
  const rows = c.machines.filter((m) => !m.removed)
  const col = [M, M + (PAGE.w - 2 * M) * 0.62, PAGE.w - M]
  const rowH = 20
  y -= 4
  need(rowH * 2)
  const drawRow = (a: string, b: string, head: boolean) => {
    need(rowH)
    page.drawRectangle({ x: col[0], y: y - rowH + 14, width: col[2] - col[0], height: rowH, borderColor: LINE, borderWidth: 0.8, color: head ? rgb(0.95, 0.96, 0.98) : undefined })
    page.drawLine({ start: { x: col[1], y: y + 14 }, end: { x: col[1], y: y - rowH + 14 }, color: LINE, thickness: 0.8 })
    const font = head ? f.bold : f.regular
    page.drawText(plain(a), { x: col[0] + 6, y: y - 1, size: 10.5, font, color: INK, maxWidth: col[1] - col[0] - 12 })
    page.drawText(plain(b), { x: col[1] + 6, y: y - 1, size: 10.5, font: head ? f.bold : f.regular, color: INK, maxWidth: col[2] - col[1] - 12 })
    y -= rowH
  }
  drawRow('Machine', 'Serial number', true)
  for (const m of rows) drawRow(m.machine, m.serial ?? '', false)
  if (rows.length === 0) drawRow('No machines listed', '', false)
  y -= 18

  writeBlocks(c.part2)

  // ---- Signatures ----
  y -= 10
  need(150)
  const half = (PAGE.w - 2 * M - 30) / 2
  const sigBlock = async (x: number, heading: string, img: string | null, lines: [string, string][]) => {
    let yy = y
    page.drawText(plain(heading), { x, y: yy, size: 11, font: f.bold, color: INK })
    yy -= 8
    const image = await embed(img)
    if (image) {
      const s = Math.min(half / image.width, 60 / image.height)
      page.drawImage(image, { x, y: yy - image.height * s, width: image.width * s, height: image.height * s })
    }
    yy -= 64
    page.drawLine({ start: { x, y: yy }, end: { x: x + half, y: yy }, color: INK, thickness: 0.8 })
    page.drawText('Signature', { x, y: yy - 11, size: 8, font: f.regular, color: GREY })
    yy -= 26
    for (const [label, value] of lines) {
      page.drawText(plain(`${label}: `), { x, y: yy, size: 10, font: f.bold, color: INK })
      page.drawText(plain(value || '________________'), { x: x + f.bold.widthOfTextAtSize(plain(`${label}: `), 10), y: yy, size: 10, font: f.regular, color: INK, maxWidth: half - 70 })
      yy -= 15
    }
    return yy
  }
  const yTech = await sigBlock(M, 'Technician', signatures.tech, [
    ['Printed name', c.tech_name ?? ''],
    ['Date', c.tech_sign_date ? showDate(c.tech_sign_date) : ''],
  ])
  const yCustomer = await sigBlock(M + half + 30, 'Customer', signatures.customer, [
    ['Printed name', c.customer_name ?? ''],
    ['Title', c.customer_title ?? ''],
    ['Date', c.customer_sign_date ? showDate(c.customer_sign_date) : ''],
  ])
  y = Math.min(yTech, yCustomer)

  // ---- Footer on every page ----
  pages.forEach((p, i) => {
    const text = pages.length > 1 ? `${footer} · Page ${i + 1} of ${pages.length}` : footer
    p.drawText(text, { x: M, y: M - 20, size: 8, font: f.regular, color: GREY })
  })
  return await pdf.save()
}

/** Base64 of the PDF (for the email). */
export function toBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function downloadPdf(bytes: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
