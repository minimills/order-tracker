// Test: the CE / EU Declaration of Conformity PDF shows EVERY directive,
// standard, the notified body and the signature block (the renderer that
// Preview, Print, Download PDF and the emails all use: src/lib/cePdf.ts).
//
//   npm test        (also runs in npm run build and in the deploy)
//
// It bundles cePdf.ts with esbuild, builds PDFs, then reads their text back
// with pdf.js and checks it.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'ce-test-'))
const out = join(dir, 'cePdf.mjs')
let failures = 0
const check = (ok, what) => {
  if (ok) console.log(`  ✓ ${what}`)
  else {
    failures++
    console.log(`  ✗ ${what}`)
  }
}

try {
  await build({ entryPoints: ['src/lib/cePdf.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
  const { buildCePdf, richTextParagraphs } = await import(pathToFileURL(out).href)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  // A 2 × 1 pixel PNG standing in for a signature.
  const signature =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAAQAAWMDYsYAAAAASUVORK5CYII='

  const data = (serial, directives, extra = {}) => ({
    kind: 'ec_2006',
    title: 'EC Declaration of Conformity',
    declaration_html: '<p>We hereby declare that the machine described above fulfils all the relevant provisions of the following directives:</p>',
    closing_html: '<p>This declaration of conformity is issued under the sole responsibility of the manufacturer.</p>',
    manufacturer: { name: 'Belfast Mini Mills Ltd.', address: '18 Gairloch Road\nBelfast, PE C0A 1A0', phone: '902-659-2430', contact_person: 'Ankit Luthra', email: 'office@example.com', website: null },
    authorised_person: 'Certification Experts\nAmerlandseweg 7\n3621 ZC Breukelen\nThe Netherlands',
    machine: { product: 'Textile Machine – Cone Winder', brand: 'Belfast Mini Mills Limited', model: 'CWR', serial_number: `CWR-${serial}`, serial, voltage: '240V', year: 2026, type_name: 'Cone Winder' },
    directives,
    standards: ['EN ISO 12100', 'EN 60204-1'],
    notified_body: 'Example Notified Body, NB 1234',
    place: 'Belfast, PEI, Canada',
    date: '2026-11-13',
    signer: 'Ankit Luthra – General Manager, Belfast Mini Mills Ltd.',
    order_id: 'o',
    order_code: '87',
    customer_name: 'Jane Farmer',
    customer_company: 'Woolly Acres',
    ...extra,
  })
  const THREE = ['Machinery Directive 2006/42/EC', 'Low Voltage Directive 2014/35/EU', 'EMC Directive 2014/30/EU']

  const pages = async (bytes) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise
    const out = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const text = (await page.getTextContent()).items.map((t) => t.str).join(' ').replace(/\s+/g, ' ')
      const ops = await page.getOperatorList()
      out.push({ text, images: ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length })
    }
    return out
  }

  console.log('One declaration with three directives (A4):')
  const one = await pages(await buildCePdf([{ data: data('4175', THREE), number: 'DoC-CWR-4175-2026-v1', signature, paper: 'a4' }], null))
  check(one.length === 1, 'fits on one page')
  for (const d of THREE) check(one[0].text.includes(d), `shows "${d}"`)
  for (const s of ['EN ISO 12100', 'EN 60204-1']) check(one[0].text.includes(s), `shows standard "${s}"`)
  check(one[0].text.includes('Example Notified Body, NB 1234'), 'shows the notified body')
  check(one[0].text.includes('Harmonised standards applied') && one[0].text.includes('Notified body'), 'has the optional sections when filled in')
  check(one[0].text.includes('Ankit Luthra') && one[0].text.includes('Place: Belfast, PEI, Canada'), 'shows place and signer')
  check(one[0].images >= 1, 'draws the signature picture')
  check(one[0].text.includes('DoC-CWR-4175-2026-v1') && one[0].text.includes('Page 1 of 1'), 'footer has the number and page')
  check(one[0].text.includes('fulfils all the relevant provisions'), 'shows the declaration sentence from the template')

  console.log('Combined PDF of three machines (Letter), different directive lists:')
  const combo = await pages(
    await buildCePdf(
      [
        { data: data('4175', THREE), number: 'DoC-CWR-4175-2026-v1', signature, paper: 'letter' },
        { data: data('4176', THREE.slice(0, 2)), number: 'DoC-CWR-4176-2026-v1', signature, paper: 'letter' },
        { data: data('4177', THREE, { standards: [], notified_body: null }), number: 'DoC-CWR-4177-2026-v1', signature, paper: 'letter' },
      ],
      null,
    ),
  )
  check(combo.length === 3, 'one page per machine')
  for (const d of THREE) check(combo[0].text.includes(d) && combo[2].text.includes(d), `"${d}" on machines 1 and 3`)
  check(!combo[1].text.includes('EMC Directive'), 'machine 2 shows only its own two directives')
  check(!combo[2].text.includes('Harmonised standards') && !combo[2].text.includes('Notified body'), 'empty optional sections are left out')
  check(combo.every((p) => p.images >= 1), 'every page has the signature')

  console.log('Template text without a browser:')
  check(richTextParagraphs('<p>A &amp; B</p><p>Two<br>lines</p>').join('|') === 'A & B|Two\nlines', 'rich text becomes plain paragraphs')
} catch (e) {
  failures++
  console.error(e)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) {
  console.error(`\n✗ CE declaration PDF test: ${failures} problem${failures === 1 ? '' : 's'}.`)
  process.exit(1)
}
console.log('\n✓ CE declaration PDF test passed.')
