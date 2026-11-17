// @permission-scope admin.email_templates
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { EMAIL_TEMPLATE_DEFAULTS, loadEmailTemplates, REMINDER_KEYS, REMINDER_PLACEHOLDERS, WELCOME_PLACEHOLDERS, type EmailTemplates } from '../../lib/emailTemplates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'

const PLACEHOLDERS = '{customer_company} (the customer’s company, or their name when there is none), {customer_name}, {order_number}, {title}, {company_name}'
const card = 'space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm'

const DOCS: { key: 'certificate' | 'service_report'; title: string; text: string }[] = [
  { key: 'certificate', title: 'Commissioning Certificate', text: 'Used when a signed commissioning certificate is emailed from its page.' },
  { key: 'service_report', title: 'Service Report', text: 'Used when a signed service report (from a service call) is emailed from its page.' },
]

/**
 * Admin → Email Templates: who customer emails come from and where replies go,
 * the customer reminders, the welcome email for new users, and the subject and
 * CC of the certificate and service report emails.
 */
export default function EmailTemplatesPage() {
  const [t, setT] = useState<EmailTemplates | null>(null)
  const [saved, setSaved] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadEmailTemplates().then((v) => {
      setT(v)
      setSaved(JSON.stringify(v))
    })
  }, [])

  async function save() {
    if (!supabase || !t) return
    setBusy(true)
    const { error } = await supabase.rpc('set_email_templates', { p: t })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setSaved(JSON.stringify(t))
    toast.success('Email templates saved.')
  }

  if (!t) return <p className="text-sm text-slate-500">Loading…</p>
  const dirty = JSON.stringify(t) !== saved
  const setReminder = (k: string, patch: Partial<{ name: string; subject: string; body: string }>) => setT({ ...t, reminders: { ...t.reminders, [k]: { ...t.reminders[k], ...patch } } })

  return (
    <div className="space-y-4">
      <AdminPageHeader title="Email Templates">
        The wording of emails the app sends to customers and to new users. The person sending can still change the text, the recipients and the subject before sending.
      </AdminPageHeader>
      <div className="max-w-3xl space-y-4">
        <section className={card} data-setting="et-sender">
          <div>
            <h2 className="text-base font-semibold">Sender of Customer Reminders</h2>
            <p className="text-slate-600">Who a reminder comes from and where the customer’s reply goes. Leave a box empty to use the mailbox that sends the app’s emails.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From name" htmlFor="et-from-name" hint="For example Belfast Mini Mills Accounts.">
              <input id="et-from-name" className={inputClass} maxLength={80} value={t.from_name} onChange={(e) => setT({ ...t, from_name: e.target.value })} />
            </Field>
            <Field label="From address" htmlFor="et-from-address" hint="Only an address your mailbox is allowed to send as; otherwise the email may be refused or land in spam.">
              <input id="et-from-address" type="email" className={inputClass} value={t.from_address} onChange={(e) => setT({ ...t, from_address: e.target.value })} />
            </Field>
          </div>
          <Field label="Reply-to address" htmlFor="et-reply-to" hint="Customer replies go here, for example the accounts mailbox.">
            <input id="et-reply-to" type="email" className={inputClass} value={t.reply_to} onChange={(e) => setT({ ...t, reply_to: e.target.value })} />
          </Field>
        </section>

        <section className={card} data-setting="et-reminders">
          <div>
            <h2 className="text-base font-semibold">Customer Reminders</h2>
            <p className="text-slate-600">
              Used by “Send Reminder” on an order and on the Payments page. Placeholders: {REMINDER_PLACEHOLDERS}.
            </p>
          </div>
          {REMINDER_KEYS.filter((k) => t.reminders[k]).map((k) => (
            <div key={k} className="rounded-md border border-slate-200">
              <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-medium" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
                <span>
                  {open === k ? '▾' : '▸'} {t.reminders[k].name}
                </span>
                <span className="truncate text-xs font-normal text-slate-500">{t.reminders[k].subject}</span>
              </button>
              {open === k && (
                <div className="space-y-3 border-t border-slate-200 p-3">
                  <Field label="Name in the list" htmlFor={`et-r-${k}-name`}>
                    <input id={`et-r-${k}-name`} className={inputClass} maxLength={60} value={t.reminders[k].name} onChange={(e) => setReminder(k, { name: e.target.value })} />
                  </Field>
                  <Field label="Subject" htmlFor={`et-r-${k}-subject`}>
                    <input id={`et-r-${k}-subject`} className={inputClass} maxLength={300} value={t.reminders[k].subject} onChange={(e) => setReminder(k, { subject: e.target.value })} />
                  </Field>
                  <Field label="Message" htmlFor={`et-r-${k}-body`}>
                    <textarea id={`et-r-${k}-body`} rows={10} maxLength={8000} className={inputClass} value={t.reminders[k].body} onChange={(e) => setReminder(k, { body: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          ))}
        </section>

        <section className={card} data-setting="et-welcome">
          <div>
            <h2 className="text-base font-semibold">Welcome Email for New Users</h2>
            <p className="text-slate-600">
              Sent when a user is added in Admin → Users, and with “Welcome Email” there (with a preview). Placeholders: {WELCOME_PLACEHOLDERS}. {'{features}'} becomes the list of
              pages that person is allowed to use.
            </p>
          </div>
          <Field label="Subject" htmlFor="et-welcome-subject">
            <input id="et-welcome-subject" className={inputClass} maxLength={300} value={t.welcome.subject} onChange={(e) => setT({ ...t, welcome: { ...t.welcome, subject: e.target.value } })} />
          </Field>
          <Field label="Message" htmlFor="et-welcome-body">
            <textarea id="et-welcome-body" rows={16} maxLength={8000} className={inputClass} value={t.welcome.body} onChange={(e) => setT({ ...t, welcome: { ...t.welcome, body: e.target.value } })} />
          </Field>
        </section>

        {DOCS.map((d) => (
          <section key={d.key} className={card} data-setting={`et-${d.key}`}>
            <div>
              <h2 className="text-base font-semibold">{d.title}</h2>
              <p className="text-slate-600">{d.text}</p>
            </div>
            <Field label="Subject" htmlFor={`et-${d.key}-subject`} hint={`Placeholders: ${PLACEHOLDERS}.`}>
              <input id={`et-${d.key}-subject`} className={inputClass} maxLength={300} value={t[`${d.key}_subject`]} onChange={(e) => setT({ ...t, [`${d.key}_subject`]: e.target.value })} />
            </Field>
            <Field label="Default CC" htmlFor={`et-${d.key}-cc`} hint="Separate several addresses with commas. {office_email} = the office email from Admin → Company Details. Leave empty for no CC.">
              <input id={`et-${d.key}-cc`} className={inputClass} value={t[`${d.key}_cc`]} onChange={(e) => setT({ ...t, [`${d.key}_cc`]: e.target.value })} />
            </Field>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => setT({ ...t, [`${d.key}_subject`]: EMAIL_TEMPLATE_DEFAULTS[`${d.key}_subject`], [`${d.key}_cc`]: EMAIL_TEMPLATE_DEFAULTS[`${d.key}_cc`] })}
            >
              Use the Standard Wording
            </button>
          </section>
        ))}

        <button type="button" className={buttonClass} onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : ACTION.save}
        </button>
      </div>
    </div>
  )
}
