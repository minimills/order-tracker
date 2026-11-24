// @permission-scope settings.change_email
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '../../lib/auth'
import { confirmAction } from '../../lib/confirm'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { buttonClass, inputClass, secondaryButtonClass } from '../form'
import { tr } from '../../i18n'

type Pending = { new_email: string; requested_at: string }

/**
 * Settings → Change Sign-in Email. Supabase emails a confirmation link to the
 * old and to the new address; the change applies only when both are confirmed.
 * Admins are told when it is asked for and when it is done.
 */
export default function ChangeEmail() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase || !me) return
    const { data } = await supabase.from('email_change_requests').select('new_email, requested_at').eq('old_email', me).eq('status', 'pending').order('requested_at', { ascending: false }).limit(1)
    setPending(((data as Pending[] | null) ?? [])[0] ?? null)
  }, [me])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function change() {
    if (!supabase) return
    const next = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) return toast.error(tr("Enter the new email address in full, for example name@minimills.net"))
    if (!(await confirmAction(tr("Change your sign-in email to {{next}}? A confirmation link is emailed to {{me}} and to {{next2}}. You keep signing in with {{me2}} until both links have been opened.", { next: next, me: me, next2: next, me2: me }), { get confirmLabel() {
    return tr("Send Confirmation Emails")
  } }))) return
    setBusy(true)
    const { error } = await supabase.rpc('request_email_change', { p_new: next })
    if (error) {
      setBusy(false)
      return toast.error(friendlyError(error))
    }
    const { error: authError } = await supabase.auth.updateUser({ email: next }, { emailRedirectTo: window.location.origin + window.location.pathname })
    setBusy(false)
    if (authError) {
      await supabase.rpc('cancel_my_email_change')
      return toast.error(tr("The confirmation emails could not be sent: {{message}}", { message: authError.message }))
    }
    setEmail('')
    toast.success(tr("Confirmation links were emailed to {{me}} and to {{next}}. Open both to finish.", { me: me, next: next }), { duration: 10000 })
    load()
  }

  async function cancel() {
    if (!supabase) return
    const { error } = await supabase.rpc('cancel_my_email_change')
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("The change was cancelled. You keep your sign-in email."))
    load()
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        {tr("You sign in as")} <strong className="break-all">{me}</strong>{tr(". To change it, a confirmation link goes to the old and to the new address; it changes only when both are opened. Your history and permissions stay with you.")}
      </p>
      {pending ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900" role="status">
          <p>
            {tr("Waiting for both confirmations to change to")} <strong className="break-all">{pending.new_email}</strong> {tr("(asked")} {showDate(pending.requested_at.slice(0, 10))}{tr("). Check both inboxes, and the spam folders.")}
          </p>
          <button type="button" className={secondaryButtonClass} onClick={cancel}>
            {tr("Cancel the Change")}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input id="new-sign-in-email" type="email" aria-label={tr("New sign-in email")} autoComplete="off" placeholder={tr("New email address")} className={`${inputClass} max-w-xs`} value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="button" className={buttonClass} onClick={change} disabled={busy || !email.trim()}>
            {busy ? tr("Sending…") : tr("Change Sign-in Email")}
          </button>
        </div>
      )}
    </div>
  )
}
