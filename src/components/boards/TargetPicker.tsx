import { useState } from 'react'
import { useTargets } from '../../lib/useTargets'
import { narrowInputClass } from '../form'

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
        aria-label="Who"
        className={`${narrowInputClass} w-40`}
        value={value.type}
        onChange={(e) => onChange({ type: e.target.value as Target['type'], target: null })}
      >
        <option value="user">A person</option>
        <option value="group">A group</option>
        <option value="department">A department</option>
        <option value="everyone">Everyone</option>
        {withAssignees && <option value="assignees">The people on the card</option>}
      </select>
      {value.type === 'user' && people.length > 12 && (
        <input aria-label="Find a person" className={`${narrowInputClass} w-36`} placeholder="Find…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      {['user', 'group', 'department'].includes(value.type) && (
        <select aria-label="Which" className={`${narrowInputClass} min-w-48 flex-1`} value={value.target ?? ''} onChange={(e) => onChange({ ...value, target: e.target.value || null })}>
          <option value="">Choose…</option>
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
