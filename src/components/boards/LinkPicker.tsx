// @permission-scope boards.card.link
import { useEffect, useState } from 'react'
import type { Card } from '../../lib/boards'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import SerialNumber from '../SerialNumber'
import { inputClass, narrowInputClass } from '../form'
import Icon from '../Icon'

type Kind = 'order' | 'customer' | 'machine'
type Hit = { id: string; text: string; serial?: string | null }
type Patch = Pick<Card, 'order_id' | 'customer_id' | 'machine_id'>

/** Shows a card's link (order, customer, machine) and lets people change it. */
export default function LinkPicker({ card, editable, busy, onSave }: { card: Card; editable: boolean; busy: boolean; onSave: (p: Patch) => void }) {
  const [current, setCurrent] = useState<{ order?: string; customer?: string; machine?: string | null; machineType?: string }>({})
  const [kind, setKind] = useState<Kind>('order')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])

  useEffect(() => {
    if (!supabase) return
    let stop = false
    Promise.all([
      card.order_id ? supabase.from('order_summary').select('order_code').eq('id', card.order_id).maybeSingle() : Promise.resolve({ data: null }),
      card.customer_id ? supabase.from('customer_list').select('name').eq('id', card.customer_id).maybeSingle() : Promise.resolve({ data: null }),
      card.machine_id ? supabase.from('order_machine_status').select('serial_number, machine_type').eq('id', card.machine_id).maybeSingle() : Promise.resolve({ data: null }),
    ]).then(([o, c, m]) => {
      if (stop) return
      const mm = m.data as { serial_number: string | null; machine_type: string } | null
      setCurrent({
        order: (o.data as { order_code: string } | null)?.order_code,
        customer: (c.data as { name: string } | null)?.name,
        machine: mm?.serial_number,
        machineType: mm?.machine_type,
      })
    })
    return () => {
      stop = true
    }
  }, [card.order_id, card.customer_id, card.machine_id])

  useEffect(() => {
    const term = q.trim()
    if (!supabase || term.length < 1) return
    const t = setTimeout(async () => {
      const like = `%${term.replace(/[%_]/g, '')}%`
      if (kind === 'order') {
        const { data } = await supabase!.from('order_summary').select('id, order_code, customer_name').ilike('order_code', like).eq('archived', false).limit(8)
        setHits(((data ?? []) as { id: string; order_code: string; customer_name: string }[]).map((r) => ({ id: r.id, text: `Order ${r.order_code} · ${r.customer_name}` })))
      } else if (kind === 'customer') {
        const { data } = await supabase!.from('customer_list').select('id, name, company').or(`name.ilike.${like},company.ilike.${like}`).eq('archived', false).limit(8)
        setHits(((data ?? []) as { id: string; name: string; company: string | null }[]).map((r) => ({ id: r.id, text: r.company ? `${r.name} · ${r.company}` : r.name })))
      } else {
        const { data } = await supabase!.from('order_machine_status').select('id, serial_number, machine_type').ilike('serial_number', like).limit(8)
        setHits(((data ?? []) as { id: string; serial_number: string | null; machine_type: string }[]).map((r) => ({ id: r.id, text: r.machine_type, serial: r.serial_number })))
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q, kind])

  const none = !card.order_id && !card.customer_id && !card.machine_id
  const clear = (k: Kind) => onSave({ order_id: k === 'order' ? null : card.order_id, customer_id: k === 'customer' ? null : card.customer_id, machine_id: k === 'machine' ? null : card.machine_id })
  const row = (k: Kind, label: React.ReactNode) => (
    <li className="flex items-center gap-2 text-sm">
      <span className="flex-1">{label}</span>
      {editable && (
        <Can permission="boards.card.link" level="edit">
          <button type="button" aria-label="Remove link" className="text-xs text-slate-400 hover:text-red-700" disabled={busy} onClick={() => clear(k)}>
            ✕
          </button>
        </Can>
      )}
    </li>
  )

  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {card.order_id && row('order', <><Icon name="box" /> Order {current.order ?? '…'}</>)}
        {card.customer_id && row('customer', <><Icon name="user" /> {current.customer ?? '…'}</>)}
        {card.machine_id &&
          row(
            'machine',
            <>
              <Icon name="cog" /> {current.machineType ?? 'Machine'} {current.machine && <SerialNumber serial={current.machine} />}
            </>,
          )}
        {none && <li className="text-xs text-slate-500">Not linked.</li>}
      </ul>
      {editable && (
        <Can permission="boards.card.link" level="edit">
          <div className="space-y-1">
            <div className="flex gap-1">
              <select aria-label="Link to" className={`${narrowInputClass} w-28 py-1`} value={kind} onChange={(e) => { setKind(e.target.value as Kind); setHits([]) }}>
                <option value="order">Order</option>
                <option value="customer">Customer</option>
                <option value="machine">Machine</option>
              </select>
              <input
                aria-label="Find to link"
                className={`${inputClass} py-1`}
                placeholder={kind === 'order' ? 'Order #' : kind === 'customer' ? 'Name' : 'Serial'}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  if (!e.target.value.trim()) setHits([])
                }}
              />
            </div>
            {q.trim() && (
              <ul className="max-h-40 overflow-y-auto rounded border border-slate-200 text-sm">
                {hits.length === 0 && <li className="px-2 py-1 text-xs text-slate-500">No matches found.</li>}
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1 text-left hover:bg-slate-50"
                      disabled={busy}
                      onClick={() => {
                        onSave({ ...{ order_id: card.order_id, customer_id: card.customer_id, machine_id: card.machine_id }, [`${kind}_id`]: h.id })
                        setQ('')
                        setHits([])
                      }}
                    >
                      {h.text} {h.serial && <span className="font-mono text-xs">{h.serial}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Can>
      )}
    </div>
  )
}
