import { useEffect, useState } from 'react'
import { friendlyError } from '../../lib/format'
import { activityTime, activityWho, describeActivity, type ActivityEntry } from '../../lib/activity'
import { supabase } from '../../lib/supabase'

/** Everything that happened to one order, newest first. */
export default function ActivityList({ orderId, reloadKey }: { orderId: string; reloadKey: number }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [typeNames, setTypeNames] = useState(new Map<string, string>())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    Promise.all([
      supabase
        .from('activity_log')
        .select('id, at, user_email, user_departments, table_name, record_id, action, changes')
        .eq('order_id', orderId)
        .order('at', { ascending: false })
        .order('id', { ascending: false })
        .limit(500),
      supabase.from('machine_types').select('id, name'),
    ]).then(([log, types]) => {
      if (cancelled) return
      if (log.error) setError(friendlyError(log.error))
      setEntries((log.data as ActivityEntry[]) ?? [])
      setTypeNames(new Map(((types.data as { id: string; name: string }[]) ?? []).map((t) => [t.id, t.name])))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [orderId, reloadKey])

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>
  if (error) return <p className="text-sm text-red-700">{error}</p>
  if (entries.length === 0) return <p className="text-sm text-slate-500">Nothing recorded yet.</p>

  return (
    <ol className="space-y-3">
      {entries.map((e) => {
        const d = describeActivity(e, typeNames)
        if (d.lines.length === 0 && e.action === 'update') return null
        return (
          <li key={e.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{d.title}</span>
              <span className="text-xs text-slate-500">
                {activityTime.format(new Date(e.at))} · {activityWho(e)}
              </span>
            </div>
            {d.lines.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-slate-700">
                {d.lines.map((l, i) => (
                  <li key={i} className="break-words">
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}
