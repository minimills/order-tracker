import { useEffect, useState } from 'react'
import type { Group, Person } from './boards'
import { supabase } from './supabase'
import { useDepartments } from './useDepartments'

/** People, groups and departments to share with or notify, and their names. */
export function useTargets() {
  const [people, setPeople] = useState<Person[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const { departments } = useDepartments()
  useEffect(() => {
    if (!supabase) return
    supabase.rpc('people_choices').then(({ data }) => setPeople((data as Person[]) ?? []))
    supabase
      .from('user_groups')
      .select('id, name, description, archived')
      .order('name')
      .then(({ data }) => setGroups((data as Group[]) ?? []))
  }, [])
  const nameOf = (type: string, target: string | null) => {
    if (type === 'everyone') return 'Everyone'
    if (type === 'assignees') return 'The people on the card'
    if (type === 'user') return people.find((p) => p.email === target)?.name ?? target ?? ''
    if (type === 'group') return `Group: ${groups.find((g) => g.id === target)?.name ?? 'removed group'}`
    return `Department: ${departments.find((d) => d.id === target)?.name ?? 'removed department'}`
  }
  return { people, groups: groups.filter((g) => !g.archived), departments: departments.filter((d) => !d.archived), nameOf }
}
