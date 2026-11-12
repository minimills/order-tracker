// @permission-scope admin.ce
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import CeRegister from '../../components/ce/CeRegister'
import Can from '../../components/Can'
import RichTextEditor from '../../components/RichTextEditor'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { CE_KIND_LABEL, EU_REGULATION_DATE, loadCeSettings, openPdf, previewDeclarations, type CeData, type CeKind, type CeSettings } from '../../lib/ce'
import { useCompany } from '../../lib/company'
import { showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Template = { id: string; key: 'ce_ec' | 'ce_eu'; name: string; title: string; part1: string; part2: string }

const PLACEHOLDER_HINT = '{title}, {customer_company}, {customer_name}, {machines} (for example CWR 4175), {machines_long}, {order_number}, {sender_name}, {company_name}'

/** Admin → Declaration of Conformity: settings, the EC and EU templates, and the register. */
export default function CeAdminPage() {
  const company = useCompany()
  const [s, setS] = useState<CeSettings | null>(null)
  const [saved, setSaved] = useState<CeSettings | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [savedTpl, setSavedTpl] = useState<Template[]>([])
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [machines, setMachines] = useState<{ id: string; machine_type: string; serial_number: string }[]>([])
  const [previewMachine, setPreviewMachine] = useState('')

  // Machines to preview with (newest first).
  useEffect(() => {
    supabase
      ?.from('order_machine_status')
      .select('id, machine_type, serial_number')
      .not('serial_number', 'is', null)
      .order('created_at', { ascending: false })
      .limit(300)
      .then(({ data }) => {
        const list = (data as { id: string; machine_type: string; serial_number: string }[]) ?? []
        setMachines(list)
        if (list[0]) setPreviewMachine(list[0].id)
      })
  }, [])

  useEffect(() => {
    loadCeSettings().then((v) => {
      setS(v)
      setSaved(v)
    })
    supabase
      ?.from('document_templates')
      .select('id, key, name, title, part1, part2')
      .in('key', ['ce_ec', 'ce_eu'])
      .order('key')
      .then(({ data }) => {
        setTemplates((data as Template[]) ?? [])
        setSavedTpl((data as Template[]) ?? [])
      })
  }, [])

  if (!s || !saved) return <p className="p-6 text-center text-slate-500">Loading…</p>
  const set = (k: keyof CeSettings) => (e: { target: { value: string } }) => setS({ ...s, [k]: e.target.value })
  const settingsDirty = JSON.stringify(s) !== JSON.stringify(saved)
  const showReminder = todayISO() >= '2026-12-01' && saved.declaration_type !== 'eu_2023'

  async function saveSettings() {
    if (!supabase || !s) return
    setBusy(true)
    const { error } = await supabase.rpc('set_ce_settings', { p: s })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setSaved(s)
    toast.success('Settings saved. Declarations already issued keep what they said.')
  }

  async function saveTemplate(t: Template) {
    if (!supabase) return
    if (!t.title.trim()) return toast.error('The title cannot be empty.')
    setBusy(true)
    const { data, error } = await supabase.from('document_templates').update({ title: t.title.trim(), part1: t.part1, part2: t.part2 }).eq('id', t.id).select('id, key, name, title, part1, part2').single()
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setSavedTpl((list) => list.map((x) => (x.id === t.id ? (data as Template) : x)))
    setTemplates((list) => list.map((x) => (x.id === t.id ? (data as Template) : x)))
    toast.success('Template saved. New declarations use it.')
  }

  /**
   * Preview for a REAL machine: the same data function (ce_declaration_data)
   * and the same renderer as issued declarations. Only the template text and
   * the settings being edited on this page are swapped in, so the preview
   * shows exactly what a declaration for that machine would say once saved.
   */
  async function preview(kind: CeKind) {
    const t = templates.find((x) => x.key === (kind === 'eu_2023' ? 'ce_eu' : 'ce_ec'))
    if (!t || !s || !supabase) return
    if (!previewMachine) return toast.error('Choose a machine to preview with.')
    const { data, error } = await supabase.rpc('ce_declaration_data', { p_machine: previewMachine, p: { kind } })
    if (error) return toast.error(friendlyError(error))
    const real = data as CeData
    const draft: CeData = {
      ...real,
      title: t.title,
      declaration_html: t.part1,
      closing_html: t.part2,
      authorised_person: s.authorised_person,
      machine: { ...real.machine, brand: s.brand || real.machine.brand },
      notified_body: s.notified_body.trim() || null,
      place: s.place,
      signer: s.signer,
    }
    try {
      const bytes = await previewDeclarations([draft], null, s.paper, company.logo)
      if (!openPdf(bytes)) toast.error('The preview was blocked. Allow pop-ups for this site and try again.')
      if (real.problems?.length) toast.warning(real.problems.join(' '))
    } catch (e) {
      toast.error(friendlyError(e as Error))
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHeader title="Declaration of Conformity">
        CE declarations are issued per machine from the Order page or the Machine page. The text and settings here are used for new
        declarations; issued declarations are locked and keep what they said. Machine details (product description, directives,
        harmonised standards) are set per machine type in Admin → Machine Types.
      </AdminPageHeader>

      {showReminder && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          The EU Machinery Regulation (EU) 2023/1230 applies from {showDate(EU_REGULATION_DATE)}. Check the EU template below and switch the declaration type when you are ready.
        </p>
      )}

      <section className="max-w-3xl space-y-4 rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="ce-settings">
        <h2 className="font-semibold">Settings</h2>
        <fieldset>
          <legend className="mb-1 font-medium text-slate-700">Declaration type</legend>
          {(['ec_2006', 'eu_2023'] as CeKind[]).map((k) => (
            <label key={k} className="flex items-center gap-2 py-0.5">
              <input type="radio" name="ce-kind" checked={s.declaration_type === k} onChange={() => setS({ ...s, declaration_type: k })} /> {CE_KIND_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="mb-1 font-medium text-slate-700">Paper size</legend>
          <div className="flex gap-4">
            {(['a4', 'letter'] as const).map((p) => (
              <label key={p} className="flex items-center gap-2">
                <input type="radio" name="ce-paper" checked={s.paper === p} onChange={() => setS({ ...s, paper: p })} /> {p === 'a4' ? 'A4' : 'Letter'}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Brand name" htmlFor="ce-brand">
            <input id="ce-brand" className={inputClass} value={s.brand} onChange={set('brand')} />
          </Field>
          <Field label="Place" htmlFor="ce-place-default">
            <input id="ce-place-default" className={inputClass} value={s.place} onChange={set('place')} />
          </Field>
          <Field label="Name and title of the person signing" htmlFor="ce-signer-default" className="sm:col-span-2">
            <input id="ce-signer-default" className={inputClass} value={s.signer} onChange={set('signer')} />
          </Field>
          <Field label="Person authorised to compile the technical file (EU)" htmlFor="ce-authorised" className="sm:col-span-2" hint="One line each: name, address, phone, email, website.">
            <textarea id="ce-authorised" rows={7} className={inputClass} value={s.authorised_person} onChange={set('authorised_person')} />
          </Field>
          <Field label="Notified body (optional)" htmlFor="ce-notified" className="sm:col-span-2" hint="Leave empty when no notified body was involved; the section is then left out.">
            <textarea id="ce-notified" rows={2} className={inputClass} value={s.notified_body} onChange={set('notified_body')} />
          </Field>
          <Field label="Email subject" htmlFor="ce-subject-default" className="sm:col-span-2">
            <input id="ce-subject-default" className={inputClass} value={s.email_subject} onChange={set('email_subject')} />
          </Field>
          <Field label="Email message" htmlFor="ce-message-default" className="sm:col-span-2" hint={`Placeholders: ${PLACEHOLDER_HINT}`}>
            <textarea id="ce-message-default" rows={7} className={inputClass} value={s.email_message} onChange={set('email_message')} />
          </Field>
        </div>
        <Can permission="admin.ce" level="edit">
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={secondaryButtonClass} disabled={!settingsDirty || busy} onClick={() => setS(saved)}>
              Undo Changes
            </button>
            <button type="button" className={buttonClass} disabled={!settingsDirty || busy} onClick={saveSettings}>
              Save Changes
            </button>
          </div>
        </Can>
      </section>

      {templates.map((t) => {
        const was = savedTpl.find((x) => x.id === t.id)
        const dirty = !was || was.title !== t.title || was.part1 !== t.part1 || was.part2 !== t.part2
        const kind: CeKind = t.key === 'ce_eu' ? 'eu_2023' : 'ec_2006'
        const update = (patch: Partial<Template>) => setTemplates((list) => list.map((x) => (x.id === t.id ? { ...x, ...patch } : x)))
        return (
          <section key={t.id} className="max-w-3xl space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting={`ce-template-${t.key}`}>
            <h2 className="font-semibold">
              {t.name}
              {saved.declaration_type === kind && <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-xs font-medium text-green-800">In use</span>}
            </h2>
            <Field label="Title" htmlFor={`ce-title-${t.key}`}>
              <input id={`ce-title-${t.key}`} className={inputClass} value={t.title} onChange={(e) => update({ title: e.target.value })} />
            </Field>
            <div>
              <p className="mb-1 font-medium text-slate-700">Declaration (section 4, above the list of directives)</p>
              <RichTextEditor key={`${t.key}-1-${version}`} label="Declaration" value={t.part1} onChange={(part1) => update({ part1 })} />
            </div>
            <div>
              <p className="mb-1 font-medium text-slate-700">Closing words (above the signature; optional)</p>
              <RichTextEditor key={`${t.key}-2-${version}`} label="Closing words" value={t.part2} onChange={(part2) => update({ part2 })} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <select
                aria-label="Machine to preview with"
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={previewMachine}
                onChange={(e) => setPreviewMachine(e.target.value)}
              >
                {machines.length === 0 && <option value="">No machines with serial numbers yet</option>}
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.machine_type} {m.serial_number}
                  </option>
                ))}
              </select>
              <button type="button" className={secondaryButtonClass} disabled={!previewMachine} onClick={() => preview(kind)}>
                Preview for This Machine
              </button>
              <Can permission="admin.ce" level="edit">
                <button
                  type="button"
                  className={secondaryButtonClass}
                  disabled={!dirty || busy}
                  onClick={() => {
                    if (was) update(was)
                    setVersion((v) => v + 1)
                  }}
                >
                  Undo Changes
                </button>
                <button type="button" className={buttonClass} disabled={!dirty || busy} onClick={() => saveTemplate(t)}>
                  Save Changes
                </button>
              </Can>
            </div>
          </section>
        )
      })}

      <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-4" data-setting="ce-register">
        <h2 className="font-semibold">Register of Declarations</h2>
        <p className="text-sm text-slate-600">Every declaration issued, newest first: who issued it, when, and who it was sent to.</p>
        <Can anyOf={['ce', 'admin.ce']}>
          <CeRegister />
        </Can>
      </section>
    </div>
  )
}
