// @permission-scope admin.users
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Perms } from '../../lib/permissions'
import { composeWelcome, sendWelcome, type WelcomeUser } from '../../lib/welcome'
import { ACTION } from '../../lib/wording'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import RichTextEditor from '../RichTextEditor'
import SenderLine from '../email/SenderLine'
import { isEmptyRichText } from '../../lib/richText'
import { tr } from '../../i18n'

/** Admin → Users → Welcome Email: preview, change and send (or send again) the welcome email. */
export default function WelcomeEmailDialog({ user, perms, companyName, onClose }: { user: WelcomeUser; perms: Perms; companyName: string; onClose: () => void }) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    composeWelcome(user, perms, companyName).then((m) => {
      setSubject(m.subject)
      setBody(m.body)
      setReady(true)
    })
  }, [user, perms, companyName])

  async function send() {
    if (!subject.trim() || isEmptyRichText(body)) return toast.error(tr("The email needs a subject and a message."))
    setBusy(true)
    const r = await sendWelcome(user.email, subject.trim(), body)
    setBusy(false)
    if (!r.ok) return toast.error(r.message)
    toast.success(r.message || tr("Welcome email sent."))
    onClose()
  }

  return (
    <Modal
      title={tr("Welcome Email for {{value}}", { value: user.name || user.email })}
      onClose={onClose}
      busy={busy}
      wide
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={send} disabled={busy || !ready}>
            {busy ? tr("Sending…") : tr("Send Welcome Email")}
          </button>
        </>
      }
    >
      {!ready ? (
        <p className="text-sm text-slate-500">{tr("Loading…")}</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">
            {tr("To")} <strong className="break-all">{user.email}</strong>{tr(", on the company letterhead with a button to open the app. The list of features follows their permissions now. The standard text is set in Admin → Email Templates.")}
          </p>
          <Field label={tr("Subject")} htmlFor="we-subject">
            <input id="we-subject" className={inputClass} maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <SenderLine />
          <Field label={tr("Message")}>
            <RichTextEditor label={tr("Message")} minHeight="16rem" value={body} onChange={setBody} />
          </Field>
        </div>
      )}
    </Modal>
  )
}
