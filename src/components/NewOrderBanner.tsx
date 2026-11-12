import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import Can from './Can'
import Icon from './Icon'

type NewOrder = { id: string; order_code: string; customer_name: string; customer_company: string | null; shownAt: number }
const SHOW_MS = 60_000

/**
 * "New order 87 added" at the top of every page when an order lands in
 * Confirmed. Checked every 20 seconds; each banner goes away after 60 seconds,
 * with Dismiss, or on refresh (only orders added after the page opened).
 */
export default function NewOrderBanner() {
  const { can } = usePermissions()
  const enabled = can('orders.board.new_order_banner')
  const since = useRef('')
  const seen = useRef(new Set<string>())
  const [list, setList] = useState<NewOrder[]>([])

  useEffect(() => {
    if (!enabled || !supabase) return
    // Only orders added after the page opened (a refresh starts again).
    if (!since.current) since.current = new Date().toISOString()
    const check = async () => {
      const { data } = await supabase!
        .from('order_summary')
        .select('id, order_code, customer_name, customer_company, created_at')
        .eq('stage', 'Confirmed')
        .eq('archived', false)
        .gt('created_at', since.current)
        .order('created_at')
      const fresh = ((data as Omit<NewOrder, 'shownAt'>[]) ?? []).filter((o) => !seen.current.has(o.id))
      fresh.forEach((o) => seen.current.add(o.id))
      setList((l) => [...l.filter((x) => Date.now() - x.shownAt < SHOW_MS), ...fresh.map((o) => ({ ...o, shownAt: Date.now() }))])
    }
    void check()
    const t = window.setInterval(check, 20_000)
    const tidy = window.setInterval(() => setList((l) => (l.some((x) => Date.now() - x.shownAt >= SHOW_MS) ? l.filter((x) => Date.now() - x.shownAt < SHOW_MS) : l)), 5_000)
    return () => {
      window.clearInterval(t)
      window.clearInterval(tidy)
    }
  }, [enabled])

  if (!list.length) return null
  return (
    <Can permission="orders.board.new_order_banner">
      <div className="space-y-px print:hidden" role="status">
        {list.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-green-700 px-4 py-2 text-sm text-white md:px-8">
            <Icon name="plus" className="h-4 w-4" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">New order {o.order_code} added</span>
              <span className="text-green-100"> · {o.customer_company || o.customer_name}</span>
            </span>
            <Link to={`/orders/${o.id}`} className="rounded-md border border-white/60 px-3 py-1 font-medium hover:bg-white/10">
              Open Order {o.order_code}
            </Link>
            <button type="button" className="rounded-md px-3 py-1 font-medium hover:bg-white/10" onClick={() => setList((l) => l.filter((x) => x.id !== o.id))}>
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </Can>
  )
}
