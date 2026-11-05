// @permission-scope payments
import type { PaymentRow } from '../../lib/types'
import { dueText } from './dueText'

const tone: Record<string, string> = {
  Paid: 'bg-green-100 text-green-800 ring-green-200',
  Overdue: 'bg-red-100 text-red-800 ring-red-200',
  'Due soon': 'bg-amber-100 text-amber-900 ring-amber-200',
  Upcoming: 'bg-slate-100 text-slate-700 ring-slate-200',
  'Nothing due': 'bg-white text-slate-400 ring-slate-200',
}

/** Coloured status label, e.g. "Overdue · 4 days overdue". */
export default function PaymentStatus({ payment }: { payment: Pick<PaymentRow, 'status' | 'days_until_due'> }) {
  const extra = dueText(payment)
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ${tone[payment.status] ?? ''}`}>
      {payment.status}
      {extra && payment.status !== 'Upcoming' && <span className="font-normal"> · {extra}</span>}
    </span>
  )
}
