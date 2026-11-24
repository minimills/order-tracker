import { useState } from 'react'
import { useTargets } from '../../lib/useTargets'
import { narrowInputClass } from '../form'
import { tr } from '../../i18n'

export type Target = { type: 'user' | 'group' | 'department' | 'everyone' | 'assignees'; target: string | null }

/** Pick a person, a group, a department, everyone (or "the people on the card"). */
/* @layout-helper */
export default function TargetPicker({ value, onChange, withAssignees = false }: { value: Target; onChange: (t: Target) => void; withAssignees?: boolean }) {
  const { people, groups, departments } = useTargets()
  const [filter, setFilter] = useState('')
  const list =
    value.type === 'user'
      ? people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(filter.toLowerCase())).map((p) => ({ id: p.email, name: `${p.name} (${p.email})` }))
      : value.type === 'group'
        ? groups.map((g) => ({ id: g.id, name: g.name }))
        : value.type === 'department'
          ? departments.map((d) => ({ id: d.id, name: d.name }))
          : []
  return (
    <div className="flex flex-wrap gap-2">
      <select
        aria-label={tr("Who")}
        className={`${narrowInputClass} w-40`}
        value={value.type}
        onChange={(e) => onChange({ type: e.target.value as Target['type'], target: null })}
      >
        <option value="user">{tr("A person")}</option>
        <option value="group">{tr("A group")}</option>
        <option value="department">{tr("A department")}</option>
        <option value="everyone">{tr("Everyone")}</option>
        {withAssignees && <option value="assignees">{tr("The people on the card")}</option>}
      </select>
      {value.type === 'user' && people.length > 12 && (
        <input aria-label={tr("Find a person")} className={`${narrowInputClass} w-36`} placeholder={tr("Search…")} value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      {['user', 'group', 'department'].includes(value.type) && (
        <select aria-label={tr("Which")} className={`${narrowInputClass} min-w-48 flex-1`} value={value.target ?? ''} onChange={(e) => onChange({ ...value, target: e.target.value || null })}>
          <option value="">{tr("Select…")}</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
