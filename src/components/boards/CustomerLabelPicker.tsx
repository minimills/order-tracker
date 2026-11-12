// @permission-scope boards.card.customer_label
import { useEffect, useState } from 'react'
import { customerLabelText, type Card } from '../../lib/boards'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import Icon from '../Icon'
import { inputClass } from '../form'

type Customer = { id: string; name: string; company: string | null; state_province: string | null; country: string | null }

/**
 * The customer label on a card: "Company (or the person's name) – State, Country".
 * Pick a customer from the list (it fills in the text) or type any text.
 */
export default function CustomerLabelPicker({ card, editable, busy, onSave }: { card: Card; editable: boolean; busy: boolean; onSave: (text: string | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(card.customer_label ?? '')
  const [customers, setCustomers] = useState<Customer[]>([])

  // The customer list is loaded once, when someone starts changing the label.
  useEffect(() => {
    if (!editing || !supabase || customers.length) return
    supabase
      .from('customer_list')
      .select('id, name, company, state_province, country')
      .eq('archived', false)
      .order('company', { nullsFirst: false })
      .order('name')
      .limit(1000)
      .then(({ data }) => setCustomers((data as Customer[]) ?? []))
  }, [editing, customers.length])

  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = customers
    .filter((c) => {
      const hay = `${c.company ?? ''} ${c.name} ${c.state_province ?? ''} ${c.country ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .slice(0, 8)

  if (!editing)
    return (
      <div className="space-y-1.5">
        {card.customer_label ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900">
            <Icon name="user" className="h-3 w-3 shrink-0" />
            <span className="break-words">{card.customer_label}</span>
          </span>
        ) : (
          <p className="text-xs text-slate-500">No customer label.</p>
        )}
        {editable && (
          <Can permission="boards.card.customer_label" level="edit">
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                className="text-slate-600 underline"
                onClick={() => {
                  setText(card.customer_label ?? '')
                  setEditing(true)
                }}
              >
                {card.customer_label ? 'Change' : 'Add Customer Label'}
              </button>
              {card.customer_label && (
                <button type="button" className="text-red-700 underline" disabled={busy} onClick={() => onSave(null)}>
                  Remove
                </button>
              )}
            </div>
          </Can>
        )}
      </div>
    )

  return (
    <Can permission="boards.card.customer_label" level="edit">
      <div className="space-y-1.5">
        <input
          aria-label="Customer label"
          className={`${inputClass} py-1`}
          placeholder="Search customers or type a label"
          value={text}
          autoFocus
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Enter' && text.trim()) {
              onSave(text.trim())
              setEditing(false)
            }
          }}
        />
        <ul className="max-h-44 overflow-y-auto rounded border border-slate-200 text-sm">
          {customers.length === 0 && <li className="px-2 py-1 text-xs text-slate-500">Loading customers…</li>}
          {customers.length > 0 && matches.length === 0 && <li className="px-2 py-1 text-xs text-slate-500">No matching customer. Save the text as typed.</li>}
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full px-2 py-1 text-left hover:bg-slate-50"
                onClick={() => {
                  onSave(customerLabelText(c))
                  setEditing(false)
                }}
              >
                {customerLabelText(c)}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            disabled={busy || !text.trim()}
            onClick={() => {
              onSave(text.trim())
              setEditing(false)
            }}
          >
            Save Changes
          </button>
          <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Can>
  )
}
