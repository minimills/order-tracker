import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Department } from './types'

/** All departments in display order (archived ones too; filter with `.archived`). */
export function useDepartments() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase
      .from('departments')
      .select('id, name, sort_order, default_permissions, archived, manager_email, department_managers(user_email, added_at)')
      .order('sort_order')
      .order('name')
    type Row = Department & { department_managers?: { user_email: string; added_at: string }[] }
    setDepartments(
      ((data as Row[]) ?? []).map(({ department_managers, ...d }) => ({
        ...d,
        managers: [...(department_managers ?? [])].sort((a, b) => a.added_at.localeCompare(b.added_at)).map((m) => m.user_email),
      })),
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    // reload() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    reload()
  }, [reload])

  return { departments, loading, reload }
}
