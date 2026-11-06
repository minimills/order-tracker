// @permission-scope admin.records
import { stageLabel } from '../../lib/stages'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import {
  AdminCustomerDialog,
  AdminMachineDialog,
  AdminOrderDialog,
  ArchiveDialog,
  type AdminMachine,
  type AdminOrder,
} from '../../components/admin/EditDialogs'
import { inputClass } from '../../components/form'
import { useAlerts } from '../../lib/alerts'
import { fetchAll } from '../../lib/fetchAll'
import { formatMoney, friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { Customer } from '../../lib/types'
import SerialNumber from '../../components/SerialNumber'

type Tab = 'orders' | 'customers' | 'machines'
type OrderRow = AdminOrder & { customer_name: string; board_position: number | null }
type MachineRow = AdminMachine & { machine_types: { name: string } | null }

const LIMIT = 200
const small = 'rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50'

export default function RecordsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (['orders', 'customers', 'machines'].includes(params.get('tab') ?? '') ? params.get('tab') : 'orders') as Tab
  const [q, setQ] = useState('')
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [machines, setMachines] = useState<MachineRow[]>([])
  const [loading, setLoading] = useState(true)
  const [editOrder, setEditOrder] = useState<AdminOrder | null>(null)
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null)
  const [editMachine, setEditMachine] = useState<AdminMachine | null>(null)
  const [archiving, setArchiving] = useState<{ table: Tab; id: string; what: string; explain: string } | null>(null)
  const { refresh: refreshAlerts } = useAlerts()

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    const [o, c, m] = await Promise.all([
      fetchAll<OrderRow>(() =>
        supabase!
          .from('order_summary')
          .select(
            'id, order_number, split_number, order_code, customer_id, customer_name, stage, board_position, order_date, currency, order_total, expected_ship_date, actual_ship_date, voltage, delivery_equipment, freight_type, notes',
          )
          .eq('archived', false)
          .order('order_number', { ascending: false })
          .order('split_number', { ascending: false, nullsFirst: false }),
      ),
      fetchAll<Customer>(() => supabase!.from('customer_list').select('*').eq('archived', false).order('name')),
      fetchAll<MachineRow>(() =>
        supabase!
          .from('order_machines')
          .select('id, order_id, machine_type_id, serial_number, serial_manual, ready, notes, orders(order_code), machine_types(name)')
          .eq('archived', false)
          .order('serial_number', { nullsFirst: false }),
      ),
    ])
    const error = o.error ?? c.error ?? m.error
    if (error) toast.error(friendlyError(error))
    setOrders(o.data)
    setCustomers(c.data)
    setMachines(m.data)
    setLoading(false)
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const match = (...parts: (string | null | undefined)[]) => {
    const text = parts.join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  }
  const shownOrders = orders.filter((o) => match(o.order_code, o.customer_name, o.stage, o.notes))
  const shownCustomers = customers.filter((c) =>
    match(c.name, c.company, c.country, c.state_province, c.phone, c.emails.join(' ')),
  )
  const shownMachines = machines.filter((m) => match(m.serial_number, m.machine_types?.name, m.orders?.order_code))

  const done = (message: string) => {
    toast.success(message)
    setEditOrder(null)
    setEditCustomer(null)
    setEditMachine(null)
    load()
  }

  async function archive() {
    if (!supabase || !archiving) return
    const table = archiving.table === 'machines' ? 'order_machines' : archiving.table
    const { error } = await supabase.from(table).update({ archived: true }).eq('id', archiving.id)
    if (error) {
      toast.error(friendlyError(error))
      return
    }
    toast.success(`${archiving.what} archived.`)
    setArchiving(null)
    refreshAlerts()
    load()
  }

  const counts = { orders: shownOrders.length, customers: shownCustomers.length, machines: shownMachines.length }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <AdminPageHeader title="Orders, Customers and Machines">
        Edit any field. Archive hides a record from normal screens; it can be brought back from the Archive page.
      </AdminPageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-md bg-slate-100 p-1" role="tablist">
          {(['orders', 'customers', 'machines'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setParams({ tab: t }, { replace: true })}
              className={`rounded px-3 py-1.5 text-sm font-medium capitalize ${tab === t ? 'bg-white shadow-sm' : 'text-slate-600'}`}
            >
              {t} <span className="text-xs text-slate-500">({counts[t]})</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search"
          className={`${inputClass} max-w-sm`}
          placeholder={tab === 'machines' ? 'Search serial, type or order #' : 'Search'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <p className="text-center text-slate-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            {tab === 'orders' && (
              <>
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-normal">Order</th>
                    <th className="px-3 py-2 font-normal">Customer</th>
                    <th className="px-3 py-2 font-normal">Stage</th>
                    <th className="px-3 py-2 text-right font-normal">Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shownOrders.slice(0, LIMIT).map((o) => (
                    <tr key={o.id}>
                      <td className="px-3 py-2 font-medium">
                        <Link to={`/orders/${o.id}`} className="hover:underline">
                          {o.order_code}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{o.customer_name}</td>
                      <td className="px-3 py-2">{stageLabel(o.stage)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(o.order_total, o.currency)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button type="button" className={small} onClick={() => setEditOrder(o)}>
                          Edit
                        </button>{' '}
                        <button
                          type="button"
                          className={small}
                          onClick={() =>
                            setArchiving({
                              table: 'orders',
                              id: o.id,
                              what: `Order ${o.order_code}`,
                              explain:
                                'The order disappears from the board, lists and alerts. Its unbuilt machines give their serials back, and everyone behind it on the board moves up.',
                            })
                          }
                        >
                          Archive
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}

            {tab === 'customers' && (
              <>
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-normal">Name</th>
                    <th className="px-3 py-2 font-normal">Company</th>
                    <th className="px-3 py-2 font-normal">Emails</th>
                    <th className="px-3 py-2 font-normal">Country</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shownCustomers.slice(0, LIMIT).map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2">{c.company}</td>
                      <td className="px-3 py-2 text-xs break-all">{c.emails.join(', ')}</td>
                      <td className="px-3 py-2">{[c.state_province, c.country].filter(Boolean).join(', ')}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button type="button" className={small} onClick={() => setEditCustomer(c)}>
                          Edit
                        </button>{' '}
                        <button
                          type="button"
                          className={small}
                          onClick={() =>
                            setArchiving({
                              table: 'customers',
                              id: c.id,
                              what: `customer ${c.name}`,
                              explain: 'The customer is no longer offered on the New Order form. Their orders are not changed.',
                            })
                          }
                        >
                          Archive
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}

            {tab === 'machines' && (
              <>
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-normal">Serial</th>
                    <th className="px-3 py-2 font-normal">Machine type</th>
                    <th className="px-3 py-2 font-normal">Order</th>
                    <th className="px-3 py-2 font-normal">Built</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shownMachines.slice(0, LIMIT).map((m) => (
                    <tr key={m.id}>
                      <td className="px-3 py-2 font-mono">
                        {m.serial_number ? <SerialNumber serial={m.serial_number} /> : <span className="font-sans text-slate-400">none</span>}
                        {m.serial_manual && <span className="ml-1 font-sans text-xs text-slate-500">(by hand)</span>}
                      </td>
                      <td className="px-3 py-2">{m.machine_types?.name}</td>
                      <td className="px-3 py-2">
                        <Link to={`/orders/${m.order_id}`} className="hover:underline">
                          {m.orders?.order_code}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{m.ready ? 'Built' : ''}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button type="button" className={small} onClick={() => setEditMachine(m)}>
                          Edit
                        </button>{' '}
                        <button
                          type="button"
                          className={small}
                          onClick={() =>
                            setArchiving({
                              table: 'machines',
                              id: m.id,
                              what: `machine ${m.serial_number ?? m.machine_types?.name ?? ''}`,
                              explain: m.ready
                                ? 'The machine is removed from its order. It is built, so it keeps its serial.'
                                : 'The machine is removed from its order and its serial is given back for other machines.',
                            })
                          }
                        >
                          Archive
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
          {counts[tab] > LIMIT && (
            <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
              Showing the first {LIMIT} of {counts[tab]}. Search to narrow it down.
            </p>
          )}
          {counts[tab] === 0 && <p className="px-3 py-6 text-center text-sm text-slate-500">No matching records found.</p>}
        </div>
      )}

      {editOrder && <AdminOrderDialog order={editOrder} onClose={() => setEditOrder(null)} onDone={done} />}
      {editCustomer && <AdminCustomerDialog customer={editCustomer} onClose={() => setEditCustomer(null)} onDone={done} />}
      {editMachine && <AdminMachineDialog machine={editMachine} onClose={() => setEditMachine(null)} onDone={done} />}
      {archiving && (
        <ArchiveDialog what={archiving.what} explain={archiving.explain} onClose={() => setArchiving(null)} onConfirm={archive} />
      )}
    </div>
  )
}
