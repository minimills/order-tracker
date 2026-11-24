// @permission-scope service.certificate
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import SignatureInput, { type SignatureInputHandle } from '../components/SignatureInput'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../components/form'
import RichText from '../components/RichText'
import RichTextEditor from '../components/RichTextEditor'
import SenderLine from '../components/email/SenderLine'
import SerialNumber from '../components/SerialNumber'
import { useCompany } from '../lib/company'
import { confirmAction } from '../lib/confirm'
import { showDate, todayISO } from '../lib/dates'
import { callFunction } from '../lib/edgeFunction'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import {
  certificateFileName,
  documentReference,
  certificateValues,
  fillPlaceholders,
  PLACEHOLDERS,
  signatureDataUrl,
  type CertMachine,
  type Certificate,
  type CompanyInfo,
} from '../lib/service'
import { supabase } from '../lib/supabase'
import { tr } from '../i18n'

type Editable = Pick<Certificate, 'title' | 'part1' | 'part2' | 'machines' | 'start_date' | 'end_date' | 'site_address' | 'tech_name'>
type Send = { id: string; to_emails: string[]; cc_emails?: string[] | null; bcc_emails?: string[] | null; subject?: string | null; status: 'sent' | 'failed'; error: string | null; sent_by: string | null; sent_at: string }
type Preview = { to: string[]; cc: string[]; bcc: string[]; subject: string; html: string; warnings: string[]; file_name: string }
type Recipients = { to: string; cc: string; bcc: string; subject: string }
const splitEmails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
const pick = (c: Certificate): Editable => ({
  title: c.title,
  part1: c.part1,
  part2: c.part2,
  machines: c.machines,
  start_date: c.start_date,
  end_date: c.end_date,
  site_address: c.site_address,
  tech_name: c.tech_name,
})

/** One commissioning certificate or service report: draft editing, signatures, PDF and email. */
export default function CertificatePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const liveCompany = useCompany()
  const { can } = usePermissions()
  const [cert, setCert] = useState<Certificate | null>(null)
  useBreadcrumbs(
    cert && [
      { get label() {
    return tr("Service / Training")
  }, to: '/service' },
      { label: documentReference(cert), to: cert.order_id ? `/service/${cert.order_id}?tab=certificate` : `/service/calls/${cert.service_call_id}?tab=certificate` },
      { label: cert.title },
    ],
  )
  const [edit, setEdit] = useState<Editable | null>(null)
  const [versions, setVersions] = useState<Pick<Certificate, 'id' | 'version' | 'status'>[]>([])
  const [sends, setSends] = useState<Send[]>([])
  const [sigs, setSigs] = useState<{ tech: string | null; customer: string | null }>({ tech: null, customer: null })
  const [saving, setSaving] = useState(false)
  const [newRow, setNewRow] = useState({ machine: '', serial: '' })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [rcpt, setRcpt] = useState<Recipients>({ to: '', cc: '', bcc: '', subject: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const today = todayISO()

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('service_certificates').select('*').eq('id', id).maybeSingle()
    if (error) toast.error(friendlyError(error))
    const c = data as Certificate | null
    setCert(c)
    setEdit(c ? pick(c) : null)
    if (!c) return
    const [v, s, tech, customer] = await Promise.all([
      supabase.from('service_certificates').select('id, version, status').eq(c.order_id ? 'order_id' : 'service_call_id', c.order_id ?? c.service_call_id!).order('version', { ascending: false }),
      supabase.from('certificate_sends').select('*').eq('certificate_id', c.id).order('sent_at', { ascending: false }),
      signatureDataUrl(c.tech_signature_path),
      signatureDataUrl(c.customer_signature_path),
    ])
    setVersions((v.data as typeof versions | null) ?? [])
    setSends((s.data as Send[] | null) ?? [])
    setSigs({ tech, customer })
  }, [id])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (!cert || !edit) return <p className="p-6 text-center text-slate-500">{tr("Loading…")}</p>

  const noun = cert.kind === 'service_report' ? tr("service report") : 'certificate'
  const company: CompanyInfo = cert.locked_at && cert.info.company ? cert.info.company : liveCompany
  const anySigned = Boolean(cert.tech_signed_at || cert.customer_signed_at)
  const editable = cert.status === 'draft' && !anySigned
  const canText = editable && can('service.certificate.edit_text', 'edit')
  const canMachines = editable && can('service.certificate.machines', 'edit')
  const canDetails = editable && can('service.certificate.details', 'edit')
  const dirty = JSON.stringify(edit) !== JSON.stringify(pick(cert))
  const shown: Certificate = { ...cert, ...edit }
  const values = certificateValues(shown, company, today)

  async function save() {
    if (!supabase || !edit || !cert) return
    if (edit.start_date && edit.end_date && edit.end_date < edit.start_date) return toast.error(tr("The end date must be on or after the start date."))
    const patch: Partial<Editable> = {}
    for (const k of Object.keys(edit) as (keyof Editable)[]) {
      if (JSON.stringify(edit[k]) !== JSON.stringify(cert[k])) (patch as Record<string, unknown>)[k] = edit[k]
    }
    setSaving(true)
    const { error } = await supabase.from('service_certificates').update(patch).eq('id', cert.id)
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${noun[0].toUpperCase()}${noun.slice(1)} saved.`)
    load()
  }

  const setMachines = (machines: CertMachine[]) => setEdit({ ...edit, machines })
  const toggleRow = (key: string, removed: boolean) => setMachines(edit.machines.map((m) => (m.key === key ? { ...m, removed } : m)))
  const addRow = () => {
    if (!newRow.machine.trim()) return toast.error(tr("Type the machine."))
    setMachines([...edit.machines, { key: crypto.randomUUID(), machine_id: null, machine: newRow.machine.trim(), serial: newRow.serial.trim() || null, removed: false }])
    setNewRow({ machine: '', serial: '' })
  }

  async function makePdf() {
    const { buildCertificatePdf } = await import('../lib/certificatePdf')
    return buildCertificatePdf(cert!, company, sigs, today)
  }

  async function download() {
    setBusy('pdf')
    try {
      const { downloadPdf } = await import('../lib/certificatePdf')
      downloadPdf(await makePdf(), certificateFileName(cert!))
    } catch (e) {
      toast.error(tr("The PDF could not be made: {{message}}", { message: (e as Error).message }))
    }
    setBusy(null)
  }

  async function openEmail() {
    setBusy('preview')
    const r = await callFunction<Preview>('send-email', { action: 'certificate_preview', certificate_id: cert!.id, file_name: certificateFileName(cert!) })
    setBusy(null)
    if (!r.ok) return toast.error(r.message)
    setPreview(r.data)
    setRcpt({ to: r.data.to.join(', '), cc: (r.data.cc ?? []).join(', '), bcc: (r.data.bcc ?? []).join(', '), subject: r.data.subject })
  }

  async function sendEmail() {
    if (!splitEmails(rcpt.to).length) return toast.error(tr("Enter at least one email address in To."))
    if (!rcpt.subject.trim()) return toast.error(tr("Enter a subject."))
    setBusy('send')
    try {
      const { toBase64 } = await import('../lib/certificatePdf')
      const pdf = toBase64(await makePdf())
      const r = await callFunction('send-email', {
        action: 'certificate_send',
        certificate_id: cert!.id,
        to: splitEmails(rcpt.to),
        cc: splitEmails(rcpt.cc),
        bcc: splitEmails(rcpt.bcc),
        subject: rcpt.subject.trim(),
        pdf_base64: pdf,
        file_name: certificateFileName(cert!),
      })
      if (!r.ok) toast.error(r.message)
      else {
        toast.success(r.message || tr("Certificate sent."))
        setPreview(null)
      }
    } catch (e) {
      toast.error(tr("The PDF could not be made: {{message}}", { message: (e as Error).message }))
    }
    setBusy(null)
    load()
  }

  async function correct() {
    if (!supabase) return
    if (!(await confirmAction(tr("Create a corrected version? This signed {{noun}} stays in the history and the new version starts as a draft that needs both signatures again.", { noun: noun }), { get confirmLabel() {
    return tr("Create Corrected Version")
  } }))) return
    const { data, error } = await supabase.rpc('correct_certificate', { p_certificate: cert!.id })
    if (error) return toast.error(friendlyError(error))
    navigate(`/service/certificates/${data as string}`)
  }

  return (
    <Can permission="service.certificate">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link
              to={cert.order_id ? `/service/${cert.order_id}?tab=certificate` : `/service/calls/${cert.service_call_id}?tab=certificate`}
              className="text-sm text-slate-600 underline"
            >
              ← {documentReference(cert)}
            </Link>
            <h1 className="mt-1 text-2xl font-semibold">
              {cert.title}
              {cert.version > 1 && <span className="text-base font-normal text-slate-500"> {tr("· Version")} {cert.version}</span>}
            </h1>
            <p className="text-sm text-slate-600">
              {cert.status === 'signed'
                ? tr("Signed and locked on {{showDate}}.", { showDate: showDate(cert.locked_at) })
                : cert.status === 'superseded'
                  ? tr("Replaced by a corrected version. Kept for the history.")
                  : anySigned
                    ? tr("Draft with one signature. The text cannot change until the signature is removed.")
                    : tr("Draft. Changes here apply to this {{noun}} only, not to the template.", { noun: noun })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Can permission="service.certificate.pdf">
              <button type="button" className={secondaryButtonClass} onClick={download} disabled={busy !== null}>
                {busy === 'pdf' ? tr("Making PDF…") : tr("Download PDF")}
              </button>
            </Can>
            {cert.status === 'signed' && (
              <Can permission="service.certificate.email" level="edit">
                <button type="button" className={buttonClass} onClick={openEmail} disabled={busy !== null}>
                  {sends.length ? tr("Resend") : cert.kind === 'service_report' ? tr("Email Service Report") : tr("Email Certificate")}
                </button>
              </Can>
            )}
            {cert.status === 'signed' && (
              <Can permission="service.certificate.correct" level="edit">
                <button type="button" className={secondaryButtonClass} onClick={correct}>
                  {tr("Create Corrected Version")}
                </button>
              </Can>
            )}
          </div>
        </div>

        {/* ---------- The document ---------- */}
        <article className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 sm:p-8">
          <header className="flex items-center gap-4 border-b-2 border-slate-900 pb-3">
            {company.logo && <img src={company.logo} alt="" className="max-h-14 max-w-36" />}
            <div>
              <div className="text-lg font-bold">{company.name || 'Belfast Mini Mills'}</div>
              <div className="text-xs text-slate-500">{[company.address, company.phone, company.email, company.website].filter(Boolean).join(' · ')}</div>
            </div>
          </header>

          <Can permission="service.certificate.edit_text" level="edit" fallback={<h2 className="text-center text-xl font-bold">{edit.title}</h2>}>
            {canText ? (
              <input aria-label={tr("Title")} className={`${inputClass} text-center text-lg font-bold`} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            ) : (
              <h2 className="text-center text-xl font-bold">{edit.title}</h2>
            )}
          </Can>

          {canText ? (
            <Can permission="service.certificate.edit_text" level="edit">
              <RichTextEditor label={tr("Text above the table")} value={edit.part1} onChange={(part1) => setEdit({ ...edit, part1 })} />
            </Can>
          ) : (
            <RichText value={fillPlaceholders(edit.part1, values)} className="text-sm" />
          )}

          <div className="overflow-x-auto">
            <table className="w-full border border-slate-300 text-left text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="border border-slate-300 px-2 py-1.5">{tr("Machine")}</th>
                  <th className="border border-slate-300 px-2 py-1.5">{tr("Serial number")}</th>
                  {canMachines && <th className="w-10 border border-slate-300" aria-label={tr("Remove")} />}
                </tr>
              </thead>
              <tbody>
                {edit.machines
                  .filter((m) => !m.removed)
                  .map((m) => (
                    <tr key={m.key}>
                      <td className="border border-slate-300 px-2 py-1.5">{m.machine}</td>
                      <td className="border border-slate-300 px-2 py-1.5">{m.serial ? <SerialNumber serial={m.serial} /> : ''}</td>
                      {canMachines && (
                        <td className="border border-slate-300 text-center">
                          <Can permission="service.certificate.machines" level="edit">
                            <button type="button" className="px-2 text-lg text-red-700" aria-label={tr("Remove {{machine}} {{value}}", { machine: m.machine, value: m.serial ?? '' })} onClick={() => toggleRow(m.key, true)}>
                              ×
                            </button>
                          </Can>
                        </td>
                      )}
                    </tr>
                  ))}
                {edit.machines.every((m) => m.removed) && (
                  <tr>
                    <td colSpan={3} className="px-2 py-2 text-slate-500">
                      {tr("No machines listed.")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {canMachines && (
            <Can permission="service.certificate.machines" level="edit">
              <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
                {edit.machines.some((m) => m.removed) && (
                  <div>
                    <p className="font-medium">{tr("Removed from the")} {noun}</p>
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {edit.machines
                        .filter((m) => m.removed)
                        .map((m) => (
                          <li key={m.key}>
                            <button type="button" className="rounded border border-slate-300 bg-white px-2 py-1" onClick={() => toggleRow(m.key, false)}>
                              {tr("Restore")} {m.machine} {m.serial ?? ''}
                            </button>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
                  <input aria-label={tr("Machine")} className={inputClass} placeholder={tr("Add a row: machine")} value={newRow.machine} onChange={(e) => setNewRow({ ...newRow, machine: e.target.value })} />
                  <input aria-label={tr("Serial number")} className={inputClass} placeholder={tr("Serial number")} value={newRow.serial} onChange={(e) => setNewRow({ ...newRow, serial: e.target.value })} />
                  <button type="button" className={secondaryButtonClass} onClick={addRow}>
                    {tr("Add Row")}
                  </button>
                </div>
              </div>
            </Can>
          )}

          {canText ? (
            <Can permission="service.certificate.edit_text" level="edit">
              <RichTextEditor label={tr("Text below the table")} value={edit.part2} onChange={(part2) => setEdit({ ...edit, part2 })} />
            </Can>
          ) : (
            <RichText value={fillPlaceholders(edit.part2, values)} className="text-sm" />
          )}

          {/* ---------- Signatures ---------- */}
          <div className="grid gap-6 border-t border-slate-200 pt-4 sm:grid-cols-2">
            <SignatureBlock who="tech" cert={cert} image={sigs.tech} dirty={dirty} onDone={load} />
            <SignatureBlock who="customer" cert={cert} image={sigs.customer} dirty={dirty} onDone={load} />
          </div>
        </article>

        {canText && (
          <Can permission="service.certificate.edit_text" level="edit">
            <details className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <summary className="cursor-pointer font-medium">{tr("Placeholders You Can Type in the Text")}</summary>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {PLACEHOLDERS.map((p) => (
                  <li key={p.key}>
                    <code className="rounded bg-slate-100 px-1">{`{${p.key}}`}</code> {p.label}: <span className="text-slate-600">{values[p.key]}</span>
                  </li>
                ))}
              </ul>
            </details>
          </Can>
        )}

        <Can permission="service.certificate.details">
          <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
            <h2 className="font-semibold sm:col-span-2">{tr("Details")}</h2>
            <Field label={tr("Start date (first on-site day)")} htmlFor="c-start">
              <input id="c-start" type="date" className={inputClass} disabled={!canDetails} value={edit.start_date ?? ''} onChange={(e) => setEdit({ ...edit, start_date: e.target.value || null })} />
            </Field>
            <Field label={tr("End date (last on-site day)")} htmlFor="c-end">
              <input id="c-end" type="date" className={inputClass} disabled={!canDetails} value={edit.end_date ?? ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value || null })} />
            </Field>
            <Field label={tr("Site address")} htmlFor="c-site">
              <input id="c-site" className={inputClass} disabled={!canDetails} value={edit.site_address ?? ''} onChange={(e) => setEdit({ ...edit, site_address: e.target.value || null })} />
            </Field>
            <Field label={tr("Technician’s full name")} htmlFor="c-tech">
              <input id="c-tech" className={inputClass} disabled={!canDetails} value={edit.tech_name ?? ''} onChange={(e) => setEdit({ ...edit, tech_name: e.target.value || null })} />
            </Field>
          </section>
        </Can>

        {editable && (
          <Can anyOf={['service.certificate.edit_text', 'service.certificate.machines', 'service.certificate.details']} level="edit">
            <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50/95 py-3">
              {dirty && <span className="text-sm text-amber-800">{tr("Changes not saved yet.")}</span>}
              <button type="button" className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setEdit(pick(cert))}>
                {tr("Undo Changes")}
              </button>
              <button type="button" className={buttonClass} disabled={!dirty || saving} onClick={save}>
                {saving ? tr("Saving…") : tr("Save Changes")}
              </button>
            </div>
          </Can>
        )}

        {sends.length > 0 && (
          <Can permission="service.certificate.email">
            <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <h2 className="mb-2 font-semibold">{tr("Emails Sent")}</h2>
              <ul className="divide-y divide-slate-100">
                {sends.map((s) => (
                  <li key={s.id} className="py-2">
                    <span className={s.status === 'sent' ? 'text-green-800' : 'text-red-700'}>{s.status === 'sent' ? tr("Sent") : tr("Not sent")}</span> {showDate(s.sent_at, 'MMM d, yyyy h:mm a')} {tr("to")}{' '}
                    {s.to_emails.join(', ')}
                    {s.cc_emails?.length ? <span className="text-slate-600"> {tr("· CC")} {s.cc_emails.join(', ')}</span> : null}
                    {s.bcc_emails?.length ? <span className="text-slate-600"> {tr("· BCC")} {s.bcc_emails.join(', ')}</span> : null}
                    {s.subject ? <span className="block text-xs text-slate-500">{s.subject}</span> : null}
                    {s.sent_by ? <span className="text-slate-500"> {tr("· by")} {s.sent_by}</span> : null}
                    {s.error && <p className="text-xs text-red-700">{s.error}</p>}
                  </li>
                ))}
              </ul>
            </section>
          </Can>
        )}

        {versions.length > 1 && (
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">{tr("Versions")}</h2>
            <ul className="space-y-1">
              {versions.map((v) => (
                <li key={v.id}>
                  {v.id === cert.id ? (
                    <strong>{tr("Version")} {v.version} {tr("(this one)")}</strong>
                  ) : (
                    <Link to={`/service/certificates/${v.id}`} className="text-blue-700 underline">
                      {tr("Version")} {v.version}
                    </Link>
                  )}{' '}
                  <span className="text-slate-500">{v.status === 'signed' ? tr("signed") : v.status === 'superseded' ? tr("replaced") : tr("draft")}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {preview && (
          <Modal
            title={cert.kind === 'service_report' ? tr("Email the Service Report") : tr("Email the Certificate")}
            onClose={() => setPreview(null)}
            busy={busy === 'send'}
            footer={
              <>
                <button type="button" className={secondaryButtonClass} onClick={() => setPreview(null)} disabled={busy === 'send'}>
                  {tr("Cancel")}
                </button>
                <Can permission="service.certificate.email" level="edit">
                  <button type="button" className={buttonClass} onClick={sendEmail} disabled={busy === 'send'}>
                    {busy === 'send' ? tr("Sending…") : tr("Send Email")}
                  </button>
                </Can>
              </>
            }
          >
            <div className="space-y-2 text-sm">
              <Field label={tr("To")} htmlFor="cert-to" hint={tr("Separate several addresses with commas. The customer and the technician are filled in; add any others.")}>
                <input id="cert-to" className={inputClass} value={rcpt.to} onChange={(e) => setRcpt({ ...rcpt, to: e.target.value })} />
              </Field>
              <Field label="CC" htmlFor="cert-cc" hint={tr("The office email is filled in (Admin → Email Templates).")}>
                <input id="cert-cc" className={inputClass} value={rcpt.cc} onChange={(e) => setRcpt({ ...rcpt, cc: e.target.value })} />
              </Field>
              <Field label="BCC" htmlFor="cert-bcc" hint={tr("Hidden from the other recipients.")}>
                <input id="cert-bcc" className={inputClass} value={rcpt.bcc} onChange={(e) => setRcpt({ ...rcpt, bcc: e.target.value })} />
              </Field>
              <Field label={tr("Subject")} htmlFor="cert-subject">
                <input id="cert-subject" className={inputClass} maxLength={300} value={rcpt.subject} onChange={(e) => setRcpt({ ...rcpt, subject: e.target.value })} />
              </Field>
              <SenderLine />
              <p>
                <span className="text-slate-500">{tr("Attachment:")}</span> {preview.file_name}
              </p>
              {preview.warnings.map((w) => (
                <p key={w} className="rounded bg-amber-50 p-2 text-amber-900">
                  {w}
                </p>
              ))}
              <iframe title={tr("Email preview")} sandbox="" srcDoc={preview.html} className="h-80 w-full rounded border border-slate-200" />
            </div>
          </Modal>
        )}
      </div>
    </Can>
  )
}

/** One signature: shown when signed, or a pad to sign on this phone or tablet. */
function SignatureBlock({ who, cert, image, dirty, onDone }: { who: 'tech' | 'customer'; cert: Certificate; image: string | null; dirty: boolean; onDone: () => void }) {
  const pad = useRef<SignatureInputHandle>(null)
  const signed = who === 'tech' ? cert.tech_signed_at : cert.customer_signed_at
  const [name, setName] = useState((who === 'tech' ? cert.tech_name : cert.customer_name) ?? '')
  const [title, setTitle] = useState(cert.customer_title ?? '')
  const [date, setDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const heading = who === 'tech' ? 'Technician' : 'Customer'

  async function sign() {
    if (!supabase || !pad.current) return
    if (dirty) return toast.error(tr("Save the changes first, then sign."))
    if (!name.trim()) return toast.error(tr("Enter the printed name."))
    if (pad.current.isEmpty()) return toast.error(tr("Sign in the box first."))
    setBusy(true)
    const sig = await pad.current.get()
    const png = sig?.blob
    if (!png) {
      setBusy(false)
      return toast.error(tr("The signature could not be saved. Sign again."))
    }
    const path = `${cert.id}/${who}-${Date.now()}.png`
    const up = await supabase.storage.from('certificate-signatures').upload(path, png, { contentType: 'image/png' })
    if (up.error) {
      setBusy(false)
      return toast.error(friendlyError(up.error))
    }
    const { error } = await supabase.rpc('sign_certificate', { p_certificate: cert.id, p_who: who, p_name: name, p_title: who === 'customer' ? title : null, p_date: date, p_signature_path: path, p_saved_signature: sig?.savedId ?? null })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("{{heading}} signature saved.", { heading: heading }))
    onDone()
  }

  async function clear() {
    if (!supabase) return
    if (!(await confirmAction(tr("Remove the {{value}} signature?", { value: heading.toLowerCase() }), { get confirmLabel() {
    return tr("Remove Signature")
  }, danger: true }))) return
    const { error } = await supabase.rpc('clear_certificate_signature', { p_certificate: cert.id, p_who: who })
    if (error) return toast.error(friendlyError(error))
    onDone()
  }

  if (signed) {
    return (
      <div className="text-sm">
        <h3 className="font-semibold">{heading}</h3>
        {image ? <img src={image} alt={tr("{{heading}} signature", { heading: heading })} className="mt-1 h-16 max-w-full object-contain" /> : <p className="mt-1 h-16 text-slate-400">{tr("Signature")}</p>}
        <div className="border-t border-slate-900 pt-1">
          <p>{tr("Printed name:")} {who === 'tech' ? cert.tech_name : cert.customer_name}</p>
          {who === 'customer' && <p>{tr("Title:")} {cert.customer_title ?? '—'}</p>}
          <p>{tr("Date:")} {showDate(who === 'tech' ? cert.tech_sign_date : cert.customer_sign_date)}</p>
        </div>
        {cert.status === 'draft' && (
          <Can permission="service.certificate.sign" level="edit">
            <button type="button" className="mt-1 text-xs text-red-700 underline" onClick={clear}>
              {tr("Remove Signature")}
            </button>
          </Can>
        )}
      </div>
    )
  }
  if (cert.status !== 'draft') return null
  return (
    <div className="space-y-2 text-sm">
      <h3 className="font-semibold">{heading}</h3>
      <Can permission="service.certificate.sign" level="edit" fallback={<p className="text-slate-500">{tr("Not signed yet.")}</p>}>
        {/* The technician may use their saved signature; customers always draw theirs. */}
        <SignatureInput ref={pad} disabled={busy} allowSaved={who === 'tech'} />
        <Field label={tr("Printed name")} htmlFor={`sig-${who}-name`}>
          <input id={`sig-${who}-name`} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {who === 'customer' && (
          <Field label={tr("Title")} htmlFor="sig-customer-title">
            <input id="sig-customer-title" className={inputClass} value={title} placeholder={tr("For example Owner")} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        )}
        <Field label={tr("Date")} htmlFor={`sig-${who}-date`}>
          <input id={`sig-${who}-date`} type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <button type="button" className={buttonClass} onClick={sign} disabled={busy}>
          {busy ? tr("Saving…") : tr("Sign as {{heading}}", { heading: heading })}
        </button>
      </Can>
    </div>
  )
}
