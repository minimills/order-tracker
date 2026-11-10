// @permission-scope service.calendar
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import Icon from '../Icon'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { PHONE_EVENT_KINDS, showTime, type CalendarKind, type CalendarRow } from '../../lib/service'
import { supabase } from '../../lib/supabase'

type Stored = { id: string; kind: CalendarKind; kind_set_by: string | null; customer_id: string | null; order_id: string | null }

/** An entry read from a technician's phone calendar: read-only, except the office's type and links. */
export default function PhoneEventDialog({ entry, onClose, onSaved }: { entry: CalendarRow; onClose: () => void; onSaved: () => void }) {
  const [stored, setStored] = useState<Stored | null>(null)
  const [kind, setKind] = useState<CalendarKind>(entry.kind)
  const [customerText, setCustomerText] = useState('')
  const [orderText, setOrderText] = useState('')
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('tech_phone_events')
      .select('id, kind, kind_set_by, customer_id, order_id')
      .eq('id', entry.source_id)
      .maybeSingle()
      .then(async ({ data }) => {
        const s = data as Stored | null
        setStored(s)
        if (!s) return
        setKind(s.kind)
        if (s.order_id) {
          const { data: o } = await supabase!.from('orders').select('order_code').eq('id', s.order_id).maybeSingle()
          setOrderText((o?.order_code as string | undefined) ?? '')
        }
      })
    supabase
      .from('customer_list')
      .select('id, name')
      .eq('archived', false)
      .order('name')
      .limit(1000)
      .then(({ data }) => setCustomers((data as { id: string; name: string }[] | null) ?? []))
  }, [entry.source_id])

  useEffect(() => {
    if (stored?.customer_id && customers.length && !customerText) {
      // oxlint-disable-next-line react/set-state-in-effect
      setCustomerText(customers.find((c) => c.id === stored.customer_id)?.name ?? '')
    }
  }, [stored, customers, customerText])

  async function save() {
    if (!supabase || !stored) return
    let orderId: string | null = null
    if (orderText.trim()) {
      const { data } = await supabase.from('orders').select('id').eq('order_code', orderText.trim()).is('cancelled_code', null).maybeSingle()
      if (!data) return toast.error(`Order ${orderText.trim()} was not found. Check the order number.`)
      orderId = data.id as string
    }
    const customer = customers.find((c) => c.name.toLowerCase() === customerText.trim().toLowerCase())
    if (customerText.trim() && !customer && !orderId) return toast.error('Pick the customer from the list, or leave it empty.')
    setSaving(true)
    const { error } = await supabase.rpc('classify_phone_event', { p_id: stored.id, p_kind: kind, p_customer: customer?.id ?? null, p_order: orderId })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Entry updated.')
    onSaved()
  }

  const dates = entry.start_date === entry.end_date ? showDate(entry.start_date) : `${showDate(entry.start_date)} – ${showDate(entry.end_date)}`
  return (
    <Modal
      title={entry.title}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <Can permission="service.calendar.classify" level="edit">
            <button type="button" className={buttonClass} onClick={save} disabled={saving || !stored}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </Can>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="flex items-center gap-2 rounded-md bg-slate-100 p-2 text-slate-700">
          <Icon name="phone" />
          From {entry.tech_name ?? 'the technician'}’s phone calendar. Edit this on your phone; changes appear here within 15 minutes.
        </p>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
          <dt className="text-slate-500">When</dt>
          <dd>
            {dates}
            {entry.start_at ? `, ${showTime(entry.start_at)}` : ', all day'}
          </dd>
          {entry.location && (
            <>
              <dt className="text-slate-500">Where</dt>
              <dd className="whitespace-pre-line">{entry.location}</dd>
            </>
          )}
          {entry.notes && (
            <>
              <dt className="text-slate-500">Notes</dt>
              <dd className="whitespace-pre-line">{entry.notes}</dd>
            </>
          )}
          {entry.customer && (
            <>
              <dt className="text-slate-500">Customer</dt>
              <dd>{entry.customer}</dd>
            </>
          )}
          {entry.link && (
            <>
              <dt className="text-slate-500">Order</dt>
              <dd>
                <Link to={entry.link} className="text-blue-700 underline">
                  Open the service log
                </Link>
              </dd>
            </>
          )}
        </dl>
        <Can permission="service.calendar.classify" level="edit">
          <div className="space-y-3 border-t border-slate-200 pt-3">
            <p className="text-slate-600">
              The office can set the type and link a customer or order{stored?.kind_set_by ? '' : ' (the type is a guess from the title until someone sets it)'}.
            </p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type">
              {PHONE_EVENT_KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.kind}
                  className={`rounded-md border px-3 py-1.5 ${kind === k.kind ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                  onClick={() => setKind(k.kind)}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <Field label="Order number" htmlFor="pe-order" hint="Links the order and its customer.">
              <input id="pe-order" className={inputClass} placeholder="For example 76" value={orderText} onChange={(e) => setOrderText(e.target.value)} />
            </Field>
            <Field label="Customer" htmlFor="pe-customer" hint="Only when there is no order.">
              <input id="pe-customer" list="pe-customers" className={inputClass} value={customerText} onChange={(e) => setCustomerText(e.target.value)} />
              <datalist id="pe-customers">
                {customers.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </Field>
          </div>
        </Can>
      </div>
    </Modal>
  )
}
