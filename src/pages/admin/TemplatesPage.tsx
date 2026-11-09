// @permission-scope admin.templates
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import RichText from '../../components/RichText'
import RichTextEditor from '../../components/RichTextEditor'
import { useCompany } from '../../lib/company'
import { showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { fillPlaceholders, PLACEHOLDERS } from '../../lib/service'
import { confirmAction } from '../../lib/confirm'
import { supabase } from '../../lib/supabase'

type Template = { id: string; key: string; name: string; title: string; part1: string; part2: string; updated_at: string }

/** Admin → Templates: the commissioning certificate and service report texts. */
export default function TemplatesPage() {
  const [key, setKey] = useState<'commissioning' | 'service_report'>('commissioning')
  const [saved, setSaved] = useState<Template | null>(null)
  const [t, setT] = useState<Template | null>(null)
  const [version, setVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const company = useCompany()
  const today = todayISO()

  useEffect(() => {
    supabase
      ?.from('document_templates')
      .select('*')
      .eq('key', key)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) toast.error(friendlyError(error))
        setSaved(data as Template | null)
        setT(data as Template | null)
        setVersion((v) => v + 1)
      })
  }, [key])

  if (!t || !saved) return <p className="p-6 text-center text-slate-500">Loading…</p>
  const dirty = t.title !== saved.title || t.part1 !== saved.part1 || t.part2 !== saved.part2
  const sample: Record<string, string> = {
    tech_full_name: 'Tom Technician',
    company_name: company.name || 'Belfast Mini Mills',
    customer_name: 'Jane Farmer',
    customer_company: 'Woolly Acres',
    order_number: key === 'service_report' ? 'S-12' : '76',
    start_date: showDate(today),
    end_date: showDate(today),
    site_address: 'Charlottetown, PE, Canada',
    today: showDate(today),
  }

  async function save() {
    if (!supabase || !t) return
    if (!t.title.trim()) return toast.error('The title cannot be empty.')
    setSaving(true)
    const { data, error } = await supabase.from('document_templates').update({ title: t.title.trim(), part1: t.part1, part2: t.part2 }).eq('id', t.id).select('*').single()
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    setSaved(data as Template)
    setT(data as Template)
    toast.success('Template saved. New documents use it; documents already created keep their own text.')
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <AdminPageHeader title="Templates">
        The commissioning certificate (training) and the service report (service calls). Creating one copies this text; the
        technician can then change that one document without changing the template. Placeholders in curly brackets are
        filled in automatically; on a service report {'{order_number}'} is the service call number (for example S-12).
      </AdminPageHeader>

      <div className="flex gap-2" role="tablist" aria-label="Template">
        {(
          [
            ['commissioning', 'Commissioning Certificate'],
            ['service_report', 'Service Report'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={key === k}
            className={key === k ? buttonClass : secondaryButtonClass}
            onClick={async () => {
              if (key === k) return
              if (dirty && !(await confirmAction('Your changes to this template are not saved. Leave them?', { confirmLabel: 'Leave Without Saving' }))) return
              setKey(k)
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">{t.name}</h2>
        <Field label="Title" htmlFor="tpl-title">
          <input id="tpl-title" className={inputClass} value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} />
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Part 1 (above the machine table)</p>
          <RichTextEditor key={`p1-${version}`} headings label="Part 1" value={t.part1} onChange={(part1) => setT({ ...t, part1 })} />
        </div>
        <p className="rounded bg-slate-50 p-2 text-center text-sm text-slate-500">The table of machines and serial numbers from the order goes here.</p>
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Part 2 (below the table, above the signatures)</p>
          <RichTextEditor key={`p2-${version}`} headings label="Part 2" value={t.part2} onChange={(part2) => setT({ ...t, part2 })} />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty && <span className="text-sm text-amber-800">Changes not saved yet.</span>}
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={!dirty || saving}
            onClick={() => {
              setT(saved)
              setVersion((v) => v + 1)
            }}
          >
            Undo Changes
          </button>
          <button type="button" className={buttonClass} disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="mb-2 font-semibold">Placeholders</h2>
        <ul className="grid gap-1 sm:grid-cols-2">
          {PLACEHOLDERS.map((p) => (
            <li key={p.key}>
              <code className="rounded bg-slate-100 px-1">{`{${p.key}}`}</code> {p.label}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">Preview With Sample Details</h2>
        <h3 className="text-center text-lg font-bold">{t.title}</h3>
        <RichText value={fillPlaceholders(t.part1, sample)} className="text-sm" />
        <table className="w-full border border-slate-300 text-left text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="border border-slate-300 px-2 py-1">Machine</th>
              <th className="border border-slate-300 px-2 py-1">Serial number</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-slate-300 px-2 py-1">Carder - Large</td>
              <td className="border border-slate-300 px-2 py-1 font-mono">LCR-2072</td>
            </tr>
          </tbody>
        </table>
        <RichText value={fillPlaceholders(t.part2, sample)} className="text-sm" />
      </section>
    </div>
  )
}
