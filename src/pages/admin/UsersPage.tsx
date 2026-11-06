// @permission-scope admin.users
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import PermissionEditor, { type OtherUser, type Template } from '../../components/admin/PermissionEditor'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../../components/form'
import { emailPattern } from '../../components/order/customer'
import { useAuth } from '../../lib/auth'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { allowedBy, type Perms } from '../../lib/permissions'
import { startPageChoices } from '../../lib/permissions/nav'
import { CATALOG } from '../../lib/permissions/catalog'
import { supabase } from '../../lib/supabase'
import type { Role } from '../../lib/auth'
import { useDepartments } from '../../lib/useDepartments'
import { adminUsers } from '../../lib/adminUsers'

type User = { email: string; name: string | null; role: Role; created_at: string }

const selectClass = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm'
const NO_DEPARTMENT = '__none'

export default function UsersPage() {
  // Only full admins change roles and permissions (the database checks this too);
  // people given "admin.users" can add and remove people and set departments.
  const { session, isAdmin } = useAuth()
  const me = session?.user.email?.toLowerCase()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<User | null>(null)
  const { departments, reload: reloadDepartments } = useDepartments()
  const activeDepartments = departments.filter((d) => !d.archived)
  // email → department ids
  const [memberships, setMemberships] = useState<Record<string, string[]>>({})
  const [newDepts, setNewDepts] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [editingDepts, setEditingDepts] = useState<{ user: User; chosen: string[] } | null>(null)
  // Permissions (full admins only)
  const [permsByUser, setPermsByUser] = useState<Record<string, Perms>>({})
  const [templates, setTemplates] = useState<Template[]>([])
  const [reviewed, setReviewed] = useState<Set<string>>(new Set())
  const [editingPerms, setEditingPerms] = useState<User | null>(null)
  const [startWith, setStartWith] = useState('')
  const [newStartPage, setNewStartPage] = useState('')
  const [adding, setAdding] = useState(false)
  const [busyEmail, setBusyEmail] = useState<string | null>(null)
  // email → start page ('/board'…; empty = first allowed page)
  const [startPages, setStartPages] = useState<Record<string, string | null>>({})

  const load = useCallback(async () => {
    if (!supabase) return
    const [{ data, error: e }, links, prefs] = await Promise.all([
      supabase.from('allowed_users').select('email, name, role, created_at').order('email'),
      supabase.from('user_departments').select('user_email, department_id'),
      supabase.from('user_preferences').select('user_email, start_page'),
    ])
    setStartPages(
      Object.fromEntries(((prefs.data as { user_email: string; start_page: string | null }[] | null) ?? []).map((r) => [r.user_email, r.start_page])),
    )
    if (e) toast.error(friendlyError(e))
    setUsers((data as User[]) ?? [])
    const m: Record<string, string[]> = {}
    for (const l of (links.data as { user_email: string; department_id: string }[]) ?? []) {
      m[l.user_email] = [...(m[l.user_email] ?? []), l.department_id]
    }
    setMemberships(m)
    if (isAdmin) {
      const [up, tp, rv] = await Promise.all([
        supabase.from('user_permissions').select('user_email, perms'),
        supabase.from('permission_templates').select('id, name, perms').order('name'),
        supabase.from('app_settings').select('value').eq('key', 'permissions_reviewed').maybeSingle(),
      ])
      const pm: Record<string, Perms> = {}
      for (const r of (up.data as { user_email: string; perms: Perms }[]) ?? []) pm[r.user_email] = r.perms
      setPermsByUser(pm)
      setTemplates((tp.data as Template[]) ?? [])
      setReviewed(new Set(((rv.data?.value as { keys?: string[] } | null)?.keys ?? []) as string[]))
    }
    setLoading(false)
  }, [isAdmin])

  async function markReviewed(keys: string[]) {
    if (!supabase) return
    const { error: e } = await supabase.from('app_settings').upsert({ key: 'permissions_reviewed', value: { keys } })
    if (e) return toast.error(friendlyError(e))
    setReviewed(new Set(keys))
    toast.success('Marked as reviewed. Items added to the app later will show a “New” badge again.')
  }

  /** Permissions from a "Start with" choice: dept:<id>, tpl:<id> or user:<email>. */
  function startingPerms(choice: string): { perms: Perms; source: string } | null {
    const [kind, id] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)]
    if (kind === 'dept') {
      const d = departments.find((x) => x.id === id)
      return d ? { perms: d.default_permissions as Perms, source: `department preset ${d.name}` } : null
    }
    if (kind === 'tpl') {
      const t = templates.find((x) => x.id === id)
      return t ? { perms: t.perms, source: `template ${t.name}` } : null
    }
    if (kind === 'user') return { perms: permsByUser[id] ?? {}, source: `copied from ${id}` }
    return null
  }
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!supabase || adding) return
    const address = email.trim().toLowerCase()
    if (!emailPattern.test(address)) return setError('Enter a full email address, for example name@minimills.net')
    if (users.some((u) => u.email === address)) return setError(`${address} already has access to the app.`)
    // New people start with nothing ticked, unless a starting point was chosen.
    const start = role === 'staff' && isAdmin ? startingPerms(startWith) : null
    // One step on the server: the login (Supabase Auth), the users list,
    // departments, start page and permissions, then the login code email.
    setAdding(true)
    const result = await adminUsers('create', {
      email: address,
      name: name.trim() || null,
      role,
      departments: newDepts,
      start_page: newStartPage || null,
      perms: start?.perms ?? null,
      perms_source: start?.source ?? null,
    })
    setAdding(false)
    if (!result.ok) return setError(result.message)
    if (result.emailed === false) toast.warning(result.message, { duration: 12000 })
    else toast.success(`${result.message}${role === 'staff' && !start ? ' No permissions are allowed yet: select “Permissions” to choose what they can see.' : ''}`, { duration: 8000 })
    setStartWith('')
    setNewDepts([])
    setNewStartPage('')
    setEmail('')
    setName('')
    setRole('staff')
    setError(null)
    load()
  }

  async function resend(u: User) {
    setBusyEmail(u.email)
    const result = await adminUsers('resend', { email: u.email })
    setBusyEmail(null)
    if (result.ok) toast.success(result.message)
    else toast.error(result.message, { duration: 10000 })
  }

  async function changeStartPage(u: User, page: string | null) {
    if (!supabase) return
    const { error: e } = await supabase.rpc('set_start_page', { p_email: u.email, p_page: page })
    if (e) return toast.error(friendlyError(e))
    setStartPages((m) => ({ ...m, [u.email]: page }))
    toast.success(`Start page saved for ${u.email}.`)
  }

  async function changeRole(u: User, newRole: Role) {
    if (!supabase) return
    const { error: e } = await supabase.from('allowed_users').update({ role: newRole }).eq('email', u.email)
    if (e) return toast.error(friendlyError(e))
    toast.success(`${u.email} is now ${newRole === 'admin' ? 'an admin (full access)' : 'a user (sees only what is allowed)'}.`)
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
    setBusyEmail(u.email)
    const result = await adminUsers('remove', { email: u.email })
    setBusyEmail(null)
    setRemoving(null)
    if (!result.ok) return toast.error(result.message, { duration: 10000 })
    toast.success(result.message)
    load()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <AdminPageHeader title="Users">
        Only people on this list can use the app. Adding someone creates their login and emails them a 6-digit code (they
        sign in with a code each time, no password; nobody can sign themselves up).{' '}
        <strong>Admins</strong> have full access. Everyone else (<strong>users</strong>) sees only what is allowed
        for them under <strong>Permissions</strong>; new users start with no access.
      </AdminPageHeader>

      {isAdmin && !loading && CATALOG.some((i) => !reviewed.has(i.key)) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <span className="mr-1 rounded bg-blue-600 px-1.5 py-0.5 text-xs font-semibold text-white">New</span>
          {CATALOG.filter((i) => !reviewed.has(i.key)).length} permission item(s) are new since you last reviewed. They
          are not permitted for anyone until you allow them. Open anyone’s <strong>Permissions</strong> to see them.
        </div>
      )}

      <form onSubmit={add} className="rounded-lg border border-slate-200 bg-white p-4" noValidate>
        <h2 className="mb-3 font-semibold">Add a User</h2>
        <div className="grid gap-3 md:grid-cols-[2fr_1.5fr_8rem_auto]">
          <Field label="Email" htmlFor="new-email">
            <input id="new-email" type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Name (optional)" htmlFor="new-name">
            <input id="new-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {isAdmin ? (
            <Field label="Role" htmlFor="new-role">
              <select id="new-role" className={inputClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="staff">User</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
          ) : (
            <span />
          )}
          <div className="flex items-start md:pt-6">
            <button type="submit" className={buttonClass} disabled={adding}>
              {adding ? 'Adding…' : 'Add User'}
            </button>
          </div>
        </div>
        {activeDepartments.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-sm font-medium text-slate-700">Departments</div>
            {deptCheckboxes(newDepts, setNewDepts)}
          </div>
        )}
        {isAdmin && role === 'staff' && (
          <div className="mt-3 max-w-md">
            <Field label="Start with" htmlFor="new-start" hint="No permissions are allowed unless you choose a starting point. You can adjust them afterwards.">
              <select id="new-start" className={inputClass} value={startWith} onChange={(e) => setStartWith(e.target.value)}>
                <option value="">No access granted</option>
                <optgroup label="Department presets">
                  {activeDepartments.map((d) => (
                    <option key={d.id} value={`dept:${d.id}`}>
                      {d.name}
                      {Object.keys(d.default_permissions ?? {}).length === 0 ? ' (empty)' : ''}
                    </option>
                  ))}
                </optgroup>
                {templates.length > 0 && (
                  <optgroup label="Templates">
                    {templates.map((t) => (
                      <option key={t.id} value={`tpl:${t.id}`}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Copy from">
                  {users
                    .filter((u) => u.role === 'staff')
                    .map((u) => (
                      <option key={u.email} value={`user:${u.email}`}>
                        {u.name ? `${u.name} (${u.email})` : u.email}
                      </option>
                    ))}
                </optgroup>
              </select>
            </Field>
          </div>
        )}
        <div className="mt-3 max-w-md">
          <Field label="Start page" htmlFor="new-start-page" hint="The page they see after signing in (if they are allowed to open it).">
            <select id="new-start-page" className={inputClass} value={newStartPage} onChange={(e) => setNewStartPage(e.target.value)}>
              <option value="">Automatic (first page they may open)</option>
              {startPageChoices(() => true).map((p) => (
                <option key={p.to} value={p.to}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
        <p className="mt-2 text-xs text-slate-500">
          Add User creates their login and emails them a 6-digit code. They open https://order.minimills.net and enter their email and
          the code. No password is needed.
        </p>
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
        {shownUsers.length === 0 && !loading && <p className="p-4 text-sm text-slate-500">No users in this department.</p>}
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
            {isAdmin && u.role === 'staff' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  {Object.keys(permsByUser[u.email] ?? {}).length} allowed
                </span>
                <button type="button" className={secondaryButtonClass} onClick={() => setEditingPerms(u)}>
                  Permissions
                </button>
              </div>
            )}
            {u.role === 'admin' && <span className="text-xs text-slate-500">Full access</span>}
            <label className="flex items-center gap-1 text-xs text-slate-600">
              Start page
              <select
                aria-label={`Start page for ${u.email}`}
                className={selectClass}
                value={startPages[u.email] ?? ''}
                onChange={(e) => changeStartPage(u, e.target.value || null)}
              >
                <option value="">Automatic</option>
                {startPageChoices(
                  (p) =>
                    u.role === 'admin' ||
                    !isAdmin || // people managing users without seeing permissions get the full list
                    ((!p.permission || allowedBy(permsByUser[u.email] ?? {}, p.permission, p.level)) &&
                      (!p.anyOf || p.anyOf.some((k) => allowedBy(permsByUser[u.email] ?? {}, k, p.level)))),
                ).map((p) => (
                  <option key={p.to} value={p.to}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {isAdmin ? (
              <select
                aria-label={`Role for ${u.email}`}
                className={selectClass}
                value={u.role}
                onChange={(e) => changeRole(u, e.target.value as Role)}
              >
                <option value="staff">User</option>
                <option value="admin">Admin</option>
              </select>
            ) : (
              <span className="text-xs text-slate-600">{u.role === 'admin' ? 'Admin' : 'User'}</span>
            )}
            <button type="button" className="text-sm text-blue-700 underline disabled:opacity-50" disabled={busyEmail === u.email} onClick={() => resend(u)}>
              {busyEmail === u.email ? 'Sending…' : 'Resend Login Code'}
            </button>
            <button type="button" className="text-sm text-red-700 underline" onClick={() => setRemoving(u)}>
              Revoke Access
            </button>
          </div>
        ))}
      </div>

      {editingPerms && (
        <PermissionEditor
          email={editingPerms.email}
          name={editingPerms.name}
          initial={permsByUser[editingPerms.email] ?? {}}
          departments={departments}
          memberOf={memberships[editingPerms.email] ?? []}
          templates={templates}
          otherUsers={users
            .filter((u) => u.role === 'staff' && u.email !== editingPerms.email)
            .map((u): OtherUser => ({ email: u.email, name: u.name, perms: permsByUser[u.email] ?? {} }))}
          reviewed={reviewed}
          onReviewed={markReviewed}
          onTemplatesChanged={() => {
            load()
            reloadDepartments()
          }}
          onClose={() => setEditingPerms(null)}
          onSaved={() => {
            setEditingPerms(null)
            load()
          }}
        />
      )}

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
                Save Changes
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
          <p className="mt-3 text-xs text-slate-500">A user can belong to more than one department.</p>
        </Modal>
      )}

      {removing && (
        <Modal
          title="Revoke Access?"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60"
                disabled={busyEmail === removing.email}
                onClick={() => remove(removing)}
              >
                {busyEmail === removing.email ? 'Revoking…' : 'Revoke Access'}
              </button>
            </>
          }
        >
          <p className="text-sm">
            <strong>{removing.email}</strong> will no longer be able to sign in, see or change anything (their login is
            blocked and they leave the users list).
            {removing.email === me && ' This is your own account: you will lose access immediately.'} Their past changes stay in
            the activity log.
          </p>
        </Modal>
      )}
    </div>
  )
}
