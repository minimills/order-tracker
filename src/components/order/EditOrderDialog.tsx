// @permission-scope order.action.edit
import { useState } from 'react'
import { useAlerts } from '../../lib/alerts'
import { friendlyError } from '../../lib/format'
import { parseMoney } from '../../lib/money'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import { CURRENCIES, type Currency, type OrderSummaryRow } from '../../lib/types'
import { useOptionList } from '../../lib/useOptionList'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'

type Props = { order: OrderSummaryRow; onClose: () => void; onDone: () => void }

/**
 * Edit an order's dates, shipping details, currency and total.
 * Each field shows only for people allowed to change it; only those are saved.
 */
export default function EditOrderDialog({ order, onClose, onDone }: Props) {
  const { refresh: refreshAlerts } = useAlerts()
  const { can } = usePermissions()
  const may = {
    expected: can('order.field.expected_ship_date', 'edit'),
    actual: can('order.field.actual_ship_date', 'edit'),
    voltage: can('order.field.voltage', 'edit'),
    delivery: can('order.field.delivery_equipment', 'edit'),
    freight: can('order.field.freight_type', 'edit'),
    currency: can('order.field.currency', 'edit'),
    total: can('order.field.order_total', 'edit'),
  }
  const [expected, setExpected] = useState(order.expected_ship_date ?? '')
  const [actual, setActual] = useState(order.actual_ship_date ?? '')
  const [voltage, setVoltage] = useState(order.voltage)
  const [delivery, setDelivery] = useState(order.delivery_equipment)
  const [freight, setFreight] = useState(order.freight_type ?? '')
  const [currency, setCurrency] = useState<Currency>(order.currency)
  const [total, setTotal] = useState(order.order_total === null ? '' : String(order.order_total))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Keep the order's current value in the list even if it has since been archived.
  const voltageOptions = useOptionList('voltage', order.voltage)
  const deliveryOptions = useOptionList('delivery_equipment', order.delivery_equipment)
  const freightOptions = useOptionList('freight_type', order.freight_type)

  const nothingToEdit = !Object.values(may).some(Boolean)

  async function save() {
    if (!supabase) return
    const changes: Record<string, unknown> = {}
    if (may.expected) changes.expected_ship_date = expected || null
    if (may.actual) changes.actual_ship_date = actual || null
    if (may.voltage) changes.voltage = voltage
    if (may.delivery) changes.delivery_equipment = delivery
    if (may.freight) changes.freight_type = freight || null
    if (may.currency) changes.currency = currency
    if (may.total) {
      const totalNum = parseMoney(total)
      if (totalNum === null || Number.isNaN(totalNum)) return setError('Enter the order total as a number, e.g. 12500.')
      if (order.down_payment_amount !== null && totalNum < order.down_payment_amount)
        return setError('The total can’t be less than the down payment. Change the down payment first.')
      changes.order_total = totalNum
    }
    // Only send what really changed, so nobody trips over a field they can't edit.
    const current: Record<string, unknown> = {
      expected_ship_date: order.expected_ship_date,
      actual_ship_date: order.actual_ship_date,
      voltage: order.voltage,
      delivery_equipment: order.delivery_equipment,
      freight_type: order.freight_type,
      currency: order.currency,
      order_total: order.order_total,
    }
    for (const k of Object.keys(changes)) if (changes[k] === current[k]) delete changes[k]
    if (Object.keys(changes).length === 0) return onDone()

    setSaving(true)
    const { error: e } = await supabase.from('orders').update(changes).eq('id', order.id)
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
          <button type="button" className={buttonClass} onClick={save} disabled={saving || nothingToEdit}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      {nothingToEdit && <p className="text-sm text-slate-600">None of this order’s fields can be changed by you.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Can permission="order.field.expected_ship_date" level="edit">
          <Field label="Expected ship date" htmlFor="ed-expected">
            <input id="ed-expected" type="date" className={inputClass} value={expected} onChange={(e) => setExpected(e.target.value)} />
          </Field>
        </Can>
        <Can permission="order.field.actual_ship_date" level="edit">
          <Field
            label="Actual ship date"
            htmlFor="ed-actual"
            hint={order.stage !== 'Shipped' ? 'Filled in when the order is marked shipped.' : undefined}
          >
            <input id="ed-actual" type="date" className={inputClass} value={actual} onChange={(e) => setActual(e.target.value)} />
          </Field>
        </Can>
        <Can permission="order.field.voltage" level="edit">
          <Field label="Voltage" htmlFor="ed-voltage">
            <select id="ed-voltage" className={inputClass} value={voltage} onChange={(e) => setVoltage(e.target.value)}>
              {voltageOptions.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
        </Can>
        <Can permission="order.field.delivery_equipment" level="edit">
          <Field label="Delivery equipment" htmlFor="ed-delivery">
            <select id="ed-delivery" className={inputClass} value={delivery} onChange={(e) => setDelivery(e.target.value)}>
              {deliveryOptions.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
        </Can>
        <Can permission="order.field.freight_type" level="edit">
          <Field label="Freight type" htmlFor="ed-freight">
            <select id="ed-freight" className={inputClass} value={freight} onChange={(e) => setFreight(e.target.value)}>
              <option value="">Not decided yet</option>
              {freightOptions.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
        </Can>
        <Can permission="order.field.order_total" level="edit">
          <Field label="Order total" htmlFor="ed-total" hint="The balance updates itself.">
            <input id="ed-total" inputMode="decimal" className={inputClass} value={total} onChange={(e) => setTotal(e.target.value)} />
          </Field>
        </Can>
        <Can permission="order.field.currency" level="edit">
          <Field label="Currency" htmlFor="ed-currency">
            <select
              id="ed-currency"
              className={inputClass}
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
            >
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </Can>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}
