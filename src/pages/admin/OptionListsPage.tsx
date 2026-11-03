import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, inputClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { OptionItem, OptionListName } from '../../lib/types'

const LISTS: { name: OptionListName; title: string }[] = [
  { name: 'voltage', title: 'Voltage' },
  { name: 'delivery_equipment', title: 'Delivery equipment' },
  { name: 'freight_type', title: 'Freight type' },
  { name: 'payment_type', title: 'Payment types' },
]

const small = 'rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40'

function OptionList({ list, items, reload }: { list: (typeof LISTS)[number]; items: OptionItem[]; reload: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newValue, setNewValue] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const active = items.filter((i) => !i.archived)
  const shown = showArchived ? items : active

  async function run(promise: PromiseLike<{ error: { message: string; code?: string } | null }>, ok: string) {
    const { error } = await promise
    if (error) return toast.error(friendlyError(error))
    toast.success(ok)
    reload()
  }

  async function rename(item: OptionItem) {
    if (!supabase) return
    const value = (drafts[item.id] ?? item.value).trim()
    if (!value || value === item.value) return
    if (items.some((i) => i.id !== item.id && i.value.toLowerCase() === value.toLowerCase()))
      return toast.error('That choice is already in the list.')
    await run(
      supabase.from('option_lists').update({ value }).eq('id', item.id),
      `Renamed to "${value}". Every order using it was updated.`,
    )
    setDrafts((d) => {
      const next = { ...d }
      delete next[item.id]
      return next
    })
  }

  async function move(item: OptionItem, dir: -1 | 1) {
    if (!supabase) return
    // Number the visible order 1..n, then swap with the neighbour.
    const ordered = [...active]
    const i = ordered.findIndex((x) => x.id === item.id)
    const j = i + dir
    if (j < 0 || j >= ordered.length) return
    ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
    const updates = ordered.map((x, k) => supabase!.from('option_lists').update({ sort_order: k + 1 }).eq('id', x.id))
    const results = await Promise.all(updates)
    const failed = results.find((r) => r.error)
    if (failed?.error) toast.error(friendlyError(failed.error))
    reload()
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const value = newValue.trim()
    if (!value) return
    const existing = items.find((i) => i.value.toLowerCase() === value.toLowerCase())
    if (existing) return toast.error(existing.archived ? 'That choice is archived. Show archived and bring it back.' : 'That choice is already in the list.')
    const sort = Math.max(0, ...items.map((i) => i.sort_order)) + 1
    await run(supabase.from('option_lists').insert({ list_name: list.name, value, sort_order: sort }), `Added "${value}".`)
    setNewValue('')
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">{list.title}</h2>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      <ul className="space-y-2">
        {shown.map((item) => {
          const idx = active.findIndex((a) => a.id === item.id)
          const draft = drafts[item.id] ?? item.value
          return (
            <li key={item.id} className={`flex flex-wrap items-center gap-2 ${item.archived ? 'opacity-60' : ''}`}>
              <input
                aria-label={`${list.title} choice`}
                className={`${inputClass} min-w-0 flex-1`}
                value={draft}
                disabled={item.locked || item.archived}
                onChange={(e) => setDrafts({ ...drafts, [item.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && rename(item)}
              />
              {draft.trim() !== item.value && (
                <button type="button" className={buttonClass} onClick={() => rename(item)}>
                  Save
                </button>
              )}
              {!item.archived && (
                <>
                  <button type="button" className={small} disabled={idx <= 0} onClick={() => move(item, -1)} aria-label="Move up">
                    ↑
                  </button>
                  <button type="button" className={small} disabled={idx >= active.length - 1} onClick={() => move(item, 1)} aria-label="Move down">
                    ↓
                  </button>
                </>
              )}
              {item.locked ? (
                <span className="text-xs text-slate-500" title="The app relies on this choice">
                  🔒 built in
                </span>
              ) : (
                <button
                  type="button"
                  className={small}
                  onClick={() =>
                    supabase &&
                    run(
                      supabase.from('option_lists').update({ archived: !item.archived }).eq('id', item.id),
                      item.archived ? `"${item.value}" is back.` : `"${item.value}" archived. Orders that already use it keep it.`,
                    )
                  }
                >
                  {item.archived ? 'Bring back' : 'Archive'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          aria-label={`New ${list.title} choice`}
          className={inputClass}
          placeholder="Add a choice"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button type="submit" className={buttonClass} disabled={!newValue.trim()}>
          Add
        </button>
      </form>
    </section>
  )
}

export default function OptionListsPage() {
  const [items, setItems] = useState<OptionItem[]>([])
  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase
      .from('option_lists')
      .select('id, list_name, value, sort_order, locked, archived')
      .order('sort_order')
      .order('value')
    if (error) toast.error(friendlyError(error))
    setItems((data as OptionItem[]) ?? [])
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <AdminPageHeader title="Dropdown lists">
        The choices offered in the order forms. Renaming a choice updates every order that uses it. Archiving hides it
        from new orders but keeps it on orders that already have it. Built-in choices (🔒) can be moved but not renamed.
      </AdminPageHeader>
      <div className="grid gap-4 md:grid-cols-2">
        {LISTS.map((l) => (
          <OptionList key={l.name} list={l} items={items.filter((i) => i.list_name === l.name)} reload={load} />
        ))}
      </div>
    </div>
  )
}
