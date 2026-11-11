// @permission-scope admin.checklists
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, inputClass, secondaryButtonClass } from '../../components/form'
import { groupBySection, SUGGESTED_SECTIONS, type TemplateItem } from '../../lib/checklists'
import { fetchAll } from '../../lib/fetchAll'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { askText } from '../../lib/confirm'

const GENERAL = 'general'

/**
 * Checklist templates: a general list for every machine, plus extra items per
 * machine type. Final checks copy these when they start; editing here never
 * changes checklists already started.
 */
export default function ChecklistTemplatesPage() {
  const [types, setTypes] = useState<{ id: string; name: string }[]>([])
  const [all, setAll] = useState<TemplateItem[]>([])
  const [list, setList] = useState<string>(GENERAL) // GENERAL or a machine type id
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
      fetchAll<TemplateItem>(() => supabase!.from('checklist_template_items').select('*').order('sort_order').order('id')),
    ])
    if (t.error || i.error) toast.error(friendlyError(t.error ?? i.error))
    setTypes((t.data as { id: string; name: string }[]) ?? [])
    setAll(i.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const typeId = list === GENERAL ? null : list
  const inList = useMemo(() => all.filter((i) => i.machine_type_id === typeId), [all, typeId])
  const active = inList.filter((i) => !i.archived)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const visible = inList.filter(
    (i) =>
      (showArchived || !i.archived) &&
      words.every((w) => `${i.section} ${i.item_text}`.toLowerCase().includes(w)),
  )
  const sections = groupBySection(visible)
  const sectionNames = [...new Set([...groupBySection(active).map((s) => s.section), ...SUGGESTED_SECTIONS])]
  const countFor = (id: string | null) => all.filter((i) => i.machine_type_id === id && !i.archived).length

  // ---- Saving -----------------------------------------------------------------
  async function saveOrder(ids: string[]) {
    if (!supabase) return
    const { error } = await supabase.rpc('reorder_checklist_template', { p_ids: ids })
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
    if (!supabase) return
    if (!newSection.trim()) return toast.error('Enter or select a section, for example Electrical.')
    if (!newText.trim()) return toast.error('Type the item.')
    const max = Math.max(0, ...inList.map((i) => i.sort_order))
    const { error } = await supabase
      .from('checklist_template_items')
      .insert({ machine_type_id: typeId, section: newSection.trim(), item_text: newText.trim(), sort_order: max + 10 })
    if (error) return toast.error(friendlyError(error))
    setNewText('')
    load()
  }

  async function saveEdit() {
    if (!supabase || !editing) return
    if (!editing.text.trim() || !editing.section.trim()) return toast.error('Section and item can’t be empty.')
    const { error } = await supabase
      .from('checklist_template_items')
      .update({ section: editing.section.trim(), item_text: editing.text.trim() })
      .eq('id', editing.id)
    if (error) return toast.error(friendlyError(error))
    setEditing(null)
    load()
  }

  async function setArchived(item: TemplateItem, archived: boolean) {
    if (!supabase) return
    const { error } = await supabase.from('checklist_template_items').update({ archived }).eq('id', item.id)
    if (error) return toast.error(friendlyError(error))
    toast.success(archived ? 'Archived. New final checks won’t include it.' : 'Brought back.')
    load()
  }

  async function renameSection(section: string) {
    if (!supabase) return
    const name = await askText(`Enter a new name for the section “${section}”.`, { initial: section, label: 'Section name', confirmLabel: 'Rename Section' })
    if (!name || name === section) return
    let q = supabase.from('checklist_template_items').update({ section: name }).eq('section', section)
    q = typeId ? q.eq('machine_type_id', typeId) : q.is('machine_type_id', null)
    const { error } = await q
    if (error) return toast.error(friendlyError(error))
    load()
  }

  return (
    <div className="space-y-5">
      <AdminPageHeader title="Checklists">
        The final check for each machine is copied from these lists when it is started: the <strong>general</strong> list
        (every machine) followed by the extra items for that <strong>machine type</strong>. Changes here only affect final
        checks started afterwards.
      </AdminPageHeader>

      <div className="grid gap-2 md:grid-cols-[18rem_1fr_auto]">
        <select aria-label="Which list" className={inputClass} value={list} onChange={(e) => setList(e.target.value)}>
          <option value={GENERAL}>General – every machine ({countFor(null)})</option>
          <optgroup label="Extra items for one machine type">
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({countFor(t.id)})
              </option>
            ))}
          </optgroup>
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
            list="checklist-sections"
            className={inputClass}
            placeholder="Section, for example Electrical"
            value={newSection}
            onChange={(e) => setNewSection(e.target.value)}
          />
          <datalist id="checklist-sections">
            {sectionNames.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <input
            aria-label="Item"
            className={inputClass}
            placeholder="What to check, for example Emergency stop works"
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
          {words.length ? 'No items match the search.' : 'There are no items yet. Add the first one above.'}
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
                          list="checklist-sections"
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
