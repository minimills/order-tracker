import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { OptionItem, OptionListName } from './types'

/**
 * Loads one dropdown list from option_lists, in display order.
 * Archived values are left out unless `keepValue` is one of them
 * (so a record still shows the value it already has).
 */
export function useOptionList(listName: OptionListName, keepValue?: string | null) {
  const [items, setItems] = useState<OptionItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    supabase
      .from('option_lists')
      .select('id, list_name, value, sort_order, locked, archived')
      .eq('list_name', listName)
      .order('sort_order')
      .order('value')
      .then(({ data }) => {
        if (cancelled) return
        setItems((data as OptionItem[]) ?? [])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [listName])

  const visible = items.filter((o) => !o.archived || o.value === keepValue)
  return { options: visible.map((o) => o.value), loading }
}
