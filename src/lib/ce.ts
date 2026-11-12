/**
 * CE / EU Declarations of Conformity (migration 0039): one per machine,
 * numbered DoC-<model>-<serial>-<year>-v<version>, locked once issued. The PDF
 * is made in the browser from the saved data (cePdf.ts), never stored.
 */
import type { CeRenderItem } from './cePdf'
import { blobToDataUrl } from './signatures'
import { supabase } from './supabase'
import { makeZip } from './zip'

export type CeKind = 'ec_2006' | 'eu_2023'
export const CE_KIND_LABEL: Record<CeKind, string> = {
  ec_2006: 'EC Declaration of Conformity (Machinery Directive 2006/42/EC)',
  eu_2023: 'EU Declaration of Conformity (Machinery Regulation (EU) 2023/1230)',
}
/** The EU Machinery Regulation applies from this day. */
export const EU_REGULATION_DATE = '2027-01-20'

export type CeSettings = {
  declaration_type: CeKind
  paper: 'a4' | 'letter'
  brand: string
  authorised_person: string
  place: string
  signer: string
  notified_body: string
  email_subject: string
  email_message: string
}
export const DEFAULT_CE_SETTINGS: CeSettings = {
  declaration_type: 'ec_2006',
  paper: 'a4',
  brand: 'Belfast Mini Mills Limited',
  authorised_person: '',
  place: 'Belfast, PEI, Canada',
  signer: 'Ankit Luthra – General Manager, Belfast Mini Mills Ltd.',
  notified_body: '',
  email_subject: '{title} – Belfast Mini Mills – {customer_company} – {machines}',
  email_message: '',
}

/** Everything one declaration says (a snapshot kept on the issued declaration). */
export type CeData = {
  kind: CeKind
  title: string
  declaration_html: string
  closing_html: string
  manufacturer: { name: string; address: string | null; phone: string | null; contact_person: string; email: string | null; website: string | null }
  authorised_person: string
  machine: { product: string; brand: string; model: string | null; serial_number: string | null; serial: string; voltage: string | null; year: number; type_name: string }
  directives: string[]
  standards: string[]
  notified_body: string | null
  place: string
  date: string
  signer: string
  order_id: string
  order_code: string
  customer_name: string
  customer_company: string | null
  problems?: string[]
}

export type CeDeclaration = {
  id: string
  machine_id: string
  order_id: string
  number: string
  version: number
  kind: CeKind
  status: 'issued' | 'superseded'
  replaces: string | null
  data: CeData
  paper: 'a4' | 'letter'
  signature_path: string
  signature_source: 'saved' | 'drawn'
  signature_version: number | null
  signed_by_name: string | null
  issued_at: string
  issued_by_name: string | null
  superseded_at: string | null
}

export type CeSend = {
  id: string
  order_id: string | null
  declaration_ids: string[]
  to_emails: string[]
  cc_emails: string[]
  bcc_emails: string[]
  subject: string | null
  combined: boolean
  status: 'sent' | 'failed'
  error: string | null
  sent_by: string | null
  sent_at: string
}

export async function loadCeSettings(): Promise<CeSettings> {
  if (!supabase) return DEFAULT_CE_SETTINGS
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'ce').maybeSingle()
  return { ...DEFAULT_CE_SETTINGS, ...((data?.value as Partial<CeSettings>) ?? {}) }
}

/** "HKT 0001" */
export const machineShort = (d: CeData) => `${d.machine.model ?? ''} ${d.machine.serial}`.trim()

/** Signature pictures of issued declarations, as data URLs (one download per picture). */
const sigCache = new Map<string, Promise<string | null>>()
export function declarationSignature(path: string) {
  if (!sigCache.has(path)) {
    sigCache.set(
      path,
      (async () => {
        if (!supabase) return null
        const { data } = await supabase.storage.from('ce-signatures').download(path)
        return data ? blobToDataUrl(data) : null
      })(),
    )
  }
  return sigCache.get(path)!
}

/**
 * THE single way any declaration becomes a PDF (preview, print, download and
 * email): the same renderer (cePdf.ts buildCePdf) and the same CeData. Issued
 * declarations use their saved snapshot; a preview uses ce_declaration_data(),
 * the function that also makes that snapshot when a declaration is issued.
 */
export async function renderDeclarations(items: CeRenderItem[], logo: string | null) {
  const { buildCePdf } = await import('./cePdf')
  return buildCePdf(items, logo)
}

/** Render items for issued declarations (with their own signature copy). */
async function issuedItems(decls: CeDeclaration[]): Promise<CeRenderItem[]> {
  return Promise.all(decls.map(async (d) => ({ data: d.data, number: d.number, signature: await declarationSignature(d.signature_path), paper: d.paper })))
}

export const combinedName = (decls: CeDeclaration[]) =>
  decls.length === 1
    ? `${decls[0].number}.pdf`
    : new Set(decls.map((d) => d.order_id)).size === 1
      ? `Declarations of Conformity - Order ${decls[0].data.order_code}.pdf`
      : 'Declarations of Conformity.pdf'

/** The PDFs of issued declarations: one per machine, or one combined file (one page per machine). */
export async function declarationPdfs(decls: CeDeclaration[], logo: string | null, combined: boolean) {
  const items = await issuedItems(decls)
  if (combined || items.length === 1) return [{ file_name: combinedName(decls), bytes: await renderDeclarations(items, logo) }]
  return Promise.all(items.map(async (it, i) => ({ file_name: `${decls[i].number}.pdf`, bytes: await renderDeclarations([it], logo) })))
}

/** Download: one combined PDF, or a ZIP of separate PDFs. */
export async function downloadDeclarations(decls: CeDeclaration[], logo: string | null, mode: 'combined' | 'zip') {
  const { downloadPdf } = await import('./certificatePdf')
  if (mode === 'combined' || decls.length === 1) {
    const [f] = await declarationPdfs(decls, logo, true)
    return downloadPdf(f.bytes, f.file_name)
  }
  const files = await declarationPdfs(decls, logo, false)
  const zip = makeZip(files.map((f) => ({ name: f.file_name, bytes: f.bytes })))
  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = combinedName(decls).replace(/\.pdf$/, '.zip')
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Print: every selected declaration in one print job. */
export async function printDeclarations(decls: CeDeclaration[], logo: string | null) {
  const [f] = await declarationPdfs(decls, logo, true)
  printPdf(f.bytes)
}

/** Preview (not issued yet): CeData from ce_declaration_data(), same renderer. */
export async function previewDeclarations(datas: CeData[], signature: string | null, paper: 'a4' | 'letter', logo: string | null) {
  return renderDeclarations(datas.map((data) => ({ data, number: null, signature, paper })), logo)
}

/** Opens the browser's print box for a PDF. */
export function printPdf(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.src = url
  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
    } catch {
      window.open(url, '_blank')
    }
  }
  document.body.appendChild(frame)
  setTimeout(() => {
    frame.remove()
    URL.revokeObjectURL(url)
  }, 120_000)
}

/** Opens a PDF in a new tab (preview). */
export function openPdf(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const w = window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 120_000)
  return Boolean(w)
}
