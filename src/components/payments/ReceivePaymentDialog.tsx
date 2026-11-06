// @permission-scope payments.action.mark_received
import { useState } from 'react'
import { useAlerts } from '../../lib/alerts'
import { todayISO } from '../../lib/dates'
import { formatMoney, friendlyError } from '../../lib/format'
import { parseMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase'
import type { PaymentRow } from '../../lib/types'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'

type Props = {
  payment: Pick<PaymentRow, 'id' | 'order_code' | 'payment_type' | 'amount' | 'received_amount' | 'remaining' | 'currency'>
  onClose: () => void
  onDone: () => void
}

/** Record money coming in for one payment: the date and how much. */
export default function ReceivePaymentDialog({ payment, onClose, onDone }: Props) {
  const { refresh: refreshAlerts } = useAlerts()
  const [date, setDate] = useState(todayISO())
  const [amount, setAmount] = useState(String(payment.remaining))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const value = parseMoney(amount)
  const after = value !== null && !Number.isNaN(value) ? payment.remaining - value : null

  async function save() {
    if (!supabase) return
    if (!date) return setError('Enter the date the money arrived.')
    if (value === null || Number.isNaN(value) || value <= 0) return setError('Enter the amount received, for example 2500.')
    setSaving(true)
    const { error: e } = await supabase.rpc('record_payment_received', {
      p_payment_id: payment.id,
      p_date: date,
      p_amount: value,
    })
    setSaving(false)
    if (e) return setError(friendlyError(e))
    refreshAlerts()
    onDone()
  }

  return (
    <Modal
      title={`Order ${payment.order_code}: ${payment.payment_type} received`}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Mark as Received'}
          </button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-600">
        {formatMoney(payment.amount, payment.currency)} due
        {payment.received_amount > 0 && <>, {formatMoney(payment.received_amount, payment.currency)} already received</>}.
        Still to pay: <strong>{formatMoney(payment.remaining, payment.currency)}</strong>.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date received" htmlFor="recv-date">
          <input id="recv-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field
          label={`Amount received (${payment.currency})`}
          htmlFor="recv-amount"
          hint={
            after === null
              ? undefined
              : after > 0
                ? `Part payment: ${formatMoney(after, payment.currency)} will remain outstanding.`
                : after < 0
                  ? `That is ${formatMoney(-after, payment.currency)} more than the amount owed.`
                  : 'Paid in full.'
          }
        >
          <input
            id="recv-amount"
            inputMode="decimal"
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}
