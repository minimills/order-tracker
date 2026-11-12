/**
 * Saved signatures (migration 0039). Each person may keep one signature
 * picture in the private Storage bucket "user-signatures" (folder = their
 * email). Only the owner can read or use it. When they sign a document with
 * it, a copy goes into that document's own bucket, so the document keeps the
 * version it was signed with even if the saved signature changes later.
 */
import { supabase } from './supabase'

export const SAVED_SIGNATURE_BUCKET = 'user-signatures'
/** Saved signatures (and their copies on documents) stay under this size. */
export const MAX_SAVED_SIGNATURE_BYTES = 100 * 1024

export type SavedSignature = {
  id: string
  user_email: string
  version: number
  storage_path: string
  width: number | null
  height: number | null
  status: 'active' | 'replaced' | 'removed'
  created_at: string
}

/** My current signature (the table only ever shows the owner's own rows). */
export async function loadMySignature(): Promise<SavedSignature | null> {
  if (!supabase) return null
  const { data } = await supabase.from('user_signatures').select('*').eq('status', 'active').maybeSingle()
  return (data as SavedSignature | null) ?? null
}

/** The picture of my saved signature (owner only). */
export async function mySignatureBlob(sig: SavedSignature): Promise<Blob | null> {
  if (!supabase) return null
  const { data } = await supabase.storage.from(SAVED_SIGNATURE_BUCKET).download(sig.storage_path)
  return data ?? null
}

export const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

// ---------------------------------------------------------------------------
// Reading a scanned signature
// ---------------------------------------------------------------------------
const MAX_SOURCE = 2400

/** A PNG, JPG or PDF (first page) drawn on a canvas, at most 2400 px wide or high. */
export async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  if (isPdf) {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(MAX_SOURCE / base.width, MAX_SOURCE / base.height, 4)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas
  }
  if (!/^image\/(png|jpe?g)$/.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) throw new Error('Choose a PNG, JPG or PDF file.')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('The picture could not be read. Try a PNG or JPG file.'))
      i.src = url
    })
    const scale = Math.min(MAX_SOURCE / img.naturalWidth, MAX_SOURCE / img.naturalHeight, 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

export type Crop = { x: number; y: number; w: number; h: number }

/**
 * Turns the cropped part of a scan into a clean signature: trims the empty
 * edges, makes the paper transparent (ink keeps its colour, faint edges fade
 * smoothly) and shrinks it until the PNG is under 100 KB.
 */
export async function cleanSignature(source: HTMLCanvasElement, crop: Crop): Promise<{ blob: Blob; dataUrl: string; width: number; height: number }> {
  const cx = Math.max(0, Math.round(crop.x))
  const cy = Math.max(0, Math.round(crop.y))
  const cw = Math.max(1, Math.min(source.width - cx, Math.round(crop.w)))
  const ch = Math.max(1, Math.min(source.height - cy, Math.round(crop.h)))
  const img = source.getContext('2d')!.getImageData(cx, cy, cw, ch)
  const d = img.data
  const n = cw * ch
  // Paper brightness = the bright end of the picture; ink = the dark end.
  const lum = new Uint8ClampedArray(n)
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const l = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2])
    lum[i] = l
    hist[l]++
  }
  const pct = (p: number) => {
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc >= n * p) return v
    }
    return 255
  }
  const paper = Math.max(pct(0.6), 120)
  const ink = Math.min(pct(0.02), paper - 40)
  const cut = paper - 35 // anything lighter than this is paper
  // Trim to the ink.
  let minX = cw, minY = ch, maxX = -1, maxY = -1
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      if (lum[y * cw + x] < cut) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
  if (maxX < 0) throw new Error('No signature was found in the selected area. Select the part with the signature.')
  const pad = 6
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(cw - 1, maxX + pad)
  maxY = Math.min(ch - 1, maxY + pad)
  const tw = maxX - minX + 1
  const th = maxY - minY + 1
  const out = new ImageData(tw, th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const si = (minY + y) * cw + (minX + x)
      const oi = (y * tw + x) * 4
      const a = Math.max(0, Math.min(1, (cut - lum[si]) / Math.max(1, cut - ink)))
      out.data[oi] = d[si * 4]
      out.data[oi + 1] = d[si * 4 + 1]
      out.data[oi + 2] = d[si * 4 + 2]
      out.data[oi + 3] = Math.round(Math.pow(a, 0.8) * 255)
    }
  const full = document.createElement('canvas')
  full.width = tw
  full.height = th
  full.getContext('2d')!.putImageData(out, 0, 0)
  // Shrink: at most 900 × 300, smaller until under 100 KB.
  let scale = Math.min(1, 900 / tw, 300 / th)
  for (let tries = 0; tries < 12; tries++) {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(tw * scale))
    c.height = Math.max(1, Math.round(th * scale))
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(full, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
    if (blob && blob.size <= MAX_SAVED_SIGNATURE_BYTES) return { blob, dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height }
    scale *= 0.8
  }
  throw new Error('The signature could not be made small enough. Select a smaller area.')
}

// ---------------------------------------------------------------------------
// Saving, removing and using it
// ---------------------------------------------------------------------------
export async function saveMySignature(email: string, cleaned: { blob: Blob; width: number; height: number }, old: SavedSignature | null) {
  if (!supabase) throw new Error('Not connected')
  const path = `${email.toLowerCase()}/${Date.now()}.png`
  const up = await supabase.storage.from(SAVED_SIGNATURE_BUCKET).upload(path, cleaned.blob, { contentType: 'image/png' })
  if (up.error) throw up.error
  const { error } = await supabase.rpc('save_my_signature', { p_path: path, p_width: cleaned.width, p_height: cleaned.height })
  if (error) {
    await supabase.storage.from(SAVED_SIGNATURE_BUCKET).remove([path])
    throw error
  }
  // Documents keep their own copy, so the old picture can go.
  if (old) await supabase.storage.from(SAVED_SIGNATURE_BUCKET).remove([old.storage_path])
}

export async function removeMySignature() {
  if (!supabase) throw new Error('Not connected')
  const { data: path, error } = await supabase.rpc('remove_my_signature')
  if (error) throw error
  if (path) await supabase.storage.from(SAVED_SIGNATURE_BUCKET).remove([String(path)])
}
