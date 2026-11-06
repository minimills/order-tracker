// @permission-scope dashboard.list.schedule_changes
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { showDate } from '../../lib/dates'
import { daysBetween, planSignature } from '../../lib/schedule'
import { acceptPlan, keepPlan } from '../../lib/scheduleActions'
import { useSchedule } from '../../lib/useSchedule'
import type { OrderSummaryRow } from '../../lib/types'
import Can from '../Can'
import { secondaryButtonClass } from '../form'

/**
 * Dashboard alert: orders whose worked-out ship date is now LATER than the
 * date promised, with Accept / Keep per order. Nothing changes by itself.
 */
export default function ScheduleChanges({ orders, onChanged }: { orders: OrderSummaryRow[]; onChanged: () => void }) {
  const s = useSchedule()
  const [busy, setBusy] = useState<string | null>(null)
  if (s.loading) return null
  const byId = new Map(orders.map((o) => [o.id, o]))
  const late = s.plans.filter((p) => {
    const promised = s.promised(p.order_id)
    return promised.ship && p.ship_date > promised.ship && s.keptSignature(p.order_id) !== planSignature(p)
  })
  if (late.length === 0) return null

  async function run(id: string, fn: () => Promise<boolean>) {
    setBusy(id)
    const ok = await fn()
    setBusy(null)
    if (ok) {
      await s.reload()
      onChanged()
    }
  }

  return (
    <section className="rounded-lg border border-red-200 bg-red-50 p-4 md:p-5">
      <h2 className="font-semibold text-red-900">
        Ship dates at risk · {late.length} order{late.length === 1 ? '' : 's'}
      </h2>
      <p className="mt-0.5 text-sm text-red-900/80">
        The shop queue, machines or progress now give a later ship date than the one promised. Promised dates only change
        when you accept.
      </p>
      <ul className="mt-3 divide-y divide-red-100 text-sm">
        {late.map((p) => {
          const o = byId.get(p.order_id)
          const promised = s.promised(p.order_id)
          return (
            <li key={p.order_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Can permission="order.page" fallback={<span className="font-medium">Order {o?.order_code}</span>}>
                <Link to={`/orders/${p.order_id}`} className="font-medium underline">
                  Order {o?.order_code}
                </Link>
              </Can>
              <span className="text-slate-700">{o?.customer_name}</span>
              <span className="ml-auto">
                {showDate(promised.ship)} → <strong className="text-red-800">{showDate(p.ship_date)}</strong>{' '}
                <span className="text-xs text-red-800">({daysBetween(promised.ship!, p.ship_date)} days later)</span>
              </span>
              <Can permission="schedule.accept" level="edit">
                <span className="flex gap-2">
                  <button type="button" className={secondaryButtonClass} disabled={busy === p.order_id} onClick={() => run(p.order_id, () => acceptPlan(p.order_id, p, promised))}>
                    Accept New Date
                  </button>
                  <button type="button" className={secondaryButtonClass} disabled={busy === p.order_id} onClick={() => run(p.order_id, () => keepPlan(p.order_id, p))}>
                    Keep Promised Date
                  </button>
                </span>
              </Can>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
