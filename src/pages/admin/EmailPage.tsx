// @permission-scope admin.email
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import Can from '../../components/Can'
import { buttonClass, Field, inputClass, narrowInputClass, secondaryButtonClass } from '../../components/form'
import { useAuth } from '../../lib/auth'
import { confirmAction } from '../../lib/confirm'
import { activityTime } from '../../lib/activity'
import { callFunction } from '../../lib/edgeFunction'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { loadSetting } from '../../lib/useSchedule'

type Status = {
  smtp_host: boolean
  smtp_user: boolean
  smtp_password: boolean
  from_name: boolean
  save_sent: boolean
  push: boolean
  app_url: string
  mailbox: string | null
}
type Schedule = {
  scheduled: boolean
  last_run: { at: string; status: string; message: string } | null
  pending_email: number
  pending_push: number
  failed_today: number
}
type EmailSettings = { digest_hour: number; throttle_minutes: number; group_minutes: number }
const DEFAULTS: EmailSettings = { digest_hour: 7, throttle_minutes: 10, group_minutes: 2 }

/* @layout-helper */
function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 inline-block w-24 shrink-0 rounded px-1.5 text-center text-xs font-medium ${ok ? 'bg-green-100 text-green-800' : ok === null ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-900'}`}>
        {ok ? 'Done' : ok === null ? 'Unknown' : 'Not set up'}
      </span>
      <span>{children}</span>
    </li>
  )
}

/** Admin → Email: set-up checklist, test email, automatic sending, timing, phone push keys. */
export default function EmailPage() {
  const { session } = useAuth()
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [to, setTo] = useState(session?.user.email ?? '')
  const [settings, setSettings] = useState<EmailSettings>(DEFAULTS)
  const [keys, setKeys] = useState<{ publicKey: string; privateKey: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const loadStatus = useCallback(async (check = false) => {
    const r = await callFunction<Status>('send-email', { action: 'status', check })
    if (r.ok) {
      setStatus(r.data)
      setStatusError(null)
    } else setStatusError(r.message)
  }, [])
  const loadSchedule = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.rpc('email_schedule_status')
    if (!error) setSchedule(data as Schedule)
  }, [])
  useEffect(() => {
    // These only set state after the server answers.
    // oxlint-disable-next-line react/set-state-in-effect
    loadStatus()
    loadSchedule()
    loadSetting('email', DEFAULTS).then(setSettings)
  }, [loadStatus, loadSchedule])

  async function checkMailbox() {
    setBusy('check')
    await loadStatus(true)
    setBusy(null)
  }
  async function sendTest(e: FormEvent) {
    e.preventDefault()
    setBusy('test')
    const r = await callFunction('send-email', { action: 'test', to: to.trim() })
    setBusy(null)
    if (r.ok) toast.success(r.message, { duration: 8000 })
    else toast.error(r.message, { duration: 12000 })
  }
  async function sendNow() {
    setBusy('dispatch')
    const r = await callFunction<Record<string, unknown>>('send-email', { action: 'dispatch' })
    setBusy(null)
    if (!r.ok) return toast.error(r.message, { duration: 12000 })
    const email = (r.data.email ?? {}) as { sent?: number; digests?: number; failed?: number }
    const push = (r.data.push ?? {}) as { sent?: number }
    toast.success(`Sent ${email.sent ?? 0} email(s), ${email.digests ?? 0} daily summary(ies) and ${push.sent ?? 0} phone notification(s).${email.failed ? ` ${email.failed} failed (see Email Log).` : ''}`)
    loadSchedule()
  }
  async function turnOn() {
    if (!supabase) return
    setBusy('schedule')
    const base = (import.meta.env.VITE_SUPABASE_URL as string).replace(/\/+$/, '')
    const { error } = await supabase.rpc('start_email_schedule', { p_supabase_url: base })
    setBusy(null)
    if (error) return toast.error(friendlyError(error), { duration: 12000 })
    toast.success('Automatic sending is on. Due notifications are sent every minute.')
    loadSchedule()
  }
  async function turnOff() {
    if (!supabase) return
    if (!(await confirmAction('Turn off automatic sending? Emails and phone notifications wait until it is turned on again.', { confirmLabel: 'Turn Off' }))) return
    setBusy('schedule')
    const { error } = await supabase.rpc('stop_email_schedule')
    setBusy(null)
    if (error) return toast.error(friendlyError(error))
    toast.success('Automatic sending is off.')
    loadSchedule()
  }
  async function saveSettings(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const ok = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi
    if (!ok(settings.digest_hour, 0, 23) || !ok(settings.throttle_minutes, 1, 240) || !ok(settings.group_minutes, 0, 30))
      return toast.error('Check the numbers: summary hour 0 to 23, minutes between emails 1 to 240, gathering time 0 to 30.')
    const { error } = await supabase.from('app_settings').upsert({ key: 'email', value: settings })
    if (error) return toast.error(friendlyError(error))
    toast.success('Email settings saved.')
  }
  /** Makes a new key pair for phone push in this browser (nothing is sent anywhere). */
  async function makeKeys() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    setKeys({ publicKey: b64(raw), privateKey: jwk.d! })
  }
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied.`)
  }

  const mailOk = status ? status.smtp_host && status.smtp_user && status.smtp_password : null
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <AdminPageHeader title="Email">
        Notification emails are sent through the company mailbox, and phone notifications through the installed app. Each
        person chooses what they receive in Settings → Notifications.
      </AdminPageHeader>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Set-Up Checklist</h2>
        {statusError && <p className="mt-2 text-amber-800">{statusError}</p>}
        <ul className="mt-2 space-y-1.5">
          <Check ok={statusError ? false : mailOk}>Mailbox details saved as Supabase secrets (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).</Check>
          <Check ok={status ? status.from_name : null}>Sender name saved (SMTP_FROM_NAME), for example Belfast Mini Mills.</Check>
          <Check ok={status?.mailbox === 'ok' ? true : status?.mailbox ? false : null}>
            Mailbox login checked{status?.mailbox && status.mailbox !== 'ok' ? `: ${status.mailbox}` : '.'}{' '}
            <button type="button" className="ml-1 text-blue-700 underline disabled:opacity-50" disabled={busy !== null || !mailOk} onClick={checkMailbox}>
              {busy === 'check' ? 'Checking…' : 'Check Now'}
            </button>
          </Check>
          <Check ok={status ? status.push : null}>Phone notification keys saved (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY).</Check>
          <Check ok={schedule ? schedule.scheduled : null}>Automatic sending turned on (below).</Check>
        </ul>
        {status && (
          <p className="mt-2 text-xs text-slate-500">
            Buttons in emails open {status.app_url}. A copy of each email is {status.save_sent ? '' : 'not '}saved in the
            mailbox’s Sent folder.
          </p>
        )}
      </section>

      <form onSubmit={sendTest} className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Send a Test Email</h2>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Send to" htmlFor="test-to" className="min-w-64 flex-1">
            <input id="test-to" type="email" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <button type="submit" className={buttonClass} disabled={busy !== null}>
            {busy === 'test' ? 'Sending…' : 'Send Test Email'}
          </button>
        </div>
      </form>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Automatic Sending</h2>
        <p className="mt-1 text-slate-600">
          When on, the database checks every minute for notifications to send by email or phone, and every 10 minutes for
          cards that are due soon or overdue.
        </p>
        {schedule && (
          <ul className="mt-2 space-y-0.5 text-slate-700">
            <li>
              Status: <strong>{schedule.scheduled ? 'On' : 'Off'}</strong>
            </li>
            {schedule.last_run && (
              <li>
                Last run: {activityTime.format(new Date(schedule.last_run.at))} ({schedule.last_run.status})
              </li>
            )}
            <li>
              Waiting to be sent: {schedule.pending_email} email update(s), {schedule.pending_push} phone notification(s)
            </li>
            <li>Failed emails in the last 24 hours: {schedule.failed_today}</li>
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {schedule?.scheduled ? (
            <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={turnOff}>
              Turn Off Automatic Sending
            </button>
          ) : (
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={turnOn}>
              Turn On Automatic Sending
            </button>
          )}
          <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={sendNow}>
            {busy === 'dispatch' ? 'Sending…' : 'Send Due Notifications Now'}
          </button>
          <Can permission="admin.email_log">
            <Link to="/admin/email-log" className={secondaryButtonClass}>
              Email Log
            </Link>
          </Can>
        </div>
      </section>

      <form onSubmit={saveSettings} className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Timing</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <Field label="Daily summary is sent at (hour, 0–23)" htmlFor="digest-hour">
            <input id="digest-hour" type="number" min={0} max={23} className={narrowInputClass + ' w-24'} value={settings.digest_hour} onChange={(e) => setSettings({ ...settings, digest_hour: Number(e.target.value) })} />
          </Field>
          <Field label="Minutes between emails about the same card" htmlFor="throttle">
            <input id="throttle" type="number" min={1} max={240} className={narrowInputClass + ' w-24'} value={settings.throttle_minutes} onChange={(e) => setSettings({ ...settings, throttle_minutes: Number(e.target.value) })} />
          </Field>
          <Field label="Minutes to gather quick changes into one email" htmlFor="gather">
            <input id="gather" type="number" min={0} max={30} className={narrowInputClass + ' w-24'} value={settings.group_minutes} onChange={(e) => setSettings({ ...settings, group_minutes: Number(e.target.value) })} />
          </Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">Times are Atlantic time (Halifax). Changes apply to new notifications.</p>
        <button type="submit" className={`${buttonClass} mt-3`}>
          Save Changes
        </button>
      </form>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="font-semibold">Phone Notification Keys</h2>
        <p className="mt-1 text-slate-600">
          Phone notifications need a pair of keys, made once. Click the button, then save both keys as Supabase secrets
          (VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY). The keys are made in this browser and are not sent or stored anywhere.
          Do not make new keys later: phones that already have notifications enabled would stop receiving them.
        </p>
        {!keys ? (
          <button type="button" className={`${secondaryButtonClass} mt-2`} onClick={makeKeys}>
            Create Keys
          </button>
        ) : (
          <div className="mt-2 space-y-2">
            <Field label="VAPID_PUBLIC_KEY">
              <div className="flex gap-2">
                <input readOnly aria-label="Public key" className={`${inputClass} font-mono text-xs`} value={keys.publicKey} />
                <button type="button" className={secondaryButtonClass} onClick={() => copy(keys.publicKey, 'Public key')}>
                  Copy
                </button>
              </div>
            </Field>
            <Field label="VAPID_PRIVATE_KEY (keep it private)">
              <div className="flex gap-2">
                <input readOnly aria-label="Private key" className={`${inputClass} font-mono text-xs`} value={keys.privateKey} />
                <button type="button" className={secondaryButtonClass} onClick={() => copy(keys.privateKey, 'Private key')}>
                  Copy
                </button>
              </div>
            </Field>
          </div>
        )}
      </section>
    </div>
  )
}
