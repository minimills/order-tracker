// @permission-scope boards.card.link
import { useEffect, useState } from 'react'
import type { Card } from '../../lib/boards'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import SerialNumber from '../SerialNumber'
import { inputClass, narrowInputClass } from '../form'
import Icon from '../Icon'

type Kind = 'order' | 'customer' | 'machine' | 'text'
type Hit = { id: string; text: string; serial?: string | null }
type Patch = Pick<Card, 'order_id' | 'customer_id' | 'machine_id' | 'link_text'>

/** Shows a card's link (order, customer, machine) and lets people change it. */
export default function LinkPicker({ card, editable, busy, onSave }: { card: Card; editable: boolean; busy: boolean; onSave: (p: Patch) => void }) {
  const [current, setCurrent] = useState<{ order?: string; customer?: string; machine?: string | null; machineType?: string }>({})
  const [kind, setKind] = useState<Kind>('order')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [freeText, setFreeText] = useState('')

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

  // The list shows straight away (latest first) and narrows as people type.
  useEffect(() => {
    if (!supabase || kind === 'text') return
    const term = q.trim().replace(/[%_,()]/g, '')
    const like = `%${term}%`
    const t = setTimeout(async () => {
      if (kind === 'order') {
        let qy = supabase!.from('order_summary').select('id, order_code, customer_name, customer_company').eq('archived', false)
        if (term) qy = qy.or(`order_code.ilike.${like},customer_name.ilike.${like},customer_company.ilike.${like}`)
        const { data } = await qy.order('order_number', { ascending: false }).limit(25)
        setHits(
          ((data ?? []) as { id: string; order_code: string; customer_name: string; customer_company: string | null }[]).map((r) => ({
            id: r.id,
            text: `Order ${r.order_code} · ${r.customer_company || r.customer_name}`,
          })),
        )
      } else if (kind === 'customer') {
        let qy = supabase!.from('customer_list').select('id, name, company').eq('archived', false)
        if (term) qy = qy.or(`name.ilike.${like},company.ilike.${like}`)
        const { data } = await qy.order('company', { nullsFirst: false }).order('name').limit(25)
        setHits(((data ?? []) as { id: string; name: string; company: string | null }[]).map((r) => ({ id: r.id, text: r.company ? `${r.company} · ${r.name}` : r.name })))
      } else {
        let qy = supabase!.from('order_machine_status').select('id, serial_number, machine_type')
        if (term) qy = qy.or(`serial_number.ilike.${like},machine_type.ilike.${like}`)
        const { data } = await qy.order('created_at', { ascending: false }).limit(25)
        setHits(((data ?? []) as { id: string; serial_number: string | null; machine_type: string }[]).map((r) => ({ id: r.id, text: r.machine_type, serial: r.serial_number })))
      }
    }, term ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, kind])

  const none = !card.order_id && !card.customer_id && !card.machine_id && !card.link_text
  const keep: Patch = { order_id: card.order_id, customer_id: card.customer_id, machine_id: card.machine_id, link_text: card.link_text ?? null }
  const clear = (k: Kind) => onSave({ ...keep, [k === 'text' ? 'link_text' : `${k}_id`]: null })
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
        {card.link_text && row('text', <><Icon name="pencil" /> {card.link_text}</>)}
        {none && <li className="text-xs text-slate-500">Not linked.</li>}
      </ul>
      {editable && (
        <Can permission="boards.card.link" level="edit">
          <div className="space-y-1">
            <div className="flex gap-1">
              <select
                aria-label="Link to"
                className={`${narrowInputClass} w-28 py-1`}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as Kind)
                  setQ('')
                  setHits(null)
                }}
              >
                <option value="order">Order</option>
                <option value="customer">Customer</option>
                <option value="machine">Machine</option>
                <option value="text">Free text</option>
              </select>
              {kind === 'text' ? (
                <input
                  aria-label="Link text"
                  className={`${inputClass} py-1`}
                  placeholder="For example: old carder at the fair"
                  maxLength={200}
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && freeText.trim()) {
                      onSave({ ...keep, link_text: freeText.trim() })
                      setFreeText('')
                    }
                  }}
                />
              ) : (
                <input
                  aria-label="Search the list"
                  className={`${inputClass} py-1`}
                  placeholder={kind === 'order' ? 'Search order # or customer' : kind === 'customer' ? 'Search name or company' : 'Search serial or machine'}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              )}
            </div>
            {kind === 'text' ? (
              <button
                type="button"
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-50"
                disabled={busy || !freeText.trim()}
                onClick={() => {
                  onSave({ ...keep, link_text: freeText.trim() })
                  setFreeText('')
                }}
              >
                Save Changes
              </button>
            ) : (
              <ul className="max-h-48 overflow-y-auto rounded border border-slate-200 text-sm">
                {hits === null && <li className="px-2 py-1 text-xs text-slate-500">Loading…</li>}
                {hits?.length === 0 && <li className="px-2 py-1 text-xs text-slate-500">No matches found. Choose “Free text” to type a link.</li>}
                {hits?.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1 text-left hover:bg-slate-50"
                      disabled={busy}
                      onClick={() => {
                        onSave({ ...keep, [`${kind}_id`]: h.id })
                        setQ('')
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
