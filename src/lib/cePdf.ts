// The CE / EU Declaration of Conformity as a PDF, made on demand from the
// saved data (nothing is stored). One page per machine (A4, or Letter).
// Content follows the Machinery Directive 2006/42/EC, Annex II 1.A.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { htmlToBlocks } from './certificatePdf'
import type { CeData } from './ce'
import { showDate } from './dates'

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const
const M = 48
const INK = rgb(0.06, 0.09, 0.16)
const GREY = rgb(0.39, 0.45, 0.55)
const LINE = rgb(0.82, 0.85, 0.89)
const SHADE = rgb(0.95, 0.96, 0.98)
const RED = rgb(0.75, 0.1, 0.1)

/** The standard PDF fonts know Western characters (WinAnsi): replace the rest. */
function txt(text: string) {
  return text
    .replace(/[   ]/g, ' ')
    .replace(/→/g, '->')
    .replace(/[^\x20-\x7E\xA0-\xFF\n€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '?')
}

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont }
type Item = { data: CeData; number: string | null; signature: string | null; paper: 'a4' | 'letter' }

/** Splits text into lines that fit the width. */
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = []
  for (const para of txt(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line)
        line = word
      } else line = next
    }
    out.push(line)
  }
  return out
}

async function embed(pdf: PDFDocument, dataUrl: string | null | undefined): Promise<PDFImage | null> {
  if (!dataUrl) return null
  try {
    if (dataUrl.startsWith('data:image/png')) return await pdf.embedPng(dataUrl)
    if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) return await pdf.embedJpg(dataUrl)
  } catch {
    return null
  }
  return null
}

/** One or more declarations in one PDF (each starts on a new page). number = null → marked as a preview. */
export async function buildCePdf(items: Item[], logo: string | null) {
  const pdf = await PDFDocument.create()
  const f: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  }
  const logoImg = await embed(pdf, logo)
  pdf.setTitle(txt(items.length === 1 ? `${items[0].data.title} ${items[0].number ?? '(preview)'}` : 'Declarations of Conformity'))
  pdf.setAuthor(txt(items[0]?.data.manufacturer.name ?? 'Belfast Mini Mills'))
  for (const it of items) await drawDeclaration(pdf, f, it, logoImg)
  return await pdf.save()
}

async function drawDeclaration(pdf: PDFDocument, f: Fonts, it: Item, logo: PDFImage | null) {
  const d = it.data
  const [W, H] = SIZES[it.paper] ?? SIZES.a4
  const pages: PDFPage[] = []
  let page!: PDFPage
  let y = 0
  const newPage = () => {
    page = pdf.addPage([W, H])
    pages.push(page)
    y = H - M
  }
  const need = (h: number) => {
    if (y - h < M + 22) newPage()
  }
  const text = (s: string, x: number, size: number, font = f.regular, color = INK) => page.drawText(txt(s), { x, y, size, font, color })
  newPage()

  // ---- Letterhead ----
  let x0 = M
  if (logo) {
    const s = Math.min(130 / logo.width, 46 / logo.height, 1)
    page.drawImage(logo, { x: M, y: y - logo.height * s, width: logo.width * s, height: logo.height * s })
    x0 = M + logo.width * s + 12
  }
  const man = d.manufacturer
  page.drawText(txt(man.name), { x: x0, y: y - 14, size: 14, font: f.bold, color: INK })
  const head = [...(man.address ?? '').split('\n').filter(Boolean).slice(0, 2), [man.phone, man.email, man.website].filter(Boolean).join(' · ')].filter(Boolean)
  head.forEach((l, i) => page.drawText(txt(l), { x: x0, y: y - 27 - i * 10.5, size: 8.5, font: f.regular, color: GREY, maxWidth: W - M - x0 }))
  y -= Math.max(logo ? 50 : 0, 30 + head.length * 10.5)
  page.drawRectangle({ x: M, y, width: W - 2 * M, height: 1.6, color: INK })
  y -= 30

  // ---- Title ----
  const title = txt(d.title)
  page.drawText(title, { x: (W - f.bold.widthOfTextAtSize(title, 17)) / 2, y, size: 17, font: f.bold, color: INK })
  y -= 15
  const sub = it.number ? `Declaration number ${it.number}` : 'PREVIEW – not issued'
  page.drawText(txt(sub), { x: (W - f.regular.widthOfTextAtSize(txt(sub), 9)) / 2, y, size: 9, font: it.number ? f.regular : f.bold, color: it.number ? GREY : RED })
  y -= 24

  // ---- Numbered sections (empty optional ones are left out) ----
  let n = 0
  const heading = (label: string, x = M, width = W - 2 * M) => {
    n++
    page.drawText(txt(`${n}. ${label}`), { x, y, size: 10.5, font: f.bold, color: INK })
    page.drawLine({ start: { x, y: y - 4 }, end: { x: x + width, y: y - 4 }, color: LINE, thickness: 0.6 })
    return n
  }
  const lines = (list: string[], x: number, width: number, size = 9.5, font = f.regular) => {
    for (const raw of list) {
      for (const l of wrap(raw, font, size, width)) {
        need(size * 1.35)
        page.drawText(l, { x, y, size, font, color: INK })
        y -= size * 1.35
      }
    }
  }

  // Sections 1 and 2 side by side.
  const colW = (W - 2 * M - 20) / 2
  need(110)
  const top = y
  heading('Manufacturer', M, colW)
  y -= 17
  lines(
    [
      man.name,
      ...(man.address ?? '').split('\n').filter(Boolean),
      man.phone ? `Phone: ${man.phone}` : '',
      `Contact person: ${man.contact_person}`,
      man.email ? `Email: ${man.email}` : '',
    ].filter(Boolean),
    M,
    colW,
  )
  const leftEnd = y
  y = top
  heading('Person authorised to compile the technical file', M + colW + 20, colW)
  y -= 17
  lines(d.authorised_person.split('\n').filter(Boolean), M + colW + 20, colW)
  y = Math.min(leftEnd, y) - 10

  // 3. Machine
  need(120)
  heading('Machine')
  y -= 9
  const rows: [string, string][] = [
    ['Type of product', d.machine.product],
    ['Brand name', d.machine.brand],
    ['Model', d.machine.model ?? ''],
    ['Serial number', d.machine.serial],
    ['Voltage', d.machine.voltage ?? ''],
    ['Year of manufacture', String(d.machine.year)],
  ]
  const keyW = 140
  for (const [k, v] of rows) {
    need(16)
    page.drawRectangle({ x: M, y: y - 16, width: keyW, height: 16, color: SHADE, borderColor: LINE, borderWidth: 0.6 })
    page.drawRectangle({ x: M + keyW, y: y - 16, width: W - 2 * M - keyW, height: 16, borderColor: LINE, borderWidth: 0.6 })
    page.drawText(txt(k), { x: M + 6, y: y - 11.5, size: 9.5, font: f.bold, color: INK })
    page.drawText(txt(v), { x: M + keyW + 6, y: y - 11.5, size: 9.5, font: f.regular, color: INK, maxWidth: W - 2 * M - keyW - 12 })
    y -= 16
  }
  y -= 16

  // 4. Declaration and directives
  need(60)
  heading('Declaration')
  y -= 17
  for (const b of htmlToBlocks(d.declaration_html)) lines([b.runs.map((r) => r.text).join('')], M, W - 2 * M)
  y -= 2
  for (const dir of d.directives) {
    need(14)
    page.drawText('•', { x: M + 6, y, size: 9.5, font: f.bold, color: INK })
    lines([dir], M + 18, W - 2 * M - 18, 9.5, f.bold)
  }
  y -= 8

  // 5. Harmonised standards (optional)
  if (d.standards.length) {
    need(40)
    heading('Harmonised standards applied')
    y -= 17
    for (const s of d.standards) {
      need(14)
      page.drawText('•', { x: M + 6, y, size: 9.5, font: f.regular, color: INK })
      lines([s], M + 18, W - 2 * M - 18)
    }
    y -= 8
  }

  // 6. Notified body (optional)
  if (d.notified_body) {
    need(40)
    heading('Notified body')
    y -= 17
    lines(d.notified_body.split('\n').filter(Boolean), M, W - 2 * M)
    y -= 8
  }

  // Closing words of the template (for example "issued under the sole responsibility of the manufacturer").
  const closing = htmlToBlocks(d.closing_html).map((b) => b.runs.map((r) => r.text).join('')).filter((s) => s.trim())
  if (closing.length) {
    lines(closing, M, W - 2 * M, 9, f.italic)
    y -= 6
  }

  // 7. Place, date, signature, name and title
  need(120)
  heading('Place, date and signature')
  y -= 17
  text(`Place: ${d.place}`, M, 9.5)
  y -= 13
  text(`Date: ${showDate(d.date)}`, M, 9.5)
  y -= 8
  const sig = await embed(pdf, it.signature)
  const sigW = 200
  if (sig) {
    const s = Math.min(sigW / sig.width, 52 / sig.height)
    page.drawImage(sig, { x: M, y: y - sig.height * s, width: sig.width * s, height: sig.height * s })
  } else if (!it.number) {
    page.drawText('(signature)', { x: M, y: y - 34, size: 9, font: f.italic, color: GREY })
  }
  y -= 56
  page.drawLine({ start: { x: M, y }, end: { x: M + sigW + 60, y }, color: INK, thickness: 0.7 })
  y -= 12
  lines([d.signer], M, W - 2 * M, 9.5, f.bold)

  // ---- Footer on each page of this declaration ----
  pages.forEach((p, i) => {
    const left = txt(`${d.title} · ${it.number ?? 'Preview'}`)
    const right = `Page ${i + 1} of ${pages.length}`
    p.drawLine({ start: { x: M, y: M - 6 }, end: { x: W - M, y: M - 6 }, color: LINE, thickness: 0.6 })
    p.drawText(left, { x: M, y: M - 18, size: 8, font: f.regular, color: GREY })
    p.drawText(right, { x: W - M - f.regular.widthOfTextAtSize(right, 8), y: M - 18, size: 8, font: f.regular, color: GREY })
  })
}
