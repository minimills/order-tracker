// @permission-scope ce.email
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { declarationPdfs, type CeDeclaration } from '../../lib/ce'
import { toBase64 } from '../../lib/certificatePdf'
import { useCompany } from '../../lib/company'
import { callFunction } from '../../lib/edgeFunction'
import { Field, Modal, buttonClass, inputClass, secondaryButtonClass } from '../form'

type Preview = { to: string[]; cc: string[]; subject: string; message: string; warnings: string[] }
const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)

/** Email declarations of conformity: To / CC / BCC, subject, message, one PDF per machine or one combined PDF. */
export default function CeEmailDialog({ declarations, onClose, onSent }: { declarations: CeDeclaration[]; onClose: () => void; onSent: () => void }) {
  const company = useCompany()
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [combined, setCombined] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    callFunction<Preview>('send-email', { action: 'ce_preview', declaration_ids: declarations.map((d) => d.id) }).then((r) => {
      setLoading(false)
      if (!r.ok) {
        setWarnings([r.message])
        return
      }
      setTo(r.data.to.join(', '))
      setCc(r.data.cc.join(', '))
      setSubject(r.data.subject)
      setMessage(r.data.message)
      setWarnings(r.data.warnings ?? [])
    })
  }, [declarations])

  async function send() {
    if (!split(to).length) return toast.error('Enter at least one email address in To.')
    if (!subject.trim()) return toast.error('Enter a subject.')
    setBusy(true)
    try {
      const files = await declarationPdfs(declarations, company.logo, combined)
      const r = await callFunction('send-email', {
        action: 'ce_send',
        declaration_ids: declarations.map((d) => d.id),
        to: split(to),
        cc: split(cc),
        bcc: split(bcc),
        subject: subject.trim(),
        message,
        combined,
        attachments: files.map((x) => ({ file_name: x.file_name, pdf_base64: toBase64(x.bytes) })),
      })
      if (!r.ok) return toast.error(r.message)
      toast.success(r.message || 'Sent.')
      onSent()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Email Declarations of Conformity"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={send} disabled={busy || loading}>
            {busy ? 'Sending…' : 'Send Email'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">{declarations.map((d) => d.number).join(', ')}</p>
        {warnings.map((w) => (
          <p key={w} className="rounded bg-amber-50 px-2 py-1 text-amber-900">
            {w}
          </p>
        ))}
        <Field label="To" htmlFor="ce-to" hint="Separate several addresses with commas. The customer’s email is filled in.">
          <input id="ce-to" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="CC" htmlFor="ce-cc" hint="The office email is filled in.">
          <input id="ce-cc" className={inputClass} value={cc} onChange={(e) => setCc(e.target.value)} />
        </Field>
        <Field label="BCC" htmlFor="ce-bcc">
          <input id="ce-bcc" className={inputClass} value={bcc} onChange={(e) => setBcc(e.target.value)} />
        </Field>
        <Field label="Subject" htmlFor="ce-subject">
          <input id="ce-subject" className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" htmlFor="ce-message">
          <textarea id="ce-message" rows={7} className={inputClass} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        {declarations.length > 1 && (
          <fieldset className="space-y-1">
            <legend className="font-medium">Attachments</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="ce-files" checked={!combined} onChange={() => setCombined(false)} /> One PDF per machine
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="ce-files" checked={combined} onChange={() => setCombined(true)} /> One combined PDF
            </label>
          </fieldset>
        )}
      </div>
    </Modal>
  )
}
