// @permission-scope admin.machine_types
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useOptionList } from '../../lib/useOptionList'
import { buttonClass, inputClass } from '../form'

type Row = { id: string; name: string; code: string | null; product_description: string | null; ce_directives: string[]; ce_standards: string | null }
type Draft = { product: string; directives: string[]; standards: string }
const toDraft = (r: Row): Draft => ({ product: r.product_description ?? '', directives: r.ce_directives ?? [], standards: r.ce_standards ?? '' })

/**
 * Per machine type, what its declaration of conformity says: the product
 * description ("Textile Machine – Cone Winder"), the directives that apply
 * (from Admin → Dropdown lists → CE directives) and the harmonised standards.
 */
export default function CeTypesSection() {
  const { options } = useOptionList('ce_directive')
  const [rows, setRows] = useState<Row[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [forAll, setForAll] = useState<string[]>([])

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('machine_types').select('id, name, code, product_description, ce_directives, ce_standards').eq('archived', false).order('name')
    if (error) return toast.error(friendlyError(error))
    setRows((data as Row[]) ?? [])
    setDrafts(Object.fromEntries(((data as Row[]) ?? []).map((r) => [r.id, toDraft(r)])))
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function save(r: Row) {
    if (!supabase) return
    const d = drafts[r.id]
    setSaving(r.id)
    const { error } = await supabase
      .from('machine_types')
      .update({ product_description: d.product.trim() || null, ce_directives: d.directives, ce_standards: d.standards.trim() || null })
      .eq('id', r.id)
    setSaving(null)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${r.name}: declaration details saved.`)
    load()
  }

  /** Gives every machine type the same directives (they can still be changed per type below). */
  async function applyToAll() {
    if (!supabase || !forAll.length) return
    if (!(await confirmAction(`Set the directives of all ${rows.length} machine types to: ${forAll.join(', ')}? Declarations already issued keep what they said; reissue them to update.`, { confirmLabel: 'Apply to All' }))) return
    setSaving('all')
    const ordered = options.filter((o) => forAll.includes(o))
    const { error } = await supabase.from('machine_types').update({ ce_directives: ordered }).in('id', rows.map((r) => r.id))
    setSaving(null)
    if (error) return toast.error(friendlyError(error))
    toast.success('Directives set for every machine type.')
    load()
  }

  const shown = rows.filter((r) => !filter.trim() || `${r.name} ${r.code ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()))
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" data-setting="ce-types">
      <h2 className="text-base font-semibold">Declaration of Conformity (per Machine Type)</h2>
      <p className="mt-1 text-sm text-slate-600">
        What the CE declaration says for each type. The model on the declaration is the machine code. Edit the list of directives in Admin → Dropdown Lists → CE directives.
      </p>
      <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
        <div className="mb-1 font-medium">Set the directives for every machine type at once</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {options.map((o) => (
            <label key={o} className="flex items-center gap-2">
              <input type="checkbox" checked={forAll.includes(o)} onChange={(e) => setForAll(e.target.checked ? [...forAll, o] : forAll.filter((x) => x !== o))} />
              {o}
            </label>
          ))}
          <button type="button" className={buttonClass} disabled={!forAll.length || saving !== null} onClick={applyToAll}>
            {saving === 'all' ? 'Saving…' : 'Apply to All Machine Types'}
          </button>
        </div>
      </div>
      <input aria-label="Find a machine type" className={`${inputClass} mt-3 max-w-xs`} placeholder="Find a machine type" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="mt-3 divide-y divide-slate-100">
        {shown.map((r) => {
          const d = drafts[r.id] ?? toDraft(r)
          const set = (patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [r.id]: { ...d, ...patch } }))
          const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(r))
          return (
            <div key={r.id} className="grid gap-3 py-3 text-sm lg:grid-cols-[12rem_1fr_1fr_1fr_auto] lg:items-start">
              <div className="font-medium">
                {r.name}
                <div className="text-xs font-normal text-slate-500">Model {r.code ?? '(no code)'}</div>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">Type of product</span>
                <input className={inputClass} value={d.product} placeholder={`Textile Machine – ${r.name}`} onChange={(e) => set({ product: e.target.value })} />
              </label>
              <fieldset>
                <legend className="mb-1 text-xs text-slate-500">Directives</legend>
                {[...options, ...d.directives.filter((x) => !options.includes(x))].map((o) => (
                  <label key={o} className="flex items-center gap-2 py-0.5">
                    <input
                      type="checkbox"
                      checked={d.directives.includes(o)}
                      onChange={(e) => set({ directives: e.target.checked ? [...d.directives, o] : d.directives.filter((x) => x !== o) })}
                    />
                    {o}
                  </label>
                ))}
              </fieldset>
              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">Harmonised standards (one per line, optional)</span>
                <textarea rows={3} className={inputClass} value={d.standards} placeholder="EN ISO 12100" onChange={(e) => set({ standards: e.target.value })} />
              </label>
              <div className="lg:pt-5">
                <button type="button" className={buttonClass} disabled={!dirty || saving === r.id} onClick={() => save(r)}>
                  {saving === r.id ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          )
        })}
        {shown.length === 0 && <p className="py-3 text-sm text-slate-500">No machine types match.</p>}
      </div>
    </section>
  )
}
