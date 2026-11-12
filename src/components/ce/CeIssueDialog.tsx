// @permission-scope ce.issue
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { loadCeSettings, openPdf, type CeData, type CeDeclaration, type CeSettings } from '../../lib/ce'
import { useCompany } from '../../lib/company'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { blobToDataUrl } from '../../lib/signatures'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import SerialNumber from '../SerialNumber'
import SignatureInput, { type SignatureInputHandle } from '../SignatureInput'
import { Field, Modal, buttonClass, inputClass, secondaryButtonClass } from '../form'

type Machine = { id: string; machine_type: string; serial_number: string | null }

/**
 * Issue CE / EU declarations of conformity: choose some or all machines of an
 * order, check place / date / signer, sign (saved or drawn), Preview, Generate.
 * A machine that already has one gets a new version (the old one is kept).
 */
export default function CeIssueDialog({ orderId, machineIds, onClose, onIssued }: { orderId: string; machineIds?: string[]; onClose: () => void; onIssued: (d: CeDeclaration[]) => void }) {
  const company = useCompany()
  const sig = useRef<SignatureInputHandle>(null)
  const [machines, setMachines] = useState<Machine[]>([])
  const [existing, setExisting] = useState<Map<string, string>>(new Map())
  // The machines asked for when the dialog opened (all machines when none were given).
  const [initial] = useState(() => machineIds ?? [])
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial))
  const [settings, setSettings] = useState<CeSettings | null>(null)
  const [place, setPlace] = useState('')
  const [date, setDate] = useState(todayISO())
  const [signer, setSigner] = useState('')
  const [problems, setProblems] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState<'preview' | 'issue' | null>(null)

  useEffect(() => {
    if (!supabase) return
    Promise.all([
      supabase.from('order_machine_status').select('id, machine_type, serial_number').eq('order_id', orderId).order('machine_type').order('serial_number'),
      supabase.from('ce_declarations').select('machine_id, number').eq('order_id', orderId).eq('status', 'issued'),
      loadCeSettings(),
    ]).then(([m, d, s]) => {
      const list = (m.data as Machine[]) ?? []
      setMachines(list)
      setExisting(new Map(((d.data as { machine_id: string; number: string }[]) ?? []).map((r) => [r.machine_id, r.number])))
      setSettings(s)
      setPlace(s.place)
      setSigner(s.signer)
      if (!initial.length) setChosen(new Set(list.filter((x) => x.serial_number).map((x) => x.id)))
    })
  }, [orderId, initial])

  const options = useMemo(() => ({ place, date, signer }), [place, date, signer])
  const selected = machines.filter((m) => chosen.has(m.id))

  /** What each chosen machine's declaration would say (and what is missing). */
  async function dataFor(): Promise<{ id: string; data: CeData }[] | null> {
    if (!supabase) return null
    const out: { id: string; data: CeData }[] = []
    const found: Record<string, string[]> = {}
    for (const m of selected) {
      const { data, error } = await supabase.rpc('ce_declaration_data', { p_machine: m.id, p: options })
      if (error) {
        toast.error(friendlyError(error))
        return null
      }
      const d = data as CeData
      found[m.id] = d.problems ?? []
      out.push({ id: m.id, data: d })
    }
    setProblems(found)
    return out
  }

  async function preview() {
    if (!selected.length) return toast.error('Select at least one machine.')
    setBusy('preview')
    try {
      const list = await dataFor()
      if (!list) return
      const s = sig.current && !sig.current.isEmpty() ? await sig.current.get() : null
      const signature = s ? await blobToDataUrl(s.blob) : null
      const { buildCePdf } = await import('../../lib/cePdf')
      const bytes = await buildCePdf(
        list.map((x) => ({ data: x.data, number: null, signature, paper: settings?.paper ?? 'a4' })),
        company.logo,
      )
      if (!openPdf(bytes)) toast.error('The preview was blocked. Allow pop-ups for this site and try again.')
    } catch (e) {
      toast.error(friendlyError(e as Error))
    } finally {
      setBusy(null)
    }
  }

  async function issue() {
    if (!supabase) return
    if (!selected.length) return toast.error('Select at least one machine.')
    if (!signer.trim()) return toast.error('Enter the name and title of the person signing.')
    if (!sig.current || sig.current.isEmpty()) return toast.error('Sign first: use your saved signature or draw it in the box.')
    setBusy('issue')
    try {
      const s = await sig.current.get()
      if (!s) return toast.error('The signature could not be read. Sign again.')
      const path = `${crypto.randomUUID()}/signature.png`
      const up = await supabase.storage.from('ce-signatures').upload(path, s.blob, { contentType: 'image/png' })
      if (up.error) return toast.error(friendlyError(up.error))
      const { data, error } = await supabase.rpc('issue_ce_declarations', {
        p_machines: selected.map((m) => m.id),
        p: { ...options, signature_path: path, saved_signature: s.savedId },
      })
      if (error) return toast.error(friendlyError(error))
      const issued = (data as CeDeclaration[]) ?? []
      toast.success(`${issued.length} declaration${issued.length === 1 ? '' : 's'} issued: ${issued.map((d) => d.number).join(', ')}.`)
      onIssued(issued)
    } finally {
      setBusy(null)
    }
  }

  const toggle = (id: string) =>
    setChosen((c) => {
      const n = new Set(c)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Modal
      title="CE Certificates"
      onClose={onClose}
      busy={busy !== null}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button type="button" className={secondaryButtonClass} onClick={preview} disabled={busy !== null || !selected.length}>
            {busy === 'preview' ? 'Preparing…' : 'Preview'}
          </button>
          <button type="button" className={buttonClass} onClick={issue} disabled={busy !== null || !selected.length}>
            {busy === 'issue' ? 'Generating…' : `Generate ${selected.length || ''} Declaration${selected.length === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          {settings?.declaration_type === 'eu_2023' ? 'EU Declaration of Conformity (Machinery Regulation (EU) 2023/1230)' : 'EC Declaration of Conformity (Machinery Directive 2006/42/EC)'}, one per
          machine. Once generated, a declaration is locked; generating again makes a new version and keeps the old one.
        </p>
        <fieldset>
          <legend className="mb-1 flex w-full items-center justify-between font-medium">
            <span>Machines</span>
            <span className="flex gap-3 text-xs font-normal">
              <button type="button" className="underline" onClick={() => setChosen(new Set(machines.filter((m) => m.serial_number).map((m) => m.id)))}>
                Select All
              </button>
              <button type="button" className="underline" onClick={() => setChosen(new Set())}>
                Clear Selection
              </button>
            </span>
          </legend>
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {machines.map((m) => (
              <li key={m.id} className="px-3 py-2">
                <label className="flex flex-wrap items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={chosen.has(m.id)} disabled={!m.serial_number} onChange={() => toggle(m.id)} />
                  <span className="font-medium">{m.machine_type}</span>
                  {m.serial_number ? <SerialNumber serial={m.serial_number} /> : <span className="text-xs text-amber-800">No serial number yet</span>}
                  {existing.has(m.id) && <span className="text-xs text-slate-500">Issued: {existing.get(m.id)} (a new version will be made)</span>}
                </label>
                {(problems[m.id] ?? []).map((p) => (
                  <p key={p} className="mt-1 text-xs text-amber-800">
                    {p}
                  </p>
                ))}
              </li>
            ))}
            {machines.length === 0 && <li className="px-3 py-2 text-slate-500">This order has no machines.</li>}
          </ul>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Place" htmlFor="ce-place">
            <input id="ce-place" className={inputClass} value={place} onChange={(e) => setPlace(e.target.value)} />
          </Field>
          <Field label="Date" htmlFor="ce-date">
            <input id="ce-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Name and title of the person signing" htmlFor="ce-signer" className="sm:col-span-2">
            <input id="ce-signer" className={inputClass} value={signer} onChange={(e) => setSigner(e.target.value)} />
          </Field>
        </div>
        <Can permission="ce.issue" level="edit">
          <div>
            <div className="mb-1 font-medium">Signature</div>
            <SignatureInput ref={sig} disabled={busy !== null} />
          </div>
        </Can>
      </div>
    </Modal>
  )
}
