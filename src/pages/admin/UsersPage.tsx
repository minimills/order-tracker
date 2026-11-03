import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../../components/form'
import { emailPattern } from '../../components/order/customer'
import { useAuth } from '../../lib/auth'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { Role } from '../../lib/auth'
import { useDepartments } from '../../lib/useDepartments'

type User = { email: string; name: string | null; role: Role; created_at: string }

const selectClass = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm'
const NO_DEPARTMENT = '__none'

export default function UsersPage() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<User | null>(null)
  const { departments } = useDepartments()
  const activeDepartments = departments.filter((d) => !d.archived)
  // email → department ids
  const [memberships, setMemberships] = useState<Record<string, string[]>>({})
  const [newDepts, setNewDepts] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [editingDepts, setEditingDepts] = useState<{ user: User; chosen: string[] } | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const [{ data, error: e }, links] = await Promise.all([
      supabase.from('allowed_users').select('email, name, role, created_at').order('email'),
      supabase.from('user_departments').select('user_email, department_id'),
    ])
    if (e) toast.error(friendlyError(e))
    setUsers((data as User[]) ?? [])
    const m: Record<string, string[]> = {}
    for (const l of (links.data as { user_email: string; department_id: string }[]) ?? []) {
      m[l.user_email] = [...(m[l.user_email] ?? []), l.department_id]
    }
    setMemberships(m)
    setLoading(false)
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    const address = email.trim().toLowerCase()
    if (!emailPattern.test(address)) return setError('Enter a full email address, e.g. name@minimills.net')
    if (users.some((u) => u.email === address)) return setError('This person is already on the list.')
    const { error: e } = await supabase.from('allowed_users').insert({ email: address, name: name.trim() || null, role })
    if (e) return setError(friendlyError(e))
    if (newDepts.length) {
      const { error: e2 } = await supabase
        .from('user_departments')
        .insert(newDepts.map((department_id) => ({ user_email: address, department_id })))
      if (e2) toast.error(`Added, but the departments could not be saved: ${friendlyError(e2)}`)
    }
    toast.success(`${address} can now sign in as ${role}.`)
    setNewDepts([])
    setEmail('')
    setName('')
    setRole('staff')
    setError(null)
    load()
  }

  async function changeRole(u: User, newRole: Role) {
    if (!supabase) return
    const { error: e } = await supabase.from('allowed_users').update({ role: newRole }).eq('email', u.email)
    if (e) return toast.error(friendlyError(e))
    toast.success(`${u.email} is now ${newRole}.`)
    load()
  }

  async function saveDepartments() {
    if (!supabase || !editingDepts) return
    const { user, chosen } = editingDepts
    const before = memberships[user.email] ?? []
    const add = chosen.filter((id) => !before.includes(id))
    const drop = before.filter((id) => !chosen.includes(id))
    if (add.length) {
      const { error: e } = await supabase.from('user_departments').insert(add.map((department_id) => ({ user_email: user.email, department_id })))
      if (e) return toast.error(friendlyError(e))
    }
    if (drop.length) {
      const { error: e } = await supabase.from('user_departments').delete().eq('user_email', user.email).in('department_id', drop)
      if (e) return toast.error(friendlyError(e))
    }
    toast.success(`Departments saved for ${user.email}.`)
    setEditingDepts(null)
    load()
  }

  const shownUsers = users.filter((u) => {
    const mine = memberships[u.email] ?? []
    if (!filter) return true
    if (filter === NO_DEPARTMENT) return mine.length === 0
    return mine.includes(filter)
  })

  const deptCheckboxes = (chosen: string[], set: (ids: string[]) => void, list = activeDepartments) => (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {list.map((d) => (
        <label key={d.id} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={chosen.includes(d.id)}
            onChange={(e) => set(e.target.checked ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))}
          />
          {d.name}
          {d.archived && <span className="text-xs text-slate-400">(archived)</span>}
        </label>
      ))}
    </div>
  )

  async function remove(u: User) {
    if (!supabase) return
    const { error: e } = await supabase.from('allowed_users').delete().eq('email', u.email)
    setRemoving(null)
    if (e) return toast.error(friendlyError(e))
    toast.success(`${u.email} can no longer use the app.`)
    load()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <AdminPageHeader title="Users">
        Only people on this list can use the app. They sign in with a code sent to their email, no password. <strong>Staff</strong>{' '}
        can add and edit orders, customers, machines and payments. <strong>Admins</strong> can also use these Admin pages
        and delete things.
      </AdminPageHeader>

      <form onSubmit={add} className="rounded-lg border border-slate-200 bg-white p-4" noValidate>
        <h2 className="mb-3 font-semibold">Add a person</h2>
        <div className="grid gap-3 md:grid-cols-[2fr_1.5fr_8rem_auto]">
          <Field label="Email" htmlFor="new-email">
            <input id="new-email" type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Name (optional)" htmlFor="new-name">
            <input id="new-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role" htmlFor="new-role">
            <select id="new-role" className={inputClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <div className="flex items-start md:pt-6">
            <button type="submit" className={buttonClass}>
              Add
            </button>
          </div>
        </div>
        {activeDepartments.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-sm font-medium text-slate-700">Departments</div>
            {deptCheckboxes(newDepts, setNewDepts)}
          </div>
        )}
        {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
        <p className="mt-2 text-xs text-slate-500">Then tell them to open the app and sign in with that email.</p>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">
          People <span className="text-sm font-normal text-slate-500">({shownUsers.length})</span>
        </h2>
        <select aria-label="Filter by department" className={selectClass} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All departments</option>
          {activeDepartments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value={NO_DEPARTMENT}>No department</option>
        </select>
      </div>

      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {loading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {shownUsers.length === 0 && !loading && <p className="p-4 text-sm text-slate-500">Nobody in this department.</p>}
        {shownUsers.map((u) => (
          <div key={u.email} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium break-all">
                {u.email}
                {u.email === me && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
              </div>
              <div className="text-xs text-slate-500">
                {u.name ? `${u.name} · ` : ''}added {showDate(u.created_at.slice(0, 10))}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {(memberships[u.email] ?? [])
                  .map((id) => departments.find((d) => d.id === id))
                  .filter((d) => d !== undefined)
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((d) => (
                    <span key={d.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      {d.name}
                    </span>
                  ))}
                {(memberships[u.email] ?? []).length === 0 && <span className="text-xs text-slate-400">No department</span>}
                <button
                  type="button"
                  className="text-xs text-blue-700 underline"
                  onClick={() => setEditingDepts({ user: u, chosen: memberships[u.email] ?? [] })}
                >
                  Change
                </button>
              </div>
            </div>
            <select
              aria-label={`Role for ${u.email}`}
              className={selectClass}
              value={u.role}
              onChange={(e) => changeRole(u, e.target.value as Role)}
            >
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
            <button type="button" className="text-sm text-red-700 underline" onClick={() => setRemoving(u)}>
              Remove access
            </button>
          </div>
        ))}
      </div>

      {editingDepts && (
        <Modal
          title={`Departments for ${editingDepts.user.email}`}
          onClose={() => setEditingDepts(null)}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setEditingDepts(null)}>
                Cancel
              </button>
              <button type="button" className={buttonClass} onClick={saveDepartments}>
                Save
              </button>
            </>
          }
        >
          {deptCheckboxes(
            editingDepts.chosen,
            (ids) => setEditingDepts({ ...editingDepts, chosen: ids }),
            // archived departments only show if the person is still in one
            departments.filter((d) => !d.archived || editingDepts.chosen.includes(d.id)),
          )}
          <p className="mt-3 text-xs text-slate-500">A person can be in more than one department.</p>
        </Modal>
      )}

      {removing && (
        <Modal
          title="Remove access?"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800" onClick={() => remove(removing)}>
                Remove access
              </button>
            </>
          }
        >
          <p className="text-sm">
            <strong>{removing.email}</strong> will no longer be able to see or change anything.
            {removing.email === me && ' This is you: you will lose access straight away.'} Their past changes stay in
            the activity log.
          </p>
        </Modal>
      )}
    </div>
  )
}
