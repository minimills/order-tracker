// @permission-scope orders.new.from_stock, order.machines.from_stock
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { friendlyError } from '../../lib/format'
import { KIND_LABEL, loadStockMachines, stockLabel, type StockMachine } from '../../lib/machines'
import { supabase } from '../../lib/supabase'
import { narrowInputClass, secondaryButtonClass } from '../form'

export type ExtraMachine = { machine_id: string; kind: 'stock' | 'service'; label: string }
type Owned = { machine_id: string; serial: string | null; model: string; item_kind: string }

/**
 * "From stock" (a used or refurbished machine the company owns: reserved on the
 * order, no new serial) and "Customer-owned, ours to service" (listed for the
 * record only). Used on New order and on the Order page.
 */
/* @layout-helper */
export default function StockMachinesPicker({ customerId, value, onAdd, onRemove, busy = false }: { customerId: string | null; value: ExtraMachine[]; onAdd: (m: ExtraMachine) => void; onRemove: (m: ExtraMachine) => void; busy?: boolean }) {
  const [stock, setStock] = useState<StockMachine[]>([])
  const [owned, setOwned] = useState<Owned[]>([])
  const [pick, setPick] = useState('')
  const [pickOwned, setPickOwned] = useState('')
  useEffect(() => {
    loadStockMachines()
      .then(setStock)
      .catch((e) => toast.error(friendlyError(e)))
  }, [])
  useEffect(() => {
    if (!supabase || !customerId) return
    supabase.rpc('customer_owned_machines', { p_customer: customerId }).then(({ data }) => setOwned((data as Owned[]) ?? []))
  }, [customerId])
  const chosen = new Set(value.map((v) => v.machine_id))
  const freeStock = stock.filter((s) => !chosen.has(s.machine_id))
  const freeOwned = customerId ? owned.filter((o) => !chosen.has(o.machine_id)) : []

  return (
    <div className="space-y-2 text-sm">
      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((v) => (
            <li key={v.machine_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-violet-50 px-2 py-1">
              <span>
                <span className="mr-1.5 rounded bg-violet-600 px-1 text-[0.625rem] font-bold text-white">{v.kind === 'stock' ? 'From stock' : 'Customer-owned'}</span>
                {v.label}
              </span>
              <button type="button" className="text-xs underline" disabled={busy} onClick={() => onRemove(v)}>
                {v.kind === 'stock' ? 'Take Off the Order' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Machine from stock" className={`${narrowInputClass} min-w-0 flex-1`} value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{freeStock.length ? 'Add a used or refurbished machine from stock…' : 'No machines in stock'}</option>
          {freeStock.map((s) => (
            <option key={s.machine_id} value={s.machine_id}>
              {stockLabel(s)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={!pick || busy}
          onClick={() => {
            const s = stock.find((x) => x.machine_id === pick)
            if (s) onAdd({ machine_id: s.machine_id, kind: 'stock', label: stockLabel(s) })
            setPick('')
          }}
        >
          Add From Stock
        </button>
      </div>
      {customerId && (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Customer-owned machine" className={`${narrowInputClass} min-w-0 flex-1`} value={pickOwned} onChange={(e) => setPickOwned(e.target.value)}>
            <option value="">{freeOwned.length ? 'List a machine the customer owns (to service, for the record)…' : 'The customer has no machines on record'}</option>
            {freeOwned.map((o) => (
              <option key={o.machine_id} value={o.machine_id}>
                {o.model} {o.serial ?? ''} · {KIND_LABEL[o.item_kind as keyof typeof KIND_LABEL] ?? o.item_kind}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={!pickOwned || busy}
            onClick={() => {
              const o = owned.find((x) => x.machine_id === pickOwned)
              if (o) onAdd({ machine_id: o.machine_id, kind: 'service', label: `${o.model} ${o.serial ?? ''}`.trim() })
              setPickOwned('')
            }}
          >
            Add Customer-owned
          </button>
        </div>
      )}
    </div>
  )
}
