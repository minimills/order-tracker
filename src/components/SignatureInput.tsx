// @permission-scope checklist.sign, service.certificate.sign, ce.issue
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePermissions } from '../lib/permissions'
import { loadMySignature, mySignatureBlob, type SavedSignature } from '../lib/signatures'
import Can from './Can'
import SignaturePad, { type SignaturePadHandle } from './checklist/SignaturePad'

export type SignatureResult = { blob: Blob; savedId: string | null }
export type SignatureInputHandle = {
  isEmpty: () => boolean
  /** The picture to put on the document, and which saved signature it is (null = drawn). */
  get: () => Promise<SignatureResult | null>
  clear: () => void
}

/**
 * Where the signed-in person signs: "Use my saved signature" (when they have
 * one and are allowed) or "Draw signature". Customers always draw
 * (allowSaved = false).
 */
const SignatureInput = forwardRef<SignatureInputHandle, { disabled?: boolean; allowSaved?: boolean }>(function SignatureInput({ disabled, allowSaved = true }, ref) {
  const { can } = usePermissions()
  const pad = useRef<SignaturePadHandle>(null)
  const mayUseSaved = allowSaved && can('settings.signature')
  const [saved, setSaved] = useState<SavedSignature | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [mode, setMode] = useState<'saved' | 'draw'>('draw')

  useEffect(() => {
    if (!mayUseSaved) return
    let stop = false
    let url: string | null = null
    loadMySignature().then(async (s) => {
      if (stop || !s) return
      const b = await mySignatureBlob(s)
      if (stop || !b) return
      url = URL.createObjectURL(b)
      setSaved(s)
      setBlob(b)
      setPreview(url)
      setMode('saved')
    })
    return () => {
      stop = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [mayUseSaved])

  useImperativeHandle(ref, () => ({
    isEmpty: () => (mode === 'saved' ? !blob : (pad.current?.isEmpty() ?? true)),
    clear: () => pad.current?.clear(),
    get: async () => {
      if (mode === 'saved' && saved && blob) return { blob, savedId: saved.id }
      const png = await pad.current?.toPng()
      return png ? { blob: png, savedId: null } : null
    },
  }))

  return (
    <div className="space-y-2">
      {mayUseSaved && saved && (
        <Can permission="settings.signature">
          <div role="radiogroup" aria-label="How to sign" className="inline-flex rounded-md border border-slate-300 p-0.5 text-sm">
            {(['saved', 'draw'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={disabled}
                onClick={() => setMode(m)}
                className={`rounded px-3 py-1 ${mode === m ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {m === 'saved' ? 'Use My Saved Signature' : 'Draw Signature'}
              </button>
            ))}
          </div>
        </Can>
      )}
      {mode === 'saved' && preview ? (
        <div className="keep-light flex h-40 items-center justify-center rounded-md border-2 border-slate-300 bg-white p-2 sm:h-48">
          <img src={preview} alt="Your saved signature" className="max-h-full max-w-full object-contain" />
        </div>
      ) : (
        <>
          <SignaturePad ref={pad} disabled={disabled} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="text-xs underline" onClick={() => pad.current?.clear()} disabled={disabled}>
              Clear
            </button>
            {mayUseSaved && !saved && (
              <Can permission="settings.signature" level="edit">
                <Link to="/settings?find=my-signature" className="text-xs text-slate-600 underline">
                  Save a signature in Settings to sign with one click
                </Link>
              </Can>
            )}
          </div>
        </>
      )}
      {mode === 'saved' && saved && <p className="text-xs text-slate-500">Your saved signature (version {saved.version}) is copied onto this document. Only you can use it.</p>}
    </div>
  )
})

export default SignatureInput
