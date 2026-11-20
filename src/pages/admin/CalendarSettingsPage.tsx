// @permission-scope admin.calendar
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, narrowInputClass, secondaryButtonClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'

type Target = { type: 'group' | 'department'; target: string }
type Choices = { groups: { id: string; name: string }[]; departments: { id: string; name: string }[] }

/** Admin → Calendar: the Service / Training team that service and training calendar entries are shared with by default. */
export default function CalendarSettingsPage() {
  const [team, setTeam] = useState<Target[] | null>(null)
  const [saved, setSaved] = useState('')
  const [choices, setChoices] = useState<Choices>({ groups: [], departments: [] })
  const [adding, setAdding] = useState<Target>({ type: 'group', target: '' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supabase) return
    supabase.rpc('calendar_settings').then(({ data, error }) => {
      if (error) return toast.error(friendlyError(error))
      const t = ((data as { service_team?: Target[] } | null)?.service_team ?? []).map((x) => ({ type: x.type, target: x.target }))
      setTeam(t)
      setSaved(JSON.stringify(t))
    })
    supabase.rpc('calendar_share_choices').then(({ data }) => data && setChoices(data as Choices))
  }, [])

  async function save() {
    if (!supabase || !team) return
    setBusy(true)
    const { error } = await supabase.rpc('set_calendar_settings', { p: { service_team: team } })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setSaved(JSON.stringify(team))
    toast.success('Calendar settings saved.')
  }

  if (!team) return <p className="text-sm text-slate-500">Loading…</p>
  const nameOf = (t: Target) =>
    t.type === 'group'
      ? `Group: ${choices.groups.find((g) => g.id === t.target)?.name ?? 'archived group'}`
      : `Department: ${choices.departments.find((d) => d.id === t.target)?.name ?? 'archived department'}`
  const list = adding.type === 'group' ? choices.groups : choices.departments

  return (
    <div className="space-y-4">
      <AdminPageHeader title="Calendar">
        Who service and training calendar entries are shared with when they are made. People can still change the sharing of each entry; private entries are never shown to
        anyone but their owner, admins included.
      </AdminPageHeader>
      <section className="max-w-3xl space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="calendar-team">
        <div>
          <h2 className="text-base font-semibold">Service / Training Team</h2>
          <p className="text-slate-600">
            Travel, on-site and training entries start shared with these groups and departments. Change the members of a group in{' '}
            <Link to="/admin/groups" className="underline">
              Admin → Groups
            </Link>
            .
          </p>
        </div>
        {team.length === 0 ? (
          <p className="text-slate-500">No team is chosen: new service and training entries start private.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {team.map((t) => (
              <li key={`${t.type}:${t.target}`} className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                {nameOf(t)}
                <button type="button" aria-label={`Remove ${nameOf(t)}`} className="text-slate-500 hover:text-red-700" onClick={() => setTeam(team.filter((x) => x !== t))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <select aria-label="Kind" className={`${narrowInputClass} w-36`} value={adding.type} onChange={(e) => setAdding({ type: e.target.value as Target['type'], target: '' })}>
            <option value="group">A group</option>
            <option value="department">A department</option>
          </select>
          <select aria-label="Which" className={`${narrowInputClass} min-w-48 flex-1`} value={adding.target} onChange={(e) => setAdding({ ...adding, target: e.target.value })}>
            <option value="">Select…</option>
            {list.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={!adding.target}
            onClick={() => {
              if (!team.some((x) => x.type === adding.type && x.target === adding.target)) setTeam([...team, adding])
              setAdding({ ...adding, target: '' })
            }}
          >
            {ACTION.add}
          </button>
        </div>
      </section>
      <button type="button" className={buttonClass} onClick={save} disabled={busy || JSON.stringify(team) === saved}>
        {busy ? ACTION.saving : ACTION.save}
      </button>
    </div>
  )
}
