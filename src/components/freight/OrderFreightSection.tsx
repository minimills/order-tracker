// @permission-scope order.section.freight
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { showDate } from '../../lib/dates'
import { formatMoney } from '../../lib/format'
import type { Breakdown } from '../../lib/freight'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import { Section, secondaryButtonClass } from '../form'

type Row = Pick<Breakdown, 'id' | 'ship_date' | 'agent_name' | 'freight_type' | 'currency' | 'breakdown_total' | 'price_difference' | 'archived'>

/** Order page → Freight: this order's shipment cost breakdowns and the freight quote request. */
export default function OrderFreightSection({ orderId }: { orderId: string }) {
  const { can } = usePermissions()
  const see = can('freight.breakdowns')
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    if (!supabase || !see) return
    supabase
      .from('freight_breakdowns')
      .select('id, ship_date, agent_name, freight_type, currency, breakdown_total, price_difference, archived')
      .eq('order_id', orderId)
      .eq('archived', false)
      .order('created_at')
      .then(({ data }) => setRows((data as Row[] | null) ?? []))
  }, [orderId, see])

  return (
    <Section
      title="Freight"
      aside={
        <div className="flex flex-wrap justify-end gap-2">
          <Can permission="freight.quote">
            <Link to={`/freight/quote?order=${orderId}`} className={secondaryButtonClass}>
              Freight Quote Request
            </Link>
          </Can>
          <Can permission="freight.breakdowns" level="edit">
            <Link to={`/freight/breakdowns/new?order=${orderId}`} className={secondaryButtonClass}>
              New Cost Breakdown
            </Link>
          </Can>
        </div>
      }
    >
      <Can permission="freight.breakdowns" fallback={<p className="text-sm text-slate-500">Ask a shipping agent for a quote with the details of this order.</p>}>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No shipment cost breakdown has been saved for this order.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <Link to={`/freight/breakdowns/${r.id}`} className="font-medium text-blue-700 underline">
                    Shipment Cost Breakdown
                  </Link>{' '}
                  <span className="text-slate-600">
                    {[r.freight_type, r.agent_name, r.ship_date ? `shipped ${showDate(r.ship_date)}` : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="tabular-nums">
                  {formatMoney(Number(r.breakdown_total), r.currency)}{' '}
                  <span className={Number(r.price_difference) >= 0 ? 'text-green-700' : 'text-red-700'}>({formatMoney(Number(r.price_difference), r.currency)} price difference)</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Can>
    </Section>
  )
}
