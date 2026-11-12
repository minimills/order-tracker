// @permission-scope order.ship_history
import { useEffect, useState } from 'react'
import { showDate } from '../../lib/dates'
import { supabase } from '../../lib/supabase'

type Change = { id: string; old_date: string | null; new_date: string | null; changed_by_name: string | null; changed_at: string; reason: string | null }
const when = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "Changed 2 times" badge with the original promised date and the list of every change. */
export default function ShipDateHistory({ orderId, revisions, original }: { orderId: string; revisions: number; original: string | null }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Change[] | null>(null)
  useEffect(() => {
    if (!open || rows || !supabase) return
    supabase
      .from('ship_date_changes')
      .select('id, old_date, new_date, changed_by_name, changed_at, reason')
      .eq('order_id', orderId)
      .order('changed_at')
      .then(({ data }) => setRows((data as Change[]) ?? []))
  }, [open, rows, orderId])
  if (!revisions) return null
  return (
    <div className="mt-1 text-xs">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900 ring-1 ring-amber-300">
        Changed {revisions} {revisions === 1 ? 'time' : 'times'} {open ? '▾' : '▸'}
      </button>
      <div className="mt-1 text-slate-600">Original promised date: {showDate(original)}</div>
      {open && (
        <ol className="mt-2 space-y-1.5 border-l-2 border-slate-200 pl-3">
          {rows === null && <li className="text-slate-500">Loading…</li>}
          {rows?.map((r) => (
            <li key={r.id}>
              <span className="font-medium">
                {showDate(r.old_date)} → {showDate(r.new_date)}
              </span>
              <span className="block text-slate-500">
                {r.changed_by_name ?? 'Automatic'} · {when.format(new Date(r.changed_at))}
              </span>
              {r.reason && <span className="block text-slate-700">Reason: {r.reason}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
