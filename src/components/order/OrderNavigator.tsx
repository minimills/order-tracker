// @permission-scope order.navigate
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchAll } from '../../lib/fetchAll'
import { stageLabel, useStageLabels } from '../../lib/stages'
import { supabase } from '../../lib/supabase'
import { STAGES } from '../../lib/types'
import { narrowInputClass } from '../form'

const small = 'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50 disabled:opacity-40'

type OrderChoice = {
  id: string
  order_code: string
  order_number: number
  split_number: number | null
  customer_name: string | null
  customer_company: string | null
  stage: string
}

let cache: OrderChoice[] | null = null

/**
 * At the top of the order page: ← Previous / Next → order (by order number)
 * and "Go to an order", the same as the navigator at the top of a board.
 */
export default function OrderNavigator({ orderId }: { orderId: string }) {
  useStageLabels()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<OrderChoice[] | null>(cache)
  useEffect(() => {
    if (!supabase) return
    fetchAll<OrderChoice>(() =>
      supabase!
        .from('order_summary')
        .select('id, order_code, order_number, split_number, customer_name, customer_company, stage')
        .eq('archived', false)
        .order('order_number')
        .order('split_number', { nullsFirst: true })
        .order('id'),
    ).then(({ data, error }) => {
      if (error) return
      // Cancelled orders (C-56) after the numbered ones.
      const list = [...data.filter((o) => o.stage !== 'Cancelled'), ...data.filter((o) => o.stage === 'Cancelled')]
      cache = list
      setOrders(list)
    })
  }, [])

  const list = orders ?? []
  const pos = list.findIndex((o) => o.id === orderId)
  const prev = pos > 0 ? list[pos - 1] : null
  const next = pos >= 0 && pos < list.length - 1 ? list[pos + 1] : null
  const text = (o: OrderChoice) => `Order ${o.order_code}${o.customer_company || o.customer_name ? ` – ${o.customer_company || o.customer_name}` : ''}`
  const go = (o: OrderChoice | null) => o && navigate(`/orders/${o.id}`)

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600" data-print="hide">
      <button type="button" className={small} disabled={!prev} title={prev ? text(prev) : undefined} onClick={() => go(prev)} aria-label="Previous order">
        ← Previous
      </button>
      {pos >= 0 && (
        <span className="tabular-nums">
          {pos + 1} of {list.length} orders
        </span>
      )}
      <button type="button" className={small} disabled={!next} title={next ? text(next) : undefined} onClick={() => go(next)} aria-label="Next order">
        Next →
      </button>
      <select
        aria-label="Go to an order"
        className={`${narrowInputClass} w-64 max-w-full py-1`}
        value=""
        onChange={(e) => e.target.value && navigate(`/orders/${e.target.value}`)}
      >
        <option value="">{orders === null ? 'Loading…' : 'Go to an order…'}</option>
        {STAGES.map((stage) => {
          const inStage = list.filter((o) => o.stage === stage)
          return inStage.length ? (
            <optgroup key={stage} label={stageLabel(stage)}>
              {inStage.map((o) => (
                <option key={o.id} value={o.id} disabled={o.id === orderId}>
                  {text(o)}
                </option>
              ))}
            </optgroup>
          ) : null
        })}
      </select>
    </div>
  )
}
