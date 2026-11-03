import { useEffect, useState } from 'react'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Entry = {
  id: number
  at: string
  user_email: string | null
  table_name: string
  record_id: string | null
  action: 'insert' | 'update' | 'delete' | 'move'
  changes: Record<string, unknown>
}

type Change = { old: unknown; new: unknown }

const LABELS: Record<string, string> = {
  stage: 'Stage',
  board_position: 'Board number',
  expected_ship_date: 'Expected ship date',
  actual_ship_date: 'Actual ship date',
  voltage: 'Voltage',
  delivery_equipment: 'Delivery equipment',
  freight_type: 'Freight type',
  notes: 'Notes',
  order_total: 'Order total',
  currency: 'Currency',
  order_number: 'Order number',
  split_number: 'Split number',
  order_code: 'Order #',
  customer_id: 'Customer',
  archived: 'Archived',
  serial_number: 'Serial',
  ready: 'Built',
  serial_manual: 'Serial typed by hand',
  machine_type_id: 'Machine type',
  payment_type: 'Payment type',
  amount: 'Amount',
  due_date: 'Due date',
  received_date: 'Received date',
  received_amount: 'Received amount',
}

/** Fields that are filled in automatically and only add noise. */
const HIDDEN = new Set(['id', 'created_at', 'archived_at', 'archived_by', 'order_id', 'order_code'])

const when = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Halifax',
  dateStyle: 'medium',
  timeStyle: 'short',
})

function show(v: unknown, typeNames: Map<string, string>) {
  if (v === null || v === undefined || v === '') return '(empty)'
  if (v === true) return 'yes'
  if (v === false) return 'no'
  if (typeof v === 'string' && typeNames.has(v)) return typeNames.get(v)!
  return String(v)
}

function describe(e: Entry, typeNames: Map<string, string>): { title: string; lines: string[] } {
  const c = e.changes
  if (e.action === 'move') {
    const lines: string[] = []
    const stage = c.stage as Change | undefined
    const pos = c.board_position as Change | undefined
    const ship = c.actual_ship_date as Change | undefined
    if (stage && stage.old !== stage.new) lines.push(`Stage: ${stage.old} → ${stage.new}`)
    if (pos && pos.old !== pos.new) lines.push(`Board number: ${pos.old ?? 'none'} → ${pos.new ?? 'none'}`)
    if (ship && ship.old !== ship.new) lines.push(`Actual ship date: ${show(ship.old, typeNames)} → ${show(ship.new, typeNames)}`)
    for (const s of (c.serial_changes as { order: string; old: string | null; new: string | null }[]) ?? []) {
      lines.push(`Serial (order ${s.order}): ${s.old ?? 'none'} → ${s.new ?? 'none'}`)
    }
    return { title: 'Moved on the board', lines }
  }

  const thing =
    e.table_name === 'orders' ? 'order' : e.table_name === 'order_machines' ? 'machine' : e.table_name === 'payments' ? 'payment' : e.table_name

  if (e.action === 'insert' || e.action === 'delete') {
    const verb = e.action === 'insert' ? 'Added' : 'Deleted'
    if (e.table_name === 'orders') return { title: e.action === 'insert' ? 'Order created' : 'Order deleted', lines: [] }
    if (e.table_name === 'order_machines')
      return {
        title: `${verb} machine: ${show(c.machine_type_id, typeNames)}`,
        lines: c.serial_number ? [`Serial ${c.serial_number}`] : [],
      }
    if (e.table_name === 'payments')
      return { title: `${verb} payment: ${c.payment_type} ${c.amount ?? ''}`, lines: c.due_date ? [`Due ${c.due_date}`] : [] }
    return { title: `${verb} ${thing}`, lines: [] }
  }

  const lines = Object.entries(c)
    .filter(([k]) => !HIDDEN.has(k))
    .map(([k, v]) => {
      const ch = v as Change
      if (k === 'ready') return ch.new ? 'Marked built' : 'Marked not built'
      if (k === 'archived') return ch.new ? 'Archived' : 'Brought back from archive'
      return `${LABELS[k] ?? k}: ${show(ch.old, typeNames)} → ${show(ch.new, typeNames)}`
    })
  return { title: `Changed ${thing}`, lines }
}

/** Everything that happened to one order, newest first. */
export default function ActivityList({ orderId, reloadKey }: { orderId: string; reloadKey: number }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [typeNames, setTypeNames] = useState(new Map<string, string>())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    Promise.all([
      supabase
        .from('activity_log')
        .select('id, at, user_email, table_name, record_id, action, changes')
        .eq('order_id', orderId)
        .order('at', { ascending: false })
        .order('id', { ascending: false })
        .limit(500),
      supabase.from('machine_types').select('id, name'),
    ]).then(([log, types]) => {
      if (cancelled) return
      if (log.error) setError(friendlyError(log.error))
      setEntries((log.data as Entry[]) ?? [])
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
        const d = describe(e, typeNames)
        if (d.lines.length === 0 && e.action === 'update') return null
        return (
          <li key={e.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{d.title}</span>
              <span className="text-xs text-slate-500">
                {when.format(new Date(e.at))} · {e.user_email ?? 'automatic / database'}
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
