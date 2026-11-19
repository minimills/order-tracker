// @permission-scope settings.mailbox
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '../../lib/auth'
import { confirmAction } from '../../lib/confirm'
import { callFunction } from '../../lib/edgeFunction'
import { friendlyError } from '../../lib/format'
import { forgetSender, type Mailbox } from '../../lib/sender'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import Can from '../Can'
import { buttonClass, Field, inputClass, narrowInputClass, secondaryButtonClass } from '../form'
import SenderLine from '../email/SenderLine'

type Form = { from_address: string; from_name: string; smtp_host: string; smtp_port: string; smtp_security: 'ssl' | 'starttls'; smtp_username: string; password: string; save_sent: boolean; imap_host: string; imap_port: string }

const blank = (email: string, name: string): Form => ({
  from_address: email, from_name: name, smtp_host: '', smtp_port: '465', smtp_security: 'ssl', smtp_username: email, password: '', save_sent: true, imap_host: '', imap_port: '993',
})

/**
 * Settings → Email: the mailbox the emails I send from the app (reminders,
 * certificates, quotes…) go out from. The password is stored encrypted in
 * Supabase Vault and never shown again. Without a mailbox, my emails come from
 * the office address with my name and Reply-To = my email.
 */
export default function MyMailbox() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [saved, setSaved] = useState<Mailbox | null | undefined>(undefined)
  const [f, setF] = useState<Form>(blank(me, ''))
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  // Bumped so the "From" line checks again after a change.
  const [senderKey, setSenderKey] = useState(0)

  // Bumped to read the saved settings again.
  const [reloads, setReloads] = useState(0)
  const load = async () => setReloads((n) => n + 1)
  useEffect(() => {
    if (!supabase) return
    let live = true
    Promise.all([supabase.rpc('my_mailbox'), supabase.rpc('current_user_name')]).then(([{ data, error }, { data: name }]) => {
      if (!live) return
      if (error) return void toast.error(friendlyError(error))
      const m = (data as Mailbox | null) ?? null
      setSaved(m)
      setF(
        m
          ? { from_address: m.from_address, from_name: m.from_name ?? '', smtp_host: m.smtp_host, smtp_port: String(m.smtp_port), smtp_security: m.smtp_security, smtp_username: m.smtp_username, password: '', save_sent: m.save_sent, imap_host: m.imap_host ?? '', imap_port: String(m.imap_port) }
          : blank(me, typeof name === 'string' ? name : ''),
      )
    })
    return () => {
      live = false
    }
  }, [me, reloads])

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const changed = () => {
    forgetSender()
    setSenderKey((n) => n + 1)
  }

  async function save() {
    if (!supabase) return
    if (!saved?.has_password && !f.password) return toast.error('Enter the password of the mailbox.')
    setBusy(true)
    const { error } = await supabase.rpc('save_my_mailbox', {
      p: { ...f, smtp_port: Number(f.smtp_port) || 465, imap_port: Number(f.imap_port) || 993, password: f.password || null },
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Mailbox saved. Send a test email to check it.')
    setEditing(false)
    changed()
    await load()
  }

  async function test() {
    setBusy(true)
    const r = await callFunction<{ message?: string }>('send-email', { action: 'mailbox_test' })
    setBusy(false)
    await load()
    changed()
    if (!r.ok) return toast.error(r.message)
    toast.success(r.message || 'Test email sent.')
  }

  async function remove() {
    if (!supabase) return
    if (!(await confirmAction('Disconnect your mailbox? The saved password is deleted, and your emails are sent from the office address again (with your name and your email for replies).', { confirmLabel: 'Disconnect Mailbox', danger: true }))) return
    setBusy(true)
    const { error } = await supabase.rpc('remove_my_mailbox')
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Mailbox disconnected.')
    changed()
    await load()
  }

  if (saved === undefined) return <p className="text-sm text-slate-500">Loading…</p>
  const showForm = editing || !saved

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        Emails you send from the app (reminders, certificates, service reports, declarations, freight quotes) go out from the address below. Connect your own mailbox to send them from
        your own address, with a copy in your own Sent folder. Without one, they come from the office address with your name, and replies come to your email.
      </p>
      <SenderLine key={senderKey} showLink={false} />

      {saved && !editing && (
        <div className="rounded-md border border-slate-200 p-3">
          <p className="font-medium break-all">{saved.from_name ? `${saved.from_name} <${saved.from_address}>` : saved.from_address}</p>
          <p className="text-slate-600 break-all">
            {saved.smtp_host}, port {saved.smtp_port} ({saved.smtp_security === 'ssl' ? 'SSL / TLS' : 'STARTTLS'}), user name {saved.smtp_username}. Password saved (hidden).
          </p>
          <p className={saved.status === 'error' ? 'text-red-700' : saved.status === 'ok' ? 'text-green-700' : 'text-slate-600'}>
            {saved.status === 'ok' ? 'Working: the last email went out.' : saved.status === 'error' ? `Not working: ${saved.last_error ?? 'the last email could not be sent.'}` : 'Not tested yet. Send a test email.'}
          </p>
          <Can permission="settings.mailbox" level="edit">
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={buttonClass} onClick={test} disabled={busy}>
                {busy ? 'Sending…' : 'Send Test Email'}
              </button>
              <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)} disabled={busy}>
                Change Settings
              </button>
              <button type="button" className={`${secondaryButtonClass} text-red-700`} onClick={remove} disabled={busy}>
                Disconnect Mailbox
              </button>
            </div>
          </Can>
        </div>
      )}

      {showForm && (
        <Can permission="settings.mailbox" level="edit">
          <div className="space-y-3 rounded-md border border-slate-200 p-3">
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label="Your email address" htmlFor="mb-from">
                <input id="mb-from" type="email" className={inputClass} value={f.from_address} onChange={set('from_address')} />
              </Field>
              <Field label="Your name (sender name)" htmlFor="mb-name">
                <input id="mb-name" className={inputClass} maxLength={80} value={f.from_name} onChange={set('from_name')} />
              </Field>
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label="Outgoing mail server (SMTP)" htmlFor="mb-host" hint="For example mail.minimills.net">
                <input id="mb-host" className={inputClass} autoCapitalize="none" value={f.smtp_host} onChange={set('smtp_host')} />
              </Field>
              <Field label="Port and security" htmlFor="mb-port">
                <div className="flex gap-2">
                  <input id="mb-port" inputMode="numeric" className={`${narrowInputClass} w-20 flex-none`} value={f.smtp_port} onChange={set('smtp_port')} />
                  <select
                    aria-label="Security"
                    className={`${narrowInputClass} min-w-0 flex-1`}
                    value={f.smtp_security}
                    onChange={(e) => setF((x) => ({ ...x, smtp_security: e.target.value as Form['smtp_security'], smtp_port: e.target.value === 'ssl' ? '465' : '587' }))}
                  >
                    <option value="ssl">SSL / TLS (port 465)</option>
                    <option value="starttls">STARTTLS (port 587)</option>
                  </select>
                </div>
              </Field>
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label="User name" htmlFor="mb-user" hint="Usually your full email address.">
                <input id="mb-user" className={inputClass} autoCapitalize="none" autoComplete="off" value={f.smtp_username} onChange={set('smtp_username')} />
              </Field>
              <Field label="Password" htmlFor="mb-password" hint={saved?.has_password ? 'Saved and hidden. Leave empty to keep it.' : 'Stored encrypted. It is never shown again.'}>
                <input id="mb-password" type="password" className={inputClass} autoComplete="new-password" value={f.password} onChange={set('password')} />
              </Field>
            </div>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={f.save_sent} onChange={(e) => setF((x) => ({ ...x, save_sent: e.target.checked }))} />
              <span>Save a copy of each email in my Sent folder (IMAP)</span>
            </label>
            {f.save_sent && (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
                <Field label="Incoming mail server (IMAP)" htmlFor="mb-imap" hint="Leave empty when it is the same as the outgoing server.">
                  <input id="mb-imap" className={inputClass} autoCapitalize="none" value={f.imap_host} onChange={set('imap_host')} />
                </Field>
                <Field label="IMAP port (SSL)" htmlFor="mb-imap-port">
                  <input id="mb-imap-port" inputMode="numeric" className={inputClass} value={f.imap_port} onChange={set('imap_port')} />
                </Field>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {saved && (
                <button type="button" className={secondaryButtonClass} onClick={() => {
                    void load()
                    setEditing(false)
                  }} disabled={busy}>
                  {ACTION.cancel}
                </button>
              )}
              <button type="button" className={buttonClass} onClick={save} disabled={busy}>
                {busy ? ACTION.saving : saved ? ACTION.save : 'Connect Mailbox'}
              </button>
            </div>
          </div>
        </Can>
      )}
    </div>
  )
}
