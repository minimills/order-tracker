// @permission-scope admin.departments
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, inputClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { Department } from '../../lib/types'
import { useDepartments } from '../../lib/useDepartments'

const small = 'rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40'

/** Admin → Departments: add, rename, reorder, archive. */
export default function DepartmentsPage() {
  const { departments, reload } = useDepartments()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    supabase
      ?.from('user_departments')
      .select('department_id')
      .then(({ data }) => {
        const c: Record<string, number> = {}
        for (const r of (data as { department_id: string }[]) ?? []) c[r.department_id] = (c[r.department_id] ?? 0) + 1
        setCounts(c)
      })
  }, [departments])

  const active = departments.filter((d) => !d.archived)
  const shown = showArchived ? departments : active
  const taken = (name: string, except?: string) =>
    departments.some((d) => d.id !== except && d.name.trim().toLowerCase() === name.trim().toLowerCase())

  async function save(promise: PromiseLike<{ error: { message: string; code?: string } | null }>, ok: string) {
    const { error } = await promise
    if (error) {
      toast.error(error.code === '23505' ? 'There is already a department with that name.' : friendlyError(error))
      return false
    }
    toast.success(ok)
    await reload()
    return true
  }

  async function rename(d: Department) {
    if (!supabase) return
    const name = (drafts[d.id] ?? d.name).trim()
    if (!name || name === d.name) return
    if (taken(name, d.id)) return toast.error('There is already a department with that name.')
    if (await save(supabase.from('departments').update({ name }).eq('id', d.id), `Renamed to “${name}”.`)) {
      setDrafts((all) => {
        const next = { ...all }
        delete next[d.id]
        return next
      })
    }
  }

  async function move(d: Department, dir: -1 | 1) {
    if (!supabase) return
    const list = [...active]
    const i = list.findIndex((x) => x.id === d.id)
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    const results = await Promise.all(list.map((x, k) => supabase!.from('departments').update({ sort_order: k + 1 }).eq('id', x.id)))
    const failed = results.find((r) => r.error)
    if (failed?.error) toast.error(friendlyError(failed.error))
    reload()
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const name = newName.trim()
    if (!name) return
    if (taken(name)) return toast.error('There is already a department with that name (it may be archived: select "Show archived").')
    const sort = Math.max(0, ...departments.map((d) => d.sort_order)) + 1
    if (await save(supabase.from('departments').insert({ name, sort_order: sort }), `Added “${name}”.`)) setNewName('')
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AdminPageHeader title="Departments">
        The departments people belong to. A person can be in more than one (set that in Users). Archiving hides a
        department from lists but keeps it on past activity.
      </AdminPageHeader>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Departments</h2>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
        <ul className="space-y-2">
          {shown.map((d) => {
            const idx = active.findIndex((a) => a.id === d.id)
            const draft = drafts[d.id] ?? d.name
            return (
              <li key={d.id} className={`flex flex-wrap items-center gap-2 ${d.archived ? 'opacity-60' : ''}`}>
                <input
                  aria-label="Department name"
                  className={`${inputClass} min-w-0 flex-1`}
                  value={draft}
                  disabled={d.archived}
                  onChange={(e) => setDrafts({ ...drafts, [d.id]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && rename(d)}
                />
                {draft.trim() !== d.name && (
                  <button type="button" className={buttonClass} onClick={() => rename(d)}>
                    Save Changes
                  </button>
                )}
                <span className="w-20 text-xs text-slate-500">
                  {counts[d.id] ?? 0} {counts[d.id] === 1 ? 'person' : 'people'}
                </span>
                {!d.archived && (
                  <>
                    <button type="button" className={small} disabled={idx <= 0} onClick={() => move(d, -1)} aria-label={`Move ${d.name} up`}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className={small}
                      disabled={idx >= active.length - 1}
                      onClick={() => move(d, 1)}
                      aria-label={`Move ${d.name} down`}
                    >
                      ↓
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={small}
                  onClick={() =>
                    supabase &&
                    save(
                      supabase.from('departments').update({ archived: !d.archived }).eq('id', d.id),
                      d.archived ? `“${d.name}” is back.` : `“${d.name}” archived.`,
                    )
                  }
                >
                  {d.archived ? 'Restore' : 'Archive'}
                </button>
                <p className="w-full pl-1 text-xs text-slate-500">
                  Default permissions:{' '}
                  {Object.keys(d.default_permissions ?? {}).length ? 'set' : 'none yet (set up in a later step)'}
                </p>
              </li>
            )
          })}
        </ul>
        <form onSubmit={add} className="mt-4 flex gap-2">
          <input
            aria-label="New department"
            className={inputClass}
            placeholder="Add a department"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className={buttonClass} disabled={!newName.trim()}>
            Add
          </button>
        </form>
      </section>
    </div>
  )
}
