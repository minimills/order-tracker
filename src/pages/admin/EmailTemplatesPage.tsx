// @permission-scope admin.email_templates
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'

type EmailTemplates = {
  certificate_subject: string
  certificate_cc: string
  service_report_subject: string
  service_report_cc: string
}

const EMAIL_TEMPLATE_DEFAULTS: EmailTemplates = {
  certificate_subject: 'Commissioning Certificate Belfast Mini Mills – {customer_company}',
  certificate_cc: '{office_email}',
  service_report_subject: 'Service Report Belfast Mini Mills – {customer_company}',
  service_report_cc: '{office_email}',
}

const PLACEHOLDERS = '{customer_company} (the customer’s company, or their name when there is none), {customer_name}, {order_number}, {title}, {company_name}'

const DOCS: { key: 'certificate' | 'service_report'; title: string; text: string }[] = [
  { key: 'certificate', title: 'Commissioning Certificate', text: 'Used when a signed commissioning certificate is emailed from its page.' },
  { key: 'service_report', title: 'Service Report', text: 'Used when a signed service report (from a service call) is emailed from its page.' },
]

/** Admin → Email Templates: default subject and CC of the certificate and service report emails. */
export default function EmailTemplatesPage() {
  const [t, setT] = useState<EmailTemplates | null>(null)
  const [saved, setSaved] = useState<EmailTemplates | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase
      ?.from('app_settings')
      .select('value')
      .eq('key', 'email_templates')
      .maybeSingle()
      .then(({ data }) => {
        const v = { ...EMAIL_TEMPLATE_DEFAULTS, ...((data?.value as Partial<EmailTemplates> | null) ?? {}) }
        setT(v)
        setSaved(v)
      })
  }, [])

  async function save() {
    if (!supabase || !t) return
    setBusy(true)
    const { error } = await supabase.rpc('set_email_templates', { p: t })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setSaved(t)
    toast.success('Email templates saved.')
  }

  const dirty = JSON.stringify(t) !== JSON.stringify(saved)

  return (
    <div className="space-y-4">
      <AdminPageHeader title="Email Templates">
        The subject and CC filled in when a commissioning certificate or service report is emailed. The person sending can still change
        To, CC, BCC and the subject before sending.
      </AdminPageHeader>
      {!t ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="max-w-3xl space-y-4">
          {DOCS.map((d) => (
            <section key={d.key} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting={`et-${d.key}`}>
              <div>
                <h2 className="text-base font-semibold">{d.title}</h2>
                <p className="text-slate-600">{d.text}</p>
              </div>
              <Field label="Subject" htmlFor={`et-${d.key}-subject`} hint={`Placeholders: ${PLACEHOLDERS}.`}>
                <input
                  id={`et-${d.key}-subject`}
                  className={inputClass}
                  maxLength={300}
                  value={t[`${d.key}_subject`]}
                  onChange={(e) => setT({ ...t, [`${d.key}_subject`]: e.target.value })}
                />
              </Field>
              <Field
                label="Default CC"
                htmlFor={`et-${d.key}-cc`}
                hint="Separate several addresses with commas. {office_email} = the office email from Admin → Company Details. Leave empty for no CC."
              >
                <input id={`et-${d.key}-cc`} className={inputClass} value={t[`${d.key}_cc`]} onChange={(e) => setT({ ...t, [`${d.key}_cc`]: e.target.value })} />
              </Field>
            </section>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={save} disabled={busy || !dirty}>
              {busy ? 'Saving…' : ACTION.save}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setT({ ...EMAIL_TEMPLATE_DEFAULTS })} disabled={busy}>
              Use the Standard Wording
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
