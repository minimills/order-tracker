// @permission-scope payments.action.add, payments.action.edit
import { useState } from 'react'
import { useAlerts } from '../../lib/alerts'
import { formatMoney, friendlyError } from '../../lib/format'
import { parseMoney, round2 } from '../../lib/money'
import { supabase } from '../../lib/supabase'
import type { OrderSummaryRow, PaymentRow } from '../../lib/types'
import { useOptionList } from '../../lib/useOptionList'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'

type Props = {
  order: OrderSummaryRow
  /** The payment to edit, or null to add a new one. */
  payment: PaymentRow | null
  /** Payment types this order already has (only one Down payment and one Balance allowed). */
  existingTypes: string[]
  onClose: () => void
  onDone: () => void
}

/** Add a payment, or change one's type, amount, due date or note. */
export default function PaymentDialog({ order, payment, existingTypes, onClose, onDone }: Props) {
  const { refresh: refreshAlerts } = useAlerts()
  // Without "order.field.order_total" the total is unknown here, so no % amounts.
  const total = order.order_total ?? 0
  const typeList = useOptionList('payment_type', payment?.payment_type)
  const [type, setType] = useState(payment?.payment_type ?? '')
  const [amountMode, setAmountMode] = useState<'amount' | 'percent'>('amount')
  const [amount, setAmount] = useState(payment ? String(payment.amount) : '')
  const [due, setDue] = useState(payment?.due_date ?? '')
  const [notes, setNotes] = useState(payment?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Only one Down payment and one Balance per order.
  const choices = typeList.options.filter(
    (t) => t === payment?.payment_type || !(['Down payment', 'Balance'].includes(t) && existingTypes.includes(t)),
  )
  const chosenType = type || choices.find((t) => t !== 'Balance') || choices[0] || ''
  const isBalance = chosenType === 'Balance'

  const num = parseMoney(amount)
  const amountValue =
    num === null || Number.isNaN(num) ? num : amountMode === 'percent' ? round2((total * num) / 100) : num

  async function save() {
    if (!supabase) return
    if (!chosenType) return setError('Choose a payment type.')
    if (!isBalance && (amountValue === null || Number.isNaN(amountValue)))
      return setError('Enter the amount, e.g. 2500.')
    setSaving(true)
    const row = {
      payment_type: chosenType,
      due_date: due || null,
      notes: notes.trim() || null,
      // The balance amount is always calculated by the database.
      ...(isBalance ? {} : { amount: amountValue }),
    }
    const { error: e } = payment
      ? await supabase.from('payments').update(row).eq('id', payment.id)
      : await supabase.from('payments').insert({ ...row, order_id: order.id })
    setSaving(false)
    if (e) return setError(friendlyError(e))
    refreshAlerts()
    onDone()
  }

  async function remove() {
    if (!supabase || !payment) return
    if (!window.confirm(`Delete this ${payment.payment_type} payment? This can't be undone.`)) return
    setSaving(true)
    const { error: e } = await supabase.from('payments').delete().eq('id', payment.id)
    setSaving(false)
    if (e) return setError(friendlyError(e))
    onDone()
  }

  return (
    <Modal
      title={payment ? `Edit ${payment.payment_type}` : `Add a payment to order ${order.order_code}`}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <Can permission="payments.action.delete" level="edit">
            {payment && (
              <button type="button" className="mr-auto text-sm text-red-700 underline" onClick={remove} disabled={saving}>
                Delete payment
              </button>
            )}
          </Can>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Payment type" htmlFor="pay-type">
          <select id="pay-type" className={inputClass} value={chosenType} onChange={(e) => setType(e.target.value)}>
            {choices.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        {isBalance ? (
          <Field label="Amount" hint="Order total − down payment, calculated automatically.">
            <p className="py-2 text-sm">
              {order.order_total === null ? 'Calculated automatically' : formatMoney(total - (order.down_payment_amount ?? 0), order.currency)}
            </p>
          </Field>
        ) : (
          <Field
            label="Amount"
            htmlFor="pay-amount"
            hint={
              amountMode === 'percent' && amountValue !== null && !Number.isNaN(amountValue)
                ? `= ${formatMoney(amountValue, order.currency)}`
                : chosenType === 'Down payment' && amountValue && total > 0
                  ? `= ${Math.round((amountValue / total) * 1000) / 10}% of the total`
                  : undefined
            }
          >
            <div className="flex gap-2">
              <input id="pay-amount" inputMode="decimal" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} />
              <select
                aria-label="Amount as"
                className={`${inputClass} w-24`}
                value={amountMode}
                onChange={(e) => setAmountMode(e.target.value as 'amount' | 'percent')}
              >
                <option value="amount">{order.currency}</option>
                {order.order_total !== null && <option value="percent">%</option>}
              </select>
            </div>
          </Field>
        )}
        <Field label="Due date" htmlFor="pay-due">
          <input id="pay-due" type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="pay-notes">
          <input id="pay-notes" className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. wire transfer" />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}
