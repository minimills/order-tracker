import type { PostgrestFilterBuilder } from '@supabase/postgrest-js'

const PAGE = 1000

/**
 * Supabase returns at most 1000 rows per request. This keeps asking for the
 * next 1000 until everything is loaded.
 */
export async function fetchAll<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeQuery: () => PostgrestFilterBuilder<any, any, any, any, any, any, any>,
): Promise<{ data: T[]; error: { message: string; code?: string } | null }> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) return { data: all, error }
    all.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) return { data: all, error: null }
  }
}
