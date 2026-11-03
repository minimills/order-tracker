import { useState } from 'react'
import { useAlerts } from '../../lib/alerts'
import { friendlyError } from '../../lib/format'
import { parseMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase'
import { CURRENCIES, type Currency, type OrderSummaryRow } from '../../lib/types'
import { useOptionList } from '../../lib/useOptionList'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'

type Props = { order: OrderSummaryRow; onClose: () => void; onDone: () => void }

/** Edit an order's dates, shipping details, currency and total. */
export default function EditOrderDialog({ order, onClose, onDone }: Props) {
  const { refresh: refreshAlerts } = useAlerts()
  const [expected, setExpected] = useState(order.expected_ship_date ?? '')
  const [actual, setActual] = useState(order.actual_ship_date ?? '')
  const [voltage, setVoltage] = useState(order.voltage)
  const [delivery, setDelivery] = useState(order.delivery_equipment)
  const [freight, setFreight] = useState(order.freight_type ?? '')
  const [currency, setCurrency] = useState<Currency>(order.currency)
  const [total, setTotal] = useState(String(order.order_total))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Keep the order's current value in the list even if it has since been archived.
  const voltageOptions = useOptionList('voltage', order.voltage)
  const deliveryOptions = useOptionList('delivery_equipment', order.delivery_equipment)
  const freightOptions = useOptionList('freight_type', order.freight_type)

  async function save() {
    if (!supabase) return
    const totalNum = parseMoney(total)
    if (totalNum === null || Number.isNaN(totalNum)) return setError('Enter the order total as a number, e.g. 12500.')
    if (order.down_payment_amount !== null && totalNum < order.down_payment_amount)
      return setError('The total can’t be less than the down payment. Change the down payment first.')
    setSaving(true)
    const { error: e } = await supabase
      .from('orders')
      .update({
        expected_ship_date: expected || null,
        actual_ship_date: actual || null,
        voltage,
        delivery_equipment: delivery,
        freight_type: freight || null,
        currency,
        order_total: totalNum,
      })
      .eq('id', order.id)
    setSaving(false)
    if (e) return setError(friendlyError(e))
    refreshAlerts()
    onDone()
  }

  return (
    <Modal
      title={`Edit order ${order.order_code}`}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Expected ship date" htmlFor="ed-expected">
          <input id="ed-expected" type="date" className={inputClass} value={expected} onChange={(e) => setExpected(e.target.value)} />
        </Field>
        <Field
          label="Actual ship date"
          htmlFor="ed-actual"
          hint={order.stage !== 'Shipped' ? 'Filled in when the order is marked shipped.' : undefined}
        >
          <input id="ed-actual" type="date" className={inputClass} value={actual} onChange={(e) => setActual(e.target.value)} />
        </Field>
        <Field label="Voltage" htmlFor="ed-voltage">
          <select id="ed-voltage" className={inputClass} value={voltage} onChange={(e) => setVoltage(e.target.value)}>
            {voltageOptions.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <Field label="Delivery equipment" htmlFor="ed-delivery">
          <select id="ed-delivery" className={inputClass} value={delivery} onChange={(e) => setDelivery(e.target.value)}>
            {deliveryOptions.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <Field label="Freight type" htmlFor="ed-freight">
          <select id="ed-freight" className={inputClass} value={freight} onChange={(e) => setFreight(e.target.value)}>
            <option value="">Not decided yet</option>
            {freightOptions.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <Field label="Order total" htmlFor="ed-total" hint="The balance updates itself.">
          <div className="flex gap-2">
            <input id="ed-total" inputMode="decimal" className={inputClass} value={total} onChange={(e) => setTotal(e.target.value)} />
            <select aria-label="Currency" className={`${inputClass} w-24`} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </Field>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}
