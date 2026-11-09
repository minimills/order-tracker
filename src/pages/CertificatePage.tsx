// @permission-scope service.certificate
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import SignaturePad, { type SignaturePadHandle } from '../components/checklist/SignaturePad'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../components/form'
import RichText from '../components/RichText'
import RichTextEditor from '../components/RichTextEditor'
import SerialNumber from '../components/SerialNumber'
import { useCompany } from '../lib/company'
import { confirmAction } from '../lib/confirm'
import { showDate, todayISO } from '../lib/dates'
import { callFunction } from '../lib/edgeFunction'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import {
  certificateFileName,
  certificateValues,
  fillPlaceholders,
  PLACEHOLDERS,
  signatureDataUrl,
  type CertMachine,
  type Certificate,
  type CompanyInfo,
} from '../lib/service'
import { supabase } from '../lib/supabase'

type Editable = Pick<Certificate, 'title' | 'part1' | 'part2' | 'machines' | 'start_date' | 'end_date' | 'site_address' | 'tech_name'>
type Send = { id: string; to_emails: string[]; status: 'sent' | 'failed'; error: string | null; sent_by: string | null; sent_at: string }
type Preview = { to: string[]; subject: string; html: string; warnings: string[]; file_name: string }
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

/** One commissioning certificate: draft editing, signatures, PDF and email. */
export default function CertificatePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const liveCompany = useCompany()
  const { can } = usePermissions()
  const [cert, setCert] = useState<Certificate | null>(null)
  const [edit, setEdit] = useState<Editable | null>(null)
  const [versions, setVersions] = useState<Pick<Certificate, 'id' | 'version' | 'status'>[]>([])
  const [sends, setSends] = useState<Send[]>([])
  const [sigs, setSigs] = useState<{ tech: string | null; customer: string | null }>({ tech: null, customer: null })
  const [saving, setSaving] = useState(false)
  const [newRow, setNewRow] = useState({ machine: '', serial: '' })
  const [preview, setPreview] = useState<Preview | null>(null)
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
      supabase.from('service_certificates').select('id, version, status').eq('order_id', c.order_id).order('version', { ascending: false }),
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

  if (!cert || !edit) return <p className="p-6 text-center text-slate-500">Loading…</p>

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
    if (edit.start_date && edit.end_date && edit.end_date < edit.start_date) return toast.error('The end date must be on or after the start date.')
    const patch: Partial<Editable> = {}
    for (const k of Object.keys(edit) as (keyof Editable)[]) {
      if (JSON.stringify(edit[k]) !== JSON.stringify(cert[k])) (patch as Record<string, unknown>)[k] = edit[k]
    }
    setSaving(true)
    const { error } = await supabase.from('service_certificates').update(patch).eq('id', cert.id)
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Certificate saved.')
    load()
  }

  const setMachines = (machines: CertMachine[]) => setEdit({ ...edit, machines })
  const toggleRow = (key: string, removed: boolean) => setMachines(edit.machines.map((m) => (m.key === key ? { ...m, removed } : m)))
  const addRow = () => {
    if (!newRow.machine.trim()) return toast.error('Type the machine.')
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
      toast.error(`The PDF could not be made: ${(e as Error).message}`)
    }
    setBusy(null)
  }

  async function openEmail() {
    setBusy('preview')
    const r = await callFunction<Preview>('send-email', { action: 'certificate_preview', certificate_id: cert!.id, file_name: certificateFileName(cert!) })
    setBusy(null)
    if (!r.ok) return toast.error(r.message)
    setPreview(r.data)
  }

  async function sendEmail() {
    setBusy('send')
    try {
      const { toBase64 } = await import('../lib/certificatePdf')
      const pdf = toBase64(await makePdf())
      const r = await callFunction('send-email', { action: 'certificate_send', certificate_id: cert!.id, pdf_base64: pdf, file_name: certificateFileName(cert!) })
      if (!r.ok) toast.error(r.message)
      else {
        toast.success(r.message || 'Certificate sent.')
        setPreview(null)
      }
    } catch (e) {
      toast.error(`The PDF could not be made: ${(e as Error).message}`)
    }
    setBusy(null)
    load()
  }

  async function correct() {
    if (!supabase) return
    if (!(await confirmAction('Create a corrected version? This signed certificate stays in the history and the new version starts as a draft that needs both signatures again.', { confirmLabel: 'Create Corrected Version' }))) return
    const { data, error } = await supabase.rpc('correct_certificate', { p_certificate: cert!.id })
    if (error) return toast.error(friendlyError(error))
    navigate(`/service/certificates/${data as string}`)
  }

  return (
    <Can permission="service.certificate">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link to={`/service/${cert.order_id}?tab=certificate`} className="text-sm text-slate-600 underline">
              ← Order {cert.info.order_number}
            </Link>
            <h1 className="mt-1 text-2xl font-semibold">
              {cert.title}
              {cert.version > 1 && <span className="text-base font-normal text-slate-500"> · Version {cert.version}</span>}
            </h1>
            <p className="text-sm text-slate-600">
              {cert.status === 'signed'
                ? `Signed and locked on ${showDate(cert.locked_at)}.`
                : cert.status === 'superseded'
                  ? 'Replaced by a corrected version. Kept for the history.'
                  : anySigned
                    ? 'Draft with one signature. The text cannot change until the signature is removed.'
                    : 'Draft. Changes here apply to this certificate only, not to the template.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Can permission="service.certificate.pdf">
              <button type="button" className={secondaryButtonClass} onClick={download} disabled={busy !== null}>
                {busy === 'pdf' ? 'Making PDF…' : 'Download PDF'}
              </button>
            </Can>
            {cert.status === 'signed' && (
              <Can permission="service.certificate.email" level="edit">
                <button type="button" className={buttonClass} onClick={openEmail} disabled={busy !== null}>
                  {sends.length ? 'Resend' : 'Email Certificate'}
                </button>
              </Can>
            )}
            {cert.status === 'signed' && (
              <Can permission="service.certificate.correct" level="edit">
                <button type="button" className={secondaryButtonClass} onClick={correct}>
                  Create Corrected Version
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
              <input aria-label="Title" className={`${inputClass} text-center text-lg font-bold`} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            ) : (
              <h2 className="text-center text-xl font-bold">{edit.title}</h2>
            )}
          </Can>

          {canText ? (
            <Can permission="service.certificate.edit_text" level="edit">
              <RichTextEditor headings label="Text above the table" value={edit.part1} onChange={(part1) => setEdit({ ...edit, part1 })} />
            </Can>
          ) : (
            <RichText value={fillPlaceholders(edit.part1, values)} className="text-sm" />
          )}

          <table className="w-full border border-slate-300 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="border border-slate-300 px-2 py-1.5">Machine</th>
                <th className="border border-slate-300 px-2 py-1.5">Serial number</th>
                {canMachines && <th className="w-10 border border-slate-300" aria-label="Remove" />}
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
                          <button type="button" className="px-2 text-lg text-red-700" aria-label={`Remove ${m.machine} ${m.serial ?? ''}`} onClick={() => toggleRow(m.key, true)}>
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
                    No machines listed.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {canMachines && (
            <Can permission="service.certificate.machines" level="edit">
              <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
                {edit.machines.some((m) => m.removed) && (
                  <div>
                    <p className="font-medium">Removed from the certificate</p>
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {edit.machines
                        .filter((m) => m.removed)
                        .map((m) => (
                          <li key={m.key}>
                            <button type="button" className="rounded border border-slate-300 bg-white px-2 py-1" onClick={() => toggleRow(m.key, false)}>
                              Restore {m.machine} {m.serial ?? ''}
                            </button>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
                  <input aria-label="Machine" className={inputClass} placeholder="Add a row: machine" value={newRow.machine} onChange={(e) => setNewRow({ ...newRow, machine: e.target.value })} />
                  <input aria-label="Serial number" className={inputClass} placeholder="Serial number" value={newRow.serial} onChange={(e) => setNewRow({ ...newRow, serial: e.target.value })} />
                  <button type="button" className={secondaryButtonClass} onClick={addRow}>
                    Add Row
                  </button>
                </div>
              </div>
            </Can>
          )}

          {canText ? (
            <Can permission="service.certificate.edit_text" level="edit">
              <RichTextEditor headings label="Text below the table" value={edit.part2} onChange={(part2) => setEdit({ ...edit, part2 })} />
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
              <summary className="cursor-pointer font-medium">Placeholders You Can Type in the Text</summary>
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
            <h2 className="font-semibold sm:col-span-2">Details</h2>
            <Field label="Start date (first on-site day)" htmlFor="c-start">
              <input id="c-start" type="date" className={inputClass} disabled={!canDetails} value={edit.start_date ?? ''} onChange={(e) => setEdit({ ...edit, start_date: e.target.value || null })} />
            </Field>
            <Field label="End date (last on-site day)" htmlFor="c-end">
              <input id="c-end" type="date" className={inputClass} disabled={!canDetails} value={edit.end_date ?? ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value || null })} />
            </Field>
            <Field label="Site address" htmlFor="c-site">
              <input id="c-site" className={inputClass} disabled={!canDetails} value={edit.site_address ?? ''} onChange={(e) => setEdit({ ...edit, site_address: e.target.value || null })} />
            </Field>
            <Field label="Technician’s full name" htmlFor="c-tech">
              <input id="c-tech" className={inputClass} disabled={!canDetails} value={edit.tech_name ?? ''} onChange={(e) => setEdit({ ...edit, tech_name: e.target.value || null })} />
            </Field>
          </section>
        </Can>

        {editable && (
          <Can anyOf={['service.certificate.edit_text', 'service.certificate.machines', 'service.certificate.details']} level="edit">
            <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50/95 py-3">
              {dirty && <span className="text-sm text-amber-800">Changes not saved yet.</span>}
              <button type="button" className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setEdit(pick(cert))}>
                Undo Changes
              </button>
              <button type="button" className={buttonClass} disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </Can>
        )}

        {sends.length > 0 && (
          <Can permission="service.certificate.email">
            <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <h2 className="mb-2 font-semibold">Emails Sent</h2>
              <ul className="divide-y divide-slate-100">
                {sends.map((s) => (
                  <li key={s.id} className="py-2">
                    <span className={s.status === 'sent' ? 'text-green-800' : 'text-red-700'}>{s.status === 'sent' ? 'Sent' : 'Not sent'}</span> {showDate(s.sent_at, 'MMM d, yyyy h:mm a')} to{' '}
                    {s.to_emails.join(', ')}
                    {s.sent_by ? <span className="text-slate-500"> · by {s.sent_by}</span> : null}
                    {s.error && <p className="text-xs text-red-700">{s.error}</p>}
                  </li>
                ))}
              </ul>
            </section>
          </Can>
        )}

        {versions.length > 1 && (
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Versions</h2>
            <ul className="space-y-1">
              {versions.map((v) => (
                <li key={v.id}>
                  {v.id === cert.id ? (
                    <strong>Version {v.version} (this one)</strong>
                  ) : (
                    <Link to={`/service/certificates/${v.id}`} className="text-blue-700 underline">
                      Version {v.version}
                    </Link>
                  )}{' '}
                  <span className="text-slate-500">{v.status === 'signed' ? 'signed' : v.status === 'superseded' ? 'replaced' : 'draft'}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {preview && (
          <Modal
            title="Email the Certificate"
            onClose={() => setPreview(null)}
            busy={busy === 'send'}
            footer={
              <>
                <button type="button" className={secondaryButtonClass} onClick={() => setPreview(null)} disabled={busy === 'send'}>
                  Cancel
                </button>
                <Can permission="service.certificate.email" level="edit">
                  <button type="button" className={buttonClass} onClick={sendEmail} disabled={busy === 'send' || preview.to.length === 0}>
                    {busy === 'send' ? 'Sending…' : 'Send'}
                  </button>
                </Can>
              </>
            }
          >
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-slate-500">To:</span> {preview.to.join(', ') || 'no one'}
              </p>
              <p>
                <span className="text-slate-500">Subject:</span> {preview.subject}
              </p>
              <p>
                <span className="text-slate-500">Attachment:</span> {preview.file_name}
              </p>
              {preview.warnings.map((w) => (
                <p key={w} className="rounded bg-amber-50 p-2 text-amber-900">
                  {w}
                </p>
              ))}
              <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-80 w-full rounded border border-slate-200" />
            </div>
          </Modal>
        )}
      </div>
    </Can>
  )
}

/** One signature: shown when signed, or a pad to sign on this phone or tablet. */
function SignatureBlock({ who, cert, image, dirty, onDone }: { who: 'tech' | 'customer'; cert: Certificate; image: string | null; dirty: boolean; onDone: () => void }) {
  const pad = useRef<SignaturePadHandle>(null)
  const signed = who === 'tech' ? cert.tech_signed_at : cert.customer_signed_at
  const [name, setName] = useState((who === 'tech' ? cert.tech_name : cert.customer_name) ?? '')
  const [title, setTitle] = useState(cert.customer_title ?? '')
  const [date, setDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const heading = who === 'tech' ? 'Technician' : 'Customer'

  async function sign() {
    if (!supabase || !pad.current) return
    if (dirty) return toast.error('Save the changes to the certificate first, then sign.')
    if (!name.trim()) return toast.error('Enter the printed name.')
    if (pad.current.isEmpty()) return toast.error('Sign in the box first.')
    setBusy(true)
    const png = await pad.current.toPng()
    if (!png) {
      setBusy(false)
      return toast.error('The signature could not be saved. Sign again.')
    }
    const path = `${cert.id}/${who}-${Date.now()}.png`
    const up = await supabase.storage.from('certificate-signatures').upload(path, png, { contentType: 'image/png' })
    if (up.error) {
      setBusy(false)
      return toast.error(friendlyError(up.error))
    }
    const { error } = await supabase.rpc('sign_certificate', { p_certificate: cert.id, p_who: who, p_name: name, p_title: who === 'customer' ? title : null, p_date: date, p_signature_path: path })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${heading} signature saved.`)
    onDone()
  }

  async function clear() {
    if (!supabase) return
    if (!(await confirmAction(`Remove the ${heading.toLowerCase()} signature?`, { confirmLabel: 'Remove Signature', danger: true }))) return
    const { error } = await supabase.rpc('clear_certificate_signature', { p_certificate: cert.id, p_who: who })
    if (error) return toast.error(friendlyError(error))
    onDone()
  }

  if (signed) {
    return (
      <div className="text-sm">
        <h3 className="font-semibold">{heading}</h3>
        {image ? <img src={image} alt={`${heading} signature`} className="mt-1 h-16 max-w-full object-contain" /> : <p className="mt-1 h-16 text-slate-400">Signature</p>}
        <div className="border-t border-slate-900 pt-1">
          <p>Printed name: {who === 'tech' ? cert.tech_name : cert.customer_name}</p>
          {who === 'customer' && <p>Title: {cert.customer_title ?? '—'}</p>}
          <p>Date: {showDate(who === 'tech' ? cert.tech_sign_date : cert.customer_sign_date)}</p>
        </div>
        {cert.status === 'draft' && (
          <Can permission="service.certificate.sign" level="edit">
            <button type="button" className="mt-1 text-xs text-red-700 underline" onClick={clear}>
              Remove Signature
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
      <Can permission="service.certificate.sign" level="edit" fallback={<p className="text-slate-500">Not signed yet.</p>}>
        <SignaturePad ref={pad} disabled={busy} />
        <button type="button" className="text-xs underline" onClick={() => pad.current?.clear()}>
          Clear
        </button>
        <Field label="Printed name" htmlFor={`sig-${who}-name`}>
          <input id={`sig-${who}-name`} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {who === 'customer' && (
          <Field label="Title" htmlFor="sig-customer-title">
            <input id="sig-customer-title" className={inputClass} value={title} placeholder="For example Owner" onChange={(e) => setTitle(e.target.value)} />
          </Field>
        )}
        <Field label="Date" htmlFor={`sig-${who}-date`}>
          <input id={`sig-${who}-date`} type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <button type="button" className={buttonClass} onClick={sign} disabled={busy}>
          {busy ? 'Saving…' : `Sign as ${heading}`}
        </button>
      </Can>
    </div>
  )
}
