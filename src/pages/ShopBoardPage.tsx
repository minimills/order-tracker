import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { badgeClass, orderBadges } from '../components/board/badges'
import { useCompany } from '../lib/company'
import { countryFlag } from '../lib/country'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { OrderSummaryRow } from '../lib/types'

type Machine = {
  id: string
  order_id: string
  serial_number: string | null
  ready: boolean
  created_at: string
  machine_types: { name: string } | null
}

/**
 * The shop board in large print: board number, order, customer and every
 * machine with its serial and a "built" tick. Made for printing or a big screen.
 */
export default function ShopBoardPage() {
  const [orders, setOrders] = useState<OrderSummaryRow[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const company = useCompany()

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    ;(async () => {
      const o = await fetchAll<OrderSummaryRow>(() =>
        supabase!
          .from('order_summary')
          .select('*')
          .eq('archived', false)
          .not('board_position', 'is', null)
          .order('board_position'),
      )
      const ids = o.data.map((x) => x.id)
      const m = ids.length
        ? await fetchAll<Machine>(() =>
            supabase!
              .from('order_machines')
              .select('id, order_id, serial_number, ready, created_at, machine_types(name)')
              .eq('archived', false)
              .in('order_id', ids)
              .order('created_at'),
          )
        : { data: [], error: null }
      if (cancelled) return
      const e = o.error ?? m.error
      if (e) setError(friendlyError(e))
      setOrders(o.data)
      setMachines(m.data)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const machinesByOrder = new Map<string, Machine[]>()
  for (const m of machines) {
    const list = machinesByOrder.get(m.order_id) ?? []
    list.push(m)
    machinesByOrder.set(m.order_id, list)
  }
  for (const list of machinesByOrder.values()) {
    list.sort(
      (a, b) =>
        (a.machine_types?.name ?? '').localeCompare(b.machine_types?.name ?? '') ||
        (a.serial_number ?? '').localeCompare(b.serial_number ?? ''),
    )
  }

  return (
    <div className="min-h-full bg-white p-4 text-slate-900 md:p-8 print:p-0">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:mb-3">
        <div className="flex items-center gap-4">
          {company.logo && <img src={company.logo} alt="" className="max-h-14" />}
          <div>
          <div className="text-sm font-medium text-slate-600">{company.name}</div>
          <h1 className="text-3xl font-bold">Shop board</h1>
          <p className="text-slate-600">
            {orders.length} order{orders.length === 1 ? '' : 's'} in the queue · {showDate(todayISO(), 'EEEE, MMMM d, yyyy')}
          </p>
          </div>
        </div>
        <div className="flex gap-2 print:hidden">
          <Link to="/board" className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
            ← Back to board
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            🖨 Print
          </button>
        </div>
      </div>

      {loading && <p className="text-xl text-slate-500">Loading…</p>}
      {error && <p className="text-xl text-red-700">{error}</p>}
      {!loading && orders.length === 0 && <p className="text-xl text-slate-500">The board is empty.</p>}

      <div className="divide-y-2 divide-slate-300 border-y-2 border-slate-900">
        {orders.map((o) => {
          const list = machinesByOrder.get(o.id) ?? []
          const badges = orderBadges(o).filter((b) => !b.label.startsWith('Payment'))
          return (
            <section key={o.id} className="grid grid-cols-[4.5rem_1fr] gap-4 py-4 break-inside-avoid md:grid-cols-[6rem_1fr]">
              <div className="text-center text-5xl leading-none font-black md:text-6xl">{o.board_position}</div>
              <div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-2xl font-bold md:text-3xl">Order {o.order_code}</span>
                  <span className="text-xl md:text-2xl">
                    {o.customer_name}
                    {o.customer_company && <span className="text-slate-600"> · {o.customer_company}</span>}
                  </span>
                  <span className="text-lg text-slate-600">
                    {countryFlag(o.customer_country)} {o.customer_country}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-6 text-lg text-slate-700">
                  <span>{o.stage}</span>
                  <span>Ship by {showDate(o.expected_ship_date)}</span>
                  <span>Voltage: {o.voltage}</span>
                  <span>
                    Built {o.machines_ready_count}/{o.machines_count}
                  </span>
                </div>
                {badges.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {badges.map((b) => (
                      <span key={b.label} className={`rounded px-2 py-0.5 text-base font-semibold ring-1 ${badgeClass[b.tone]}`}>
                        {b.label}
                      </span>
                    ))}
                  </div>
                )}
                <ul className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
                  {list.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 text-xl">
                      <span
                        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border-2 text-lg font-bold ${
                          m.ready ? 'border-green-700 bg-green-700 text-white' : 'border-slate-500'
                        }`}
                        aria-label={m.ready ? 'Built' : 'Not built'}
                      >
                        {m.ready ? '✓' : ''}
                      </span>
                      <span className="font-mono font-semibold">{m.serial_number ?? '—'}</span>
                      <span className="text-slate-700">{m.machine_types?.name}</span>
                    </li>
                  ))}
                  {list.length === 0 && <li className="text-lg text-slate-500">No machines</li>}
                </ul>
                {o.notes && <p className="mt-2 text-base whitespace-pre-wrap text-slate-700">{o.notes}</p>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
