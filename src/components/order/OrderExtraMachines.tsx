// @permission-scope order.section.machines
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { friendlyError } from '../../lib/format'
import { KIND_LABEL, STOCK_LABEL, type ItemKind, type StockStatus } from '../../lib/machines'
import { supabase } from '../../lib/supabase'
import StockMachinesPicker, { type ExtraMachine } from './StockMachinesPicker'

type Row = { link_id: string; role: 'sale' | 'service'; machine_id: string; serial: string | null; model: string; item_kind: ItemKind; stock_status: StockStatus | null; owner: string | null }

/**
 * Order page: used / refurbished machines sold from stock on this order, and
 * customer-owned machines listed for service (for the record).
 */
export default function OrderExtraMachines({ orderId, customerId, open, onChanged }: { orderId: string; customerId: string | null; open: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.rpc('order_extra_machines', { p_order: orderId })
    setRows((data as Row[]) ?? [])
  }, [orderId])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function call(fn: string, args: Record<string, string>, ok: string) {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(ok)
    await load()
    onChanged()
  }
  const value: ExtraMachine[] = rows.map((r) => ({ machine_id: r.machine_id, kind: r.role === 'sale' ? 'stock' : 'service', label: `${r.model} ${r.serial ?? ''}`.trim() }))
  if (rows.length === 0 && !open) return null

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-label="Used and refurbished machines" data-print-section="Used and refurbished machines">
      <h2 className="mb-2 font-semibold">Used, Refurbished and Customer-owned Machines</h2>
      {rows.length > 0 && (
        <ul className="mb-3 space-y-1">
          {rows.map((r) => (
            <li key={r.link_id}>
              <Link to={`/machines/${r.machine_id}`} className="underline">
                {r.model} {r.serial}
              </Link>{' '}
              · {r.role === 'sale' ? `From stock (${KIND_LABEL[r.item_kind]})${r.stock_status ? ` · ${STOCK_LABEL[r.stock_status]}` : ''}` : `Customer-owned${r.owner ? ` (${r.owner})` : ''}, ours to service`}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Can permission="order.machines.from_stock" level="edit">
          <StockMachinesPicker
            customerId={customerId}
            value={value}
            busy={busy}
            onAdd={(m) => call('order_add_machine', { p_order: orderId, p_machine: m.machine_id, p_kind: m.kind }, m.kind === 'stock' ? 'Machine reserved on this order.' : 'Machine listed on this order.')}
            onRemove={(m) => call('order_remove_machine', { p_order: orderId, p_machine: m.machine_id }, m.kind === 'stock' ? 'Machine taken off the order and back in stock.' : 'Machine removed from the order.')}
          />
        </Can>
      )}
    </section>
  )
}
