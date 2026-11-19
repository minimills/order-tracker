// @permission-scope reminders.send
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useCompany } from '../../lib/company'
import { showDate } from '../../lib/dates'
import { callFunction } from '../../lib/edgeFunction'
import { fillTemplate, fillTemplateHtml, loadEmailTemplates, REMINDER_KEYS, splitEmails, type EmailTemplates } from '../../lib/emailTemplates'
import { formatMoney, friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import RichTextEditor from '../RichTextEditor'
import SenderLine from '../email/SenderLine'
import { isEmptyRichText } from '../../lib/richText'

type Data = {
  order_id: string
  order_number: string
  quote_number: string | null
  invoice_number: string | null
  currency: string
  order_total: number | null
  outstanding: number | null
  expected_ship_date: string | null
  original_ship_date: string | null
  customer_name: string | null
  customer_company: string | null
  customer_emails: string[]
  payment_id: string | null
  payment_type: string | null
  amount: number | null
  due_date: string | null
  days_overdue: number | null
  payments: { id: string; payment_type: string; remaining: number; due_date: string | null }[]
}
type Sent = { id: string; template: string; to_emails: string[]; subject: string; status: 'sent' | 'failed'; sent_by_name: string | null; sent_at: string }

/** The template that fits the payment: overdue, down payment due, balance due, else the ship date update. */
function guess(d: Data) {
  if (!d.payment_id) return 'ship_date_update'
  if ((d.days_overdue ?? 0) > 0) return 'overdue'
  return /down/i.test(d.payment_type ?? '') ? 'down_payment_due' : 'balance_due'
}

/**
 * Send Reminder: an email to the customer about a payment or the ship date,
 * written from a template (Admin → Email Templates), previewed and editable
 * before it is sent. Every reminder is kept on the order.
 */
export default function ReminderDialog({ orderId, paymentId, onClose }: { orderId: string; paymentId?: string | null; onClose: () => void }) {
  const company = useCompany()
  const [data, setData] = useState<Data | null>(null)
  const [tpl, setTpl] = useState<EmailTemplates | null>(null)
  const [me, setMe] = useState('')
  const [payment, setPayment] = useState<string | null>(paymentId ?? null)
  const [template, setTemplate] = useState('')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  // Bumped when the template writes the message again (the editor starts from the new text).
  const [bodyVersion, setBodyVersion] = useState(0)
  const [sent, setSent] = useState<Sent[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supabase) return
    loadEmailTemplates().then(setTpl)
    supabase.rpc('current_user_name').then(({ data: n }) => setMe(typeof n === 'string' ? n : ''))
    supabase
      .from('order_reminders')
      .select('id, template, to_emails, subject, status, sent_by_name, sent_at')
      .eq('order_id', orderId)
      .order('sent_at', { ascending: false })
      .limit(5)
      .then(({ data: rows }) => setSent((rows as Sent[] | null) ?? []))
  }, [orderId])

  useEffect(() => {
    if (!supabase) return
    supabase.rpc('reminder_data', { p_order: orderId, p_payment: payment }).then(({ data: d, error }) => {
      if (error) return setProblem(friendlyError(error))
      const v = d as Data
      setData(v)
      setTo((x) => x || (v.customer_emails ?? []).join(', '))
      setTemplate((t) => t || guess(v))
    })
  }, [orderId, payment])

  const values = useMemo(() => {
    if (!data) return {}
    const money = (n: number | null) => (n == null ? '' : formatMoney(Number(n), data.currency))
    const date = (d: string | null) => (d ? showDate(d, 'MMMM d, yyyy') : 'to be confirmed')
    return {
      customer_name: data.customer_name ?? '',
      customer_company: data.customer_company || data.customer_name || '',
      order_number: data.order_number,
      invoice_number: data.invoice_number ?? '',
      quote_number: data.quote_number ?? '',
      payment_type: (data.payment_type ?? 'payment').toLowerCase(),
      amount: money(data.amount),
      due_date: date(data.due_date),
      days_overdue: String(data.days_overdue ?? 0),
      order_total: money(data.order_total),
      outstanding: money(data.outstanding),
      expected_ship_date: date(data.expected_ship_date),
      original_ship_date: date(data.original_ship_date),
      sender_name: me,
      company_name: company.name || 'Belfast Mini Mills',
    } as Record<string, string>
  }, [data, me, company.name])

  // Write the email again when the template, the payment or the order details change.
  useEffect(() => {
    const t = tpl?.reminders[template]
    if (!t || !data) return
    // Filling the form from the template is the point of this effect.
    // oxlint-disable-next-line react/set-state-in-effect
    setSubject(fillTemplate(t.subject, values))
    // oxlint-disable-next-line react/set-state-in-effect
    setBody(fillTemplateHtml(t.body, values))
    // oxlint-disable-next-line react/set-state-in-effect
    setBodyVersion((n) => n + 1)
  }, [tpl, template, data, values])

  async function send() {
    if (!splitEmails(to).length) return toast.error('Enter at least one email address in To.')
    if (!subject.trim() || isEmptyRichText(body)) return toast.error('The email needs a subject and a message.')
    setBusy(true)
    const r = await callFunction<{ message?: string }>('send-email', {
      action: 'reminder_send', order_id: orderId, payment_id: data?.payment_id ?? null, template,
      to: splitEmails(to), cc: splitEmails(cc), bcc: splitEmails(bcc), subject: subject.trim(), body,
    })
    setBusy(false)
    if (!r.ok) return toast.error(r.message)
    toast.success(r.message || 'Reminder sent.')
    onClose()
  }

  return (
    <Modal
      title={data ? `Send Reminder – Order ${data.order_number}` : 'Send Reminder'}
      onClose={onClose}
      busy={busy}
      wide
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={send} disabled={busy || !data || !tpl}>
            {busy ? 'Sending…' : 'Send Email'}
          </button>
        </>
      }
    >
      {problem ? (
        <p className="rounded bg-red-50 p-3 text-sm text-red-800">{problem}</p>
      ) : !data || !tpl ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Template" htmlFor="rm-template" hint="Choosing a template writes the email again.">
              <select id="rm-template" className={inputClass} value={template} onChange={(e) => setTemplate(e.target.value)}>
                {REMINDER_KEYS.filter((k) => tpl.reminders[k]).map((k) => (
                  <option key={k} value={k}>
                    {tpl.reminders[k].name}
                  </option>
                ))}
              </select>
            </Field>
            {data.payments.length > 0 && (
              <Field label="Payment" htmlFor="rm-payment">
                <select id="rm-payment" className={inputClass} value={data.payment_id ?? ''} onChange={(e) => setPayment(e.target.value || null)}>
                  {data.payments.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.payment_type} · {formatMoney(Number(p.remaining), data.currency)}
                      {p.due_date ? ` · due ${showDate(p.due_date)}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          {!data.customer_emails?.length && <p className="rounded bg-amber-50 p-2 text-amber-900">This customer has no email address saved. Type it in To.</p>}
          <Field label="To" htmlFor="rm-to" hint="Separate several addresses with commas.">
            <input id="rm-to" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="CC" htmlFor="rm-cc">
              <input id="rm-cc" className={inputClass} value={cc} onChange={(e) => setCc(e.target.value)} />
            </Field>
            <Field label="BCC" htmlFor="rm-bcc">
              <input id="rm-bcc" className={inputClass} value={bcc} onChange={(e) => setBcc(e.target.value)} />
            </Field>
          </div>
          <Field label="Subject" htmlFor="rm-subject">
            <input id="rm-subject" className={inputClass} maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message" hint="This is what the customer receives, on the company letterhead. Change anything before sending.">
            <RichTextEditor key={bodyVersion} label="Message" minHeight="12rem" value={body} onChange={setBody} />
          </Field>
          <SenderLine />
          {sent.length > 0 && (
            <Can permission="reminders">
              <div className="rounded border border-slate-200 p-2">
                <p className="mb-1 font-medium">Reminders Sent Before</p>
                <ul className="space-y-0.5 text-xs text-slate-700">
                  {sent.map((s) => (
                    <li key={s.id}>
                      <span className={s.status === 'sent' ? '' : 'text-red-700'}>{s.status === 'sent' ? 'Sent' : 'Not sent'}</span> {showDate(s.sent_at.slice(0, 10))} to {s.to_emails.join(', ')}: {s.subject}
                      {s.sent_by_name ? ` (${s.sent_by_name})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </Can>
          )}
        </div>
      )}
    </Modal>
  )
}
