import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { usePreferences, type ShopBoardView } from '../lib/preferences'
import { Link } from 'react-router-dom'
import { badgeClass, orderBadges } from '../components/board/badges'
import Can from '../components/Can'
import RichText from '../components/RichText'
import MachineCrating from '../components/crating/MachineCrating'
import { useCompany } from '../lib/company'
import { countryFlag } from '../lib/country'
import { CRATING_STAGES, loadCrates, type NumberedCrate } from '../lib/crates'
import { showDate, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { useStageLabels } from '../lib/stages'
import { supabase } from '../lib/supabase'
import type { OrderSummaryRow } from '../lib/types'
import SerialNumber from '../components/SerialNumber'
import Icon from '../components/Icon'

type Machine = {
  id: string
  order_id: string
  serial_number: string | null
  ready: boolean
  created_at: string
  machine_types: { name: string } | null
}

/**
 * The shop board in large print, in queue order: order, customer and every
 * machine with its serial and its built status. Made for printing or a big screen.
 */
export default function ShopBoardPage() {
  const [orders, setOrders] = useState<OrderSummaryRow[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [crates, setCrates] = useState<Map<string, NumberedCrate[]>>(new Map())
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const company = useCompany()
  const { can } = usePermissions()
  const seesCrating = can('crating')
  const label = useStageLabels()
  const { shopBoardView: view, setLook } = usePreferences()
  // Filters (in the address, so printing and sharing use them).
  const [params, setParams] = useSearchParams()
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  const fOrders = (params.get('orders') ?? '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const fAfter = params.get('after') ?? ''
  const fBefore = params.get('before') ?? ''
  const fType = params.get('type') ?? ''
  const fPassed = params.get('passed') === '1'
  const fPassedDays = params.get('passedby') ?? ''

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    ;(async () => {
      const o = await fetchAll<OrderSummaryRow>(() =>
        supabase!.from('order_summary').select('*').eq('archived', false).not('board_position', 'is', null).order('board_position'),
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
      // Crating is only asked for on orders that are ready to ship.
      const c = await loadCrates(seesCrating ? o.data.filter((x) => CRATING_STAGES.includes(x.stage)).map((x) => x.id) : [])
      if (cancelled) return
      const e = o.error ?? m.error ?? c.error
      if (e) setError(friendlyError(e))
      setOrders(o.data)
      setMachines(m.data)
      setCrates(c.byOrder)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey, seesCrating])

  const machinesByOrder = new Map<string, Machine[]>()
  for (const m of machines) {
    const list = machinesByOrder.get(m.order_id) ?? []
    list.push(m)
    machinesByOrder.set(m.order_id, list)
  }
  for (const list of machinesByOrder.values()) {
    list.sort(
      (a, b) => (a.machine_types?.name ?? '').localeCompare(b.machine_types?.name ?? '') || (a.serial_number ?? '').localeCompare(b.serial_number ?? ''),
    )
  }

  const today = todayISO()
  const daysPast = (d: string | null) => (d ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86_400_000) : -1)
  const typeNames = [...new Set(machines.map((m) => m.machine_types?.name).filter((x): x is string => !!x))].sort()
  const shown = orders.filter((o) => {
    if (fOrders.length && !fOrders.includes(o.order_code) && !fOrders.includes(String(o.order_number))) return false
    if (fAfter && (!o.expected_ship_date || o.expected_ship_date < fAfter)) return false
    if (fBefore && (!o.expected_ship_date || o.expected_ship_date > fBefore)) return false
    if (fType && !(machinesByOrder.get(o.id) ?? []).some((m) => m.machine_types?.name === fType)) return false
    if (fPassed && daysPast(o.expected_ship_date) <= 0) return false
    if (fPassedDays && daysPast(o.expected_ship_date) <= Number(fPassedDays)) return false
    return true
  })
  const filtering = fOrders.length > 0 || !!(fAfter || fBefore || fType || fPassed || fPassedDays)
  const filterText = [
    fOrders.length && `orders ${fOrders.join(', ')}`,
    fAfter && `ship date after ${showDate(fAfter)}`,
    fBefore && `ship date before ${showDate(fBefore)}`,
    fType,
    fPassedDays ? `ship date passed by more than ${fPassedDays} days` : fPassed && 'ship date passed',
  ]
    .filter(Boolean)
    .join(' · ')
  const VIEWS: { v: ShopBoardView; label: string }[] = [
    { v: 'rows', label: 'Across' },
    { v: 'list', label: 'List' },
    { v: 'cards', label: 'Cards' },
  ]
  const field = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm'

  return (
    <Can permission="shop_board">
      <div className="min-h-full bg-white p-4 text-slate-900 md:p-8 print:p-0">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:mb-3">
          <div className="flex items-center gap-4">
            {company.logo && <img src={company.logo} alt="" className="max-h-14" />}
            <div>
              <div className="text-sm font-medium text-slate-600">{company.name}</div>
              <h1 className="text-3xl font-bold">Shop Board</h1>
              <p className="text-slate-600">
                {orders.length} order{orders.length === 1 ? '' : 's'} in the queue · {showDate(todayISO(), 'EEEE, MMMM d, yyyy')}
              </p>
            </div>
          </div>
          <div className="flex gap-2 print:hidden">
            <Can
              permission="orders.board"
              fallback={
                <Link to="/" className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
                  ← Back
                </Link>
              }
            >
              <Link to="/board" className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
                ← Back to Orders Board
              </Link>
            </Can>
            <Can permission="shop_board.print">
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                Print
              </button>
            </Can>
          </div>
        </div>

        {loading && <p className="text-xl text-slate-500">Loading…</p>}
        {error && <p className="text-xl text-red-700">{error}</p>}
        {!loading && orders.length === 0 && <p className="text-xl text-slate-500">There are no orders in the shop queue.</p>}

        <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
          <Can permission="shop_board.filters">
            <label className="text-xs text-slate-600">
              Orders
              <input
                className={`${field} block w-36`}
                placeholder="for example 76, 81"
                value={params.get('orders') ?? ''}
                onChange={(e) => setFilter('orders', e.target.value)}
              />
            </label>
            <label className="text-xs text-slate-600">
              Ship date after
              <input type="date" className={`${field} block`} value={fAfter} onChange={(e) => setFilter('after', e.target.value)} />
            </label>
            <label className="text-xs text-slate-600">
              Ship date before
              <input type="date" className={`${field} block`} value={fBefore} onChange={(e) => setFilter('before', e.target.value)} />
            </label>
            <label className="text-xs text-slate-600">
              Machine type
              <select className={`${field} block`} value={fType} onChange={(e) => setFilter('type', e.target.value)}>
                <option value="">All machine types</option>
                {typeNames.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={fPassed} onChange={(e) => setFilter('passed', e.target.checked ? '1' : '')} />
              Ship date passed
            </label>
            <label className="text-xs text-slate-600">
              Passed by more than (days)
              <input
                inputMode="numeric"
                className={`${field} block w-24`}
                value={fPassedDays}
                onChange={(e) => setFilter('passedby', e.target.value.replace(/\D/g, ''))}
              />
            </label>
            {filtering && (
              <button type="button" className="pb-2 text-sm underline" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                Clear Filters
              </button>
            )}
          </Can>
          <Can permission="shop_board.views">
            <div className="ml-auto flex rounded-md border border-slate-300 p-0.5 text-sm" role="radiogroup" aria-label="View">
              {VIEWS.map((x) => (
                <button
                  key={x.v}
                  type="button"
                  role="radio"
                  aria-checked={view === x.v}
                  onClick={() => setLook({ shopBoardView: x.v })}
                  className={`rounded px-3 py-1 ${view === x.v ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                >
                  {x.label}
                </button>
              ))}
            </div>
          </Can>
        </div>
        {filtering && (
          <p className="mb-3 text-lg text-slate-700">
            Showing {shown.length} of {orders.length} orders: {filterText}
          </p>
        )}

        {view === 'list' && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-base">
              <thead>
                <tr className="border-b-2 border-slate-900 text-sm text-slate-600">
                  <th className="py-2 pr-3">Order</th>
                  <Can permission="shop_board.detail.customer">
                    <th className="py-2 pr-3">Customer</th>
                  </Can>
                  <Can permission="shop_board.detail.stage">
                    <th className="py-2 pr-3">Stage</th>
                  </Can>
                  <Can permission="shop_board.detail.ship_date">
                    <th className="py-2 pr-3">Ship by</th>
                  </Can>
                  <Can permission="shop_board.detail.voltage">
                    <th className="py-2 pr-3">Voltage</th>
                  </Can>
                  <Can permission="shop_board.detail.built">
                    <th className="py-2 pr-3">Built</th>
                  </Can>
                  <Can permission="shop_board.detail.machines">
                    <th className="py-2">Machines</th>
                  </Can>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-300">
                {shown.map((o) => (
                  <tr key={o.id} className="break-inside-avoid align-top">
                    <td className="py-2 pr-3 text-2xl font-black">{o.order_code}</td>
                    <Can permission="shop_board.detail.customer">
                      <td className="py-2 pr-3">{o.customer_company || o.customer_name}</td>
                    </Can>
                    <Can permission="shop_board.detail.stage">
                      <td className="py-2 pr-3">{label(o.stage)}</td>
                    </Can>
                    <Can permission="shop_board.detail.ship_date">
                      <td className={`py-2 pr-3 ${daysPast(o.expected_ship_date) > 0 ? 'font-semibold text-red-700' : ''}`}>
                        {showDate(o.expected_ship_date)}
                      </td>
                    </Can>
                    <Can permission="shop_board.detail.voltage">
                      <td className="py-2 pr-3">{o.voltage}</td>
                    </Can>
                    <Can permission="shop_board.detail.built">
                      <td className="py-2 pr-3">
                        {o.machines_ready_count}/{o.machines_count}
                      </td>
                    </Can>
                    <Can permission="shop_board.detail.machines">
                      <td className="py-2 text-sm">
                        {(machinesByOrder.get(o.id) ?? []).map((m) => (
                          <span key={m.id} className="mr-3 inline-block whitespace-nowrap">
                            {m.machine_types?.name} {m.serial_number && <span className="font-mono font-semibold">{m.serial_number}</span>}
                            {m.ready && <span className="text-green-700"> (built)</span>}
                          </span>
                        ))}
                      </td>
                    </Can>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {view !== 'list' && (
          <div
            className={
              view === 'cards' ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2' : 'divide-y-2 divide-slate-300 border-y-2 border-slate-900'
            }
          >
            {shown.map((o) => {
              const list = machinesByOrder.get(o.id) ?? []
              const badges = orderBadges(o).filter((b) => b.kind !== 'payment')
              const crating = seesCrating && CRATING_STAGES.includes(o.stage)
              const orderCrates = crates.get(o.id) ?? []
              const crateMachines = list.map((m) => ({
                id: m.id,
                label: `${m.machine_types?.name ?? 'Machine'}${m.serial_number ? ` ${m.serial_number}` : ''}`,
              }))
              return (
                <section
                  key={o.id}
                  className={
                    view === 'cards'
                      ? 'min-w-0 break-inside-avoid rounded-lg border-2 border-slate-300 p-4'
                      : 'grid grid-cols-[5.5rem_1fr] gap-4 py-4 break-inside-avoid md:grid-cols-[8rem_1fr]'
                  }
                >
                  <div className={view === 'cards' ? 'mb-2 text-4xl leading-none font-black' : 'text-center text-4xl leading-none font-black md:text-5xl'}>
                    {o.order_code}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <Can permission="shop_board.detail.customer">
                        <span className="text-xl md:text-2xl">{o.customer_company || o.customer_name}</span>
                      </Can>
                      <Can permission="shop_board.detail.country">
                        <span className="text-lg text-slate-600">
                          {countryFlag(o.customer_country)} {o.customer_country}
                        </span>
                      </Can>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-6 text-lg text-slate-700">
                      <Can permission="shop_board.detail.stage">
                        <span>{label(o.stage)}</span>
                      </Can>
                      <Can permission="shop_board.detail.ship_date">
                        <span>Ship by {showDate(o.expected_ship_date)}</span>
                      </Can>
                      <Can permission="shop_board.detail.voltage">
                        <span>Voltage: {o.voltage}</span>
                      </Can>
                      <Can permission="shop_board.detail.built">
                        <span>
                          Built {o.machines_ready_count}/{o.machines_count}
                        </span>
                      </Can>
                    </div>
                    <Can permission="shop_board.detail.badges">
                      {badges.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {badges.map((b) => (
                            <span key={b.label} className={`rounded px-2 py-0.5 text-base font-semibold ring-1 ${badgeClass[b.tone]}`}>
                              {b.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </Can>
                    <Can permission="shop_board.detail.machines">
                      <ul className={`mt-3 grid gap-x-8 ${crating || view === 'cards' ? 'gap-y-2' : 'gap-y-1 sm:grid-cols-2'}`}>
                        {list.map((m) => (
                          <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl">
                            <span
                              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border-2 text-lg font-bold ${
                                m.ready ? 'border-green-700 bg-green-700 text-white' : 'border-slate-500'
                              }`}
                              aria-label={m.ready ? 'Built' : 'Not built'}
                            >
                              {m.ready && <Icon name="check" className="h-5 w-5" />}
                            </span>
                            {m.serial_number ? <SerialNumber serial={m.serial_number} className="font-semibold" /> : <span>—</span>}
                            <span className="text-slate-700">{m.machine_types?.name}</span>
                            {crating && (
                              <Can permission="crating">
                                <div className="basis-full pl-10">
                                  <MachineCrating
                                    orderId={o.id}
                                    orderCode={o.order_code}
                                    machine={crateMachines.find((x) => x.id === m.id)!}
                                    orderMachines={crateMachines}
                                    crates={orderCrates}
                                    onChanged={() => setReloadKey((k) => k + 1)}
                                    large
                                  />
                                </div>
                              </Can>
                            )}
                          </li>
                        ))}
                        {list.length === 0 && <li className="text-lg text-slate-500">No machines</li>}
                      </ul>
                    </Can>
                    <Can permission="shop_board.detail.notes">{o.notes && <RichText value={o.notes} className="mt-2 text-base text-slate-700" />}</Can>
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </Can>
  )
}
