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

type User = { email: string; name: string | null; role: Role; created_at: string }

const selectClass = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm'

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

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error: e } = await supabase.from('allowed_users').select('email, name, role, created_at').order('email')
    if (e) toast.error(friendlyError(e))
    setUsers((data as User[]) ?? [])
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
    toast.success(`${address} can now sign in as ${role}.`)
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
        Only people on this list can use the app. They sign in with an emailed link, no password. <strong>Staff</strong>{' '}
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
        {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
        <p className="mt-2 text-xs text-slate-500">Then tell them to open the app and sign in with that email.</p>
      </form>

      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {loading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {users.map((u) => (
          <div key={u.email} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium break-all">
                {u.email}
                {u.email === me && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
              </div>
              <div className="text-xs text-slate-500">
                {u.name ? `${u.name} · ` : ''}added {showDate(u.created_at.slice(0, 10))}
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
