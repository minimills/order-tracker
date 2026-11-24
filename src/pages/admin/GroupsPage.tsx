// @permission-scope admin.groups
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, inputClass, secondaryButtonClass } from '../../components/form'
import type { Group, Person } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { confirmAction } from '../../lib/confirm'
import { tr } from '../../i18n'

type Member = { group_id: string; user_email: string }

/** Admin → Groups: custom groups of people (Procurement, Techs…) for sharing boards and notifications. */
export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [name, setName] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const [g, m, p] = await Promise.all([
      supabase.from('user_groups').select('id, name, description, archived').order('name'),
      supabase.from('user_group_members').select('group_id, user_email'),
      supabase.rpc('people_choices'),
    ])
    if (g.error) toast.error(friendlyError(g.error))
    setGroups((g.data as Group[]) ?? [])
    setMembers((m.data as Member[]) ?? [])
    setPeople((p.data as Person[]) ?? [])
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const run = async (fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>, ok?: string) => {
    setBusy(true)
    const { error } = await fn()
    setBusy(false)
    if (error) {
      toast.error(error.code === '23505' ? tr("There is already a group with that name.") : friendlyError(error))
      return false
    }
    if (ok) toast.success(ok)
    load()
    return true
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    if (await run(() => supabase!.from('user_groups').insert({ name: name.trim() }), `Group “${name.trim()}” added.`)) setName('')
  }

  const nameOf = (email: string) => people.find((p) => p.email === email)?.name ?? email
  return (
    <div className="space-y-5">
      <AdminPageHeader title={tr("Groups")}>
        {tr("Groups of people, for example Procurement or Techs. Use them to share boards and choose who gets board notifications. A person can be in any number of groups. (Departments are set in Admin → Departments.)")}
      </AdminPageHeader>

      <form onSubmit={add} className="flex gap-2 rounded-lg border border-slate-200 bg-white p-4">
        <input aria-label={tr("New group name")} className={inputClass} placeholder={tr("New group, for example Procurement")} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className={buttonClass} disabled={busy}>
          {tr("Create Group")}
        </button>
      </form>

      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {tr("Show archived groups")}
      </label>

      <ul className="space-y-3">
        {groups
          .filter((g) => showArchived || !g.archived)
          .map((g) => {
            const mine = members.filter((m) => m.group_id === g.id)
            return (
              <li key={g.id} className={`rounded-lg border border-slate-200 bg-white p-4 ${g.archived ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={tr("Group name {{name}}", { name: g.name })}
                    className={`${inputClass} max-w-xs font-semibold`}
                    defaultValue={g.name}
                    disabled={g.archived}
                    onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== g.name && run(() => supabase!.from('user_groups').update({ name: e.target.value.trim() }).eq('id', g.id))}
                  />
                  <span className="text-sm text-slate-500">
                    {mine.length} {mine.length === 1 ? tr("person") : tr("people")}
                  </span>
                  <button
                    type="button"
                    className={`${secondaryButtonClass} ml-auto`}
                    disabled={busy}
                    onClick={async () =>
                      (g.archived || (await confirmAction(tr("Archive the group “{{name}}”? Boards shared with this group are no longer shared with its members.", { name: g.name }), { get confirmLabel() {
    return tr("Archive")
  } }))) &&
                      run(() => supabase!.from('user_groups').update({ archived: !g.archived }).eq('id', g.id))
                    }
                  >
                    {g.archived ? tr("Restore") : tr("Archive")}
                  </button>
                </div>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {mine.map((m) => (
                    <li key={m.user_email} className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-sm">
                      {nameOf(m.user_email)}
                      {!g.archived && (
                        <button
                          type="button"
                          aria-label={tr("Remove {{nameOf}} from {{name}}", { nameOf: nameOf(m.user_email), name: g.name })}
                          className="text-xs text-slate-500 hover:text-red-700"
                          onClick={() => run(() => supabase!.from('user_group_members').delete().eq('group_id', g.id).eq('user_email', m.user_email))}
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                  {mine.length === 0 && <li className="text-sm text-slate-500">{tr("Nobody yet.")}</li>}
                </ul>
                {!g.archived && (
                  <select
                    aria-label={tr("Add a person to {{name}}", { name: g.name })}
                    className={`${inputClass} mt-2 max-w-xs py-1`}
                    value=""
                    disabled={busy}
                    onChange={(e) => e.target.value && run(() => supabase!.from('user_group_members').insert({ group_id: g.id, user_email: e.target.value }))}
                  >
                    <option value="">{tr("Add a person…")}</option>
                    {people
                      .filter((p) => !mine.some((m) => m.user_email === p.email))
                      .map((p) => (
                        <option key={p.email} value={p.email}>
                          {p.name} ({p.email})
                        </option>
                      ))}
                  </select>
                )}
              </li>
            )
          })}
        {groups.length === 0 && <li className="text-sm text-slate-500">{tr("No groups have been created yet.")}</li>}
      </ul>
    </div>
  )
}
