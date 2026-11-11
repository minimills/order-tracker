// @permission-scope admin.build_checklists
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, inputClass, secondaryButtonClass } from '../../components/form'
import { groupBySection } from '../../lib/checklists'
import { fetchAll } from '../../lib/fetchAll'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { askText } from '../../lib/confirm'

const BUILD_STEPS = [
  { step: 'fabrication', label: 'Fabrication' },
  { step: 'sandblasting', label: 'Sandblasting' },
  { step: 'powder_coating', label: 'Powder coating' },
  { step: 'assembly', label: 'Assembly' },
] as const

type TemplateItem = {
  id: string
  machine_type_id: string
  step: string
  section: string
  item_text: string
  sort_order: number
  archived: boolean
}

const SUGGESTED_SECTIONS = ['Parts', 'Tasks', 'Frame', 'Electrical', 'Hardware']

/**
 * Build checklists: per machine type and step, the parts and tasks to build it.
 * A machine's production card copies the list of a stage when it arrives there;
 * editing here never changes cards already in that stage.
 */
export default function BuildChecklistsPage() {
  const [types, setTypes] = useState<{ id: string; name: string }[]>([])
  const [all, setAll] = useState<TemplateItem[]>([])
  const [list, setList] = useState<string>('') // machine type id
  const [step, setStep] = useState<string>('fabrication')
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; section: string; text: string } | null>(null)
  const [newSection, setNewSection] = useState('')
  const [newText, setNewText] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!supabase) return
    const [t, i] = await Promise.all([
      supabase.from('machine_types').select('id, name').eq('archived', false).order('name'),
      fetchAll<TemplateItem>(() => supabase!.from('build_checklist_items').select('id, machine_type_id, step, section, item_text, sort_order, archived').order('sort_order').order('id')),
    ])
    if (t.error || i.error) toast.error(friendlyError(t.error ?? i.error))
    const ts = (t.data as { id: string; name: string }[]) ?? []
    setTypes(ts)
    setList((l) => l || ts[0]?.id || '')
    setAll(i.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const typeId = list
  const inList = useMemo(() => all.filter((i) => i.machine_type_id === typeId && i.step === step), [all, typeId, step])
  const active = inList.filter((i) => !i.archived)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const visible = inList.filter(
    (i) =>
      (showArchived || !i.archived) &&
      words.every((w) => `${i.section} ${i.item_text}`.toLowerCase().includes(w)),
  )
  const sections = groupBySection(visible)
  const sectionNames = [...new Set([...groupBySection(active).map((s) => s.section), ...SUGGESTED_SECTIONS])]
  const countFor = (id: string, st?: string) => all.filter((i) => i.machine_type_id === id && (!st || i.step === st) && !i.archived).length

  // ---- Saving -----------------------------------------------------------------
  async function saveOrder(ids: string[]) {
    if (!supabase) return
    const { error } = await supabase.rpc('reorder_build_checklist', { p_ids: ids })
    if (error) toast.error(friendlyError(error))
    load()
  }

  /** The whole list's order (sections in order, items in order) after a change. */
  function orderedIds(groups: { section: string; items: TemplateItem[] }[]) {
    return groups.flatMap((g) => g.items.map((i) => i.id))
  }

  function moveItem(item: TemplateItem, dir: -1 | 1) {
    const groups = groupBySection(inList)
    const g = groups.find((x) => x.section === item.section)!
    const idx = g.items.findIndex((i) => i.id === item.id)
    const to = idx + dir
    if (to < 0 || to >= g.items.length) return
    const items = [...g.items]
    ;[items[idx], items[to]] = [items[to], items[idx]]
    g.items = items
    saveOrder(orderedIds(groups))
  }

  function moveSection(section: string, dir: -1 | 1) {
    const groups = groupBySection(inList)
    const idx = groups.findIndex((g) => g.section === section)
    const to = idx + dir
    if (to < 0 || to >= groups.length) return
    ;[groups[idx], groups[to]] = [groups[to], groups[idx]]
    saveOrder(orderedIds(groups))
  }

  function dropOn(target: TemplateItem, e: DragEvent) {
    e.preventDefault()
    const dragged = inList.find((i) => i.id === dragId)
    setDragId(null)
    if (!dragged || dragged.id === target.id || dragged.section !== target.section) return
    const groups = groupBySection(inList)
    const g = groups.find((x) => x.section === target.section)!
    const without = g.items.filter((i) => i.id !== dragged.id)
    const at = without.findIndex((i) => i.id === target.id)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    without.splice(after ? at + 1 : at, 0, dragged)
    g.items = without
    saveOrder(orderedIds(groups))
  }

  async function add() {
    if (!supabase || !typeId) return
    if (!newSection.trim()) return toast.error('Enter or select a section, for example Parts.')
    if (!newText.trim()) return toast.error('Type the item.')
    const max = Math.max(0, ...inList.map((i) => i.sort_order))
    const { error } = await supabase
      .from('build_checklist_items')
      .insert({ machine_type_id: typeId, step, section: newSection.trim(), item_text: newText.trim(), sort_order: max + 10 })
    if (error) return toast.error(friendlyError(error))
    setNewText('')
    load()
  }

  async function saveEdit() {
    if (!supabase || !editing) return
    if (!editing.text.trim() || !editing.section.trim()) return toast.error('Section and item can’t be empty.')
    const { error } = await supabase
      .from('build_checklist_items')
      .update({ section: editing.section.trim(), item_text: editing.text.trim() })
      .eq('id', editing.id)
    if (error) return toast.error(friendlyError(error))
    setEditing(null)
    load()
  }

  async function setArchived(item: TemplateItem, archived: boolean) {
    if (!supabase) return
    const { error } = await supabase.from('build_checklist_items').update({ archived }).eq('id', item.id)
    if (error) return toast.error(friendlyError(error))
    toast.success(archived ? 'Archived. Cards arriving in this stage won’t include it.' : 'Restored.')
    load()
  }

  async function renameSection(section: string) {
    if (!supabase) return
    const name = await askText(`Enter a new name for the section “${section}”.`, { initial: section, label: 'Section name', confirmLabel: 'Rename Section' })
    if (!name || name === section) return
    const { error } = await supabase
      .from('build_checklist_items')
      .update({ section: name })
      .eq('section', section)
      .eq('machine_type_id', typeId)
      .eq('step', step)
    if (error) return toast.error(friendlyError(error))
    load()
  }

  return (
    <div className="space-y-5">
      <AdminPageHeader title="Build Checklists">
        For each machine type and step, list the parts and tasks needed to build it. When a machine’s production card
        arrives in a stage, that step’s list is copied onto the card, where people press Start and Finish on each task.
        Changes here only affect cards that arrive in the stage afterwards.
      </AdminPageHeader>

      <div className="grid gap-2 lg:grid-cols-[16rem_12rem_1fr_auto]">
        <select aria-label="Machine type" className={inputClass} value={list} onChange={(e) => setList(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({countFor(t.id)})
            </option>
          ))}
        </select>
        <select aria-label="Step" className={inputClass} value={step} onChange={(e) => setStep(e.target.value)}>
          {BUILD_STEPS.map((s) => (
            <option key={s.step} value={s.step}>
              {s.label} ({list ? countFor(list, s.step) : 0})
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label="Search items"
          className={inputClass}
          placeholder="Search this list"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm whitespace-nowrap text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {/* Add */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 font-semibold">Add an Item</h2>
        <div className="grid gap-2 md:grid-cols-[14rem_1fr_auto]">
          <input
            aria-label="Section"
            list="build-sections"
            className={inputClass}
            placeholder="Section, for example Parts"
            value={newSection}
            onChange={(e) => setNewSection(e.target.value)}
          />
          <datalist id="build-sections">
            {sectionNames.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <input
            aria-label="Item"
            className={inputClass}
            placeholder="Part or task, for example Weld main frame"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button type="button" className={buttonClass} onClick={add}>
            Add
          </button>
        </div>
      </section>

      {/* Sections */}
      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>
          {active.length} item{active.length === 1 ? '' : 's'} in {groupBySection(active).length} section
          {groupBySection(active).length === 1 ? '' : 's'}. Drag ⠿ or use ↑ ↓ to change the order.
        </span>
        <span className="flex gap-3">
          <button type="button" className="underline" onClick={() => setCollapsed(new Set())}>
            Expand All
          </button>
          <button type="button" className="underline" onClick={() => setCollapsed(new Set(sections.map((s) => s.section)))}>
            Collapse All
          </button>
        </span>
      </div>

      {loading && <p className="text-center text-slate-500">Loading…</p>}
      {!loading && sections.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-slate-500">
          {words.length ? 'No items match the search.' : 'There are no items for this machine type and step yet. Add the first one above.'}
        </p>
      )}

      {sections.map(({ section, items }, si) => {
        const closed = collapsed.has(section) && !words.length
        return (
          <section key={section} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-3 py-2">
              <button
                type="button"
                className="font-semibold"
                aria-expanded={!closed}
                onClick={() =>
                  setCollapsed((s) => {
                    const n = new Set(s)
                    if (n.has(section)) n.delete(section)
                    else n.add(section)
                    return n
                  })
                }
              >
                <span className="mr-1 text-slate-400">{closed ? '▸' : '▾'}</span>
                {section} <span className="text-sm font-normal text-slate-500">({items.filter((i) => !i.archived).length})</span>
              </button>
              <span className="flex items-center gap-2 text-xs">
                <button type="button" className="rounded border border-slate-300 px-1.5" disabled={si === 0} onClick={() => moveSection(section, -1)} aria-label={`Move section ${section} up`}>
                  ↑
                </button>
                <button
                  type="button"
                  className="rounded border border-slate-300 px-1.5"
                  disabled={si === sections.length - 1}
                  onClick={() => moveSection(section, 1)}
                  aria-label={`Move section ${section} down`}
                >
                  ↓
                </button>
                <button type="button" className="underline" onClick={() => renameSection(section)}>
                  Rename
                </button>
              </span>
            </div>
            {!closed && (
              <ul className="divide-y divide-slate-100">
                {items.map((item, ii) => (
                  <li
                    key={item.id}
                    draggable={!item.archived && !words.length}
                    onDragStart={() => setDragId(item.id)}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => dragId && e.preventDefault()}
                    onDrop={(e) => dropOn(item, e)}
                    className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${item.archived ? 'bg-slate-50 text-slate-400' : ''} ${
                      dragId === item.id ? 'opacity-40' : ''
                    }`}
                  >
                    <span className="cursor-grab text-slate-400 select-none" aria-hidden="true">
                      ⠿
                    </span>
                    {editing?.id === item.id ? (
                      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[12rem_1fr_auto]">
                        <input
                          aria-label="Section"
                          list="build-sections"
                          className={inputClass}
                          value={editing.section}
                          onChange={(e) => setEditing({ ...editing, section: e.target.value })}
                        />
                        <input
                          aria-label="Item"
                          className={inputClass}
                          value={editing.text}
                          autoFocus
                          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                        />
                        <span className="flex gap-2">
                          <button type="button" className={buttonClass} onClick={saveEdit}>
                            Save Changes
                          </button>
                          <button type="button" className={secondaryButtonClass} onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </span>
                      </div>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1">{item.item_text}</span>
                        {item.archived ? (
                          <button type="button" className="text-xs underline" onClick={() => setArchived(item, false)}>
                            Restore
                          </button>
                        ) : (
                          <span className="flex items-center gap-2 text-xs">
                            <button type="button" className="rounded border border-slate-300 px-1.5" disabled={ii === 0} onClick={() => moveItem(item, -1)} aria-label="Move up">
                              ↑
                            </button>
                            <button
                              type="button"
                              className="rounded border border-slate-300 px-1.5"
                              disabled={ii === items.length - 1}
                              onClick={() => moveItem(item, 1)}
                              aria-label="Move down"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="underline"
                              onClick={() => setEditing({ id: item.id, section: item.section, text: item.item_text })}
                            >
                              Edit
                            </button>
                            <button type="button" className="text-red-700 underline" onClick={() => setArchived(item, true)}>
                              Archive
                            </button>
                          </span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
