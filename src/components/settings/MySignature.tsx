// @permission-scope settings.signature
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { toast } from 'sonner'
import { useAuth } from '../../lib/auth'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { showDate, todayISO } from '../../lib/dates'
import {
  cleanSignature,
  fileToCanvas,
  loadMySignature,
  mySignatureBlob,
  removeMySignature,
  saveMySignature,
  type Crop,
  type SavedSignature,
} from '../../lib/signatures'
import Can from '../Can'
import { buttonClass, secondaryButtonClass } from '../form'

/**
 * Settings → My Signature: upload a scanned signature (PNG, JPG or PDF), crop
 * it, see it cleaned on a sample document, save, replace or remove it.
 */
export default function MySignature() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [saved, setSaved] = useState<SavedSignature | null>(null)
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const [source, setSource] = useState<HTMLCanvasElement | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [cleaned, setCleaned] = useState<{ blob: Blob; dataUrl: string; width: number; height: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const s = await loadMySignature()
    setSaved(s)
    const b = s ? await mySignatureBlob(s) : null
    setSavedUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return b ? URL.createObjectURL(b) : null
    })
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function pick(file: File | undefined) {
    if (!file) return
    setError(null)
    setCleaned(null)
    setBusy(true)
    try {
      const c = await fileToCanvas(file)
      setSource(c)
      const whole = { x: 0, y: 0, w: c.width, h: c.height }
      setCrop(whole)
      setCleaned(await cleanSignature(c, whole))
    } catch (e) {
      setSource(null)
      setError((e as Error).message || 'The file could not be read.')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function applyCrop(c: Crop) {
    if (!source) return
    setCrop(c)
    setError(null)
    try {
      setCleaned(await cleanSignature(source, c))
    } catch (e) {
      setCleaned(null)
      setError((e as Error).message)
    }
  }

  async function save() {
    if (!cleaned) return
    setBusy(true)
    try {
      await saveMySignature(me, cleaned, saved)
      toast.success(saved ? 'Your signature was replaced. Documents already signed keep the old one.' : 'Your signature was saved.')
      setSource(null)
      setCleaned(null)
      await load()
    } catch (e) {
      toast.error(friendlyError(e as Error))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!(await confirmAction('Remove your saved signature? Documents you already signed keep their copy.', { confirmLabel: 'Remove Signature', danger: true }))) return
    setBusy(true)
    try {
      await removeMySignature()
      toast.success('Your saved signature was removed.')
      await load()
    } catch (e) {
      toast.error(friendlyError(e as Error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        Upload a scan or photo of your signature on white paper. Only you can see or use it; others only see it on documents you signed.
      </p>
      {!source && (
        <div className="flex flex-wrap items-center gap-4">
          {savedUrl ? (
            <div className="keep-light flex h-20 w-56 items-center justify-center rounded border border-slate-200 bg-white p-1">
              <img src={savedUrl} alt="Your saved signature" className="max-h-full max-w-full object-contain" />
            </div>
          ) : (
            <p className="text-slate-500">You have no saved signature.</p>
          )}
          {saved && (
            <p className="text-xs text-slate-500">
              Version {saved.version}, saved {showDate(saved.created_at.slice(0, 10))}
            </p>
          )}
        </div>
      )}
      <Can permission="settings.signature" level="edit">
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,application/pdf,.pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0])} aria-label="Signature file" />
        {!source && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? 'Reading…' : saved ? 'Replace Signature' : 'Upload Signature'}
            </button>
            {saved && (
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={remove}>
                Remove Signature
              </button>
            )}
          </div>
        )}
        {source && crop && (
          <div className="space-y-3">
            <div>
              <h3 className="font-medium">1. Select the signature</h3>
              <p className="text-xs text-slate-500">Drag a box around your signature. The edges are trimmed and the white paper is removed automatically.</p>
              <Cropper source={source} crop={crop} onCrop={applyCrop} />
              <button type="button" className="mt-1 text-xs underline" onClick={() => applyCrop({ x: 0, y: 0, w: source.width, h: source.height })}>
                Select the Whole Picture
              </button>
            </div>
            {error && <p className="text-sm text-red-700">{error}</p>}
            {cleaned && (
              <div>
                <h3 className="font-medium">2. Check it on a sample document</h3>
                <SampleDocument image={cleaned.dataUrl} />
                <p className="mt-1 text-xs text-slate-500">
                  {cleaned.width} × {cleaned.height} pixels, {Math.round(cleaned.blob.size / 1024)} KB.
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass} disabled={busy || !cleaned} onClick={save}>
                {busy ? 'Saving…' : 'Save Signature'}
              </button>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => { setSource(null); setCleaned(null); setError(null) }}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {!source && error && <p className="text-sm text-red-700">{error}</p>}
      </Can>
    </div>
  )
}

/** The uploaded picture with a box that can be dragged around the signature. */
/* @layout-helper */
function Cropper({ source, crop, onCrop }: { source: HTMLCanvasElement; crop: Crop; onCrop: (c: Crop) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [url] = useState(() => source.toDataURL('image/jpeg', 0.85))
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const toSource = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * source.width,
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * source.height,
    }
  }
  const shown = drag ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : crop
  return (
    <div
      ref={box}
      className="keep-light relative mt-1 max-w-xl cursor-crosshair touch-none overflow-hidden rounded border border-slate-300 bg-white select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        const p = toSource(e)
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, ...((p) => ({ x1: p.x, y1: p.y }))(toSource(e)) })}
      onPointerUp={() => {
        if (drag && Math.abs(drag.x1 - drag.x0) > 10 && Math.abs(drag.y1 - drag.y0) > 10) onCrop(shown)
        setDrag(null)
      }}
    >
      <img src={url} alt="Uploaded signature" className="block w-full" draggable={false} />
      <div
        className="pointer-events-none absolute border-2 border-blue-600 bg-blue-500/10"
        style={{ left: `${(shown.x / source.width) * 100}%`, top: `${(shown.y / source.height) * 100}%`, width: `${(shown.w / source.width) * 100}%`, height: `${(shown.h / source.height) * 100}%` }}
      />
    </div>
  )
}

/** A small mock document with the signature on its signature line. */
/* @layout-helper */
function SampleDocument({ image }: { image: string }) {
  return (
    <div className="keep-light mt-1 max-w-md rounded border border-slate-300 bg-white p-4 font-serif text-[11px] text-slate-800 shadow-sm">
      <div className="text-center text-sm font-bold">Sample Document</div>
      <div className="mt-2 space-y-1">
        <div className="h-1.5 w-full rounded bg-slate-200" />
        <div className="h-1.5 w-11/12 rounded bg-slate-200" />
        <div className="h-1.5 w-4/5 rounded bg-slate-200" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <div className="flex h-14 items-end">
            <img src={image} alt="Your signature on the sample document" className="max-h-14 max-w-full object-contain" />
          </div>
          <div className="border-t border-slate-800 pt-0.5">Signature</div>
        </div>
        <div className="self-end">
          <div className="border-t border-slate-800 pt-0.5">Date: {showDate(todayISO())}</div>
        </div>
      </div>
    </div>
  )
}
