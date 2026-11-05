// @permission-scope orders.board.reorder, orders.board.change_stage, order.action.change_stage, order.action.mark_shipped
import { useEffect, useRef, useState } from 'react'
import { useAlerts } from '../../lib/alerts'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import type { OrderSummaryRow, Stage } from '../../lib/types'
import Can from '../Can'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../form'

/** What the user asked for: a new stage and/or a new place on the board. */
export type MoveRequest = {
  order: OrderSummaryRow
  stage: Stage | null
  anchor: OrderSummaryRow | null
  place: 'before' | 'after'
  /** Plain-words description, e.g. "Move up, above order 76". */
  description: string
}

type SerialChange = { order: string; machine_type: string; old: string | null; new: string | null }
type PositionChange = { order: string; old: number | null; new: number | null }
type Preview = { serials: SerialChange[]; positions: PositionChange[] }

type Props = {
  request: MoveRequest
  onClose: () => void
  /** Called after the move is saved, with the number of serials that changed. */
  onDone: (serialsChanged: number) => void
}

function rpcArgs(r: MoveRequest, shipDate: string | null, markBuilt: boolean) {
  return {
    p_order_id: r.order.id,
    p_stage: r.stage,
    p_ship_date: shipDate,
    p_anchor_id: r.anchor?.id ?? null,
    p_place: r.place,
    p_mark_built: markBuilt,
  }
}

function notCratedText(notCrated: number, total: number) {
  if (total === 1) return 'The machine on this order is not marked crated.'
  if (notCrated >= total) return `None of the ${total} machines on this order are marked crated.`
  return `${notCrated} of the ${total} machines on this order ${notCrated === 1 ? 'is' : 'are'} not marked crated.`
}

/**
 * Shows exactly what a move will change (place in the queue and serials) and asks
 * to confirm. Moving to Shipped also asks for the ship date.
 */
export default function MoveDialog({ request, onClose, onDone }: Props) {
  const { refresh: refreshAlerts } = useAlerts()
  const toShipped = request.stage === 'Shipped'
  const [shipDate, setShipDate] = useState(todayISO())
  const [markBuilt, setMarkBuilt] = useState(true)
  const [preview, setPreview] = useState<Preview | null>(null)
  // Machines on the order with no crate yet (only checked when marking Shipped).
  const [notCrated, setNotCrated] = useState(0)
  const warnCrating = usePermissions().can('crating.ship_warning')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    supabase.rpc('preview_board_change', rpcArgs(request, null, false)).then(({ data, error: e }) => {
      if (cancelled) return
      if (e) setError(friendlyError(e))
      else setPreview(data as Preview)
    })
    return () => {
      cancelled = true
    }
  }, [request])

  useEffect(() => {
    if (!supabase || !toShipped || !warnCrating) return
    let cancelled = false
    supabase
      .from('machine_crating')
      .select('machine_id', { count: 'exact', head: true })
      .eq('order_id', request.order.id)
      .eq('crate_count', 0)
      .then(({ count }) => {
        if (!cancelled) setNotCrated(count ?? 0)
      })
    return () => {
      cancelled = true
    }
  }, [request, toShipped, warnCrating])

  useEffect(() => {
    if (preview) confirmRef.current?.focus()
  }, [preview])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  async function confirm() {
    if (!supabase) return
    if (toShipped && !shipDate) {
      setError('Enter the date the shipment left.')
      return
    }
    setSaving(true)
    const { data, error: e } = await supabase.rpc(
      'apply_board_change',
      rpcArgs(request, toShipped ? shipDate : null, toShipped && markBuilt),
    )
    setSaving(false)
    if (e) {
      setError(friendlyError(e))
      return
    }
    refreshAlerts()
    onDone((data as unknown[] | null)?.length ?? 0)
  }

  const me = preview?.positions.find((p) => p.order === request.order.order_code)
  const others = preview?.positions.filter((p) => p.order !== request.order.order_code) ?? []

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="move-title">
      <div className="max-h-[90vh] w-full overflow-y-auto rounded-t-lg bg-white p-5 shadow-xl sm:max-w-lg sm:rounded-lg">
        <h2 id="move-title" className="text-lg font-semibold">
          Order {request.order.order_code}: {request.description}
        </h2>

        {toShipped && (
          <div className="mt-4 space-y-3 rounded-md bg-slate-50 p-3">
            <Field label="Date the shipment left" htmlFor="ship-date">
              <input
                id="ship-date"
                type="date"
                className={inputClass}
                value={shipDate}
                max={todayISO()}
                onChange={(e) => setShipDate(e.target.value)}
              />
            </Field>
            <Can permission="crating.ship_warning">
            {notCrated > 0 && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" role="alert">
                ⚠️ {notCratedText(notCrated, request.order.machines_count)} You can still mark it shipped; you can also
                fill in the crates later from the order page.
              </p>
            )}
            </Can>
            {request.order.machines_ready_count < request.order.machines_count && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={markBuilt} onChange={(e) => setMarkBuilt(e.target.checked)} />
                <span>
                  Mark all machines on this order as built ({request.order.machines_ready_count} of{' '}
                  {request.order.machines_count} are marked built now). Built machines keep their serials for good.
                </span>
              </label>
            )}
          </div>
        )}

        {!preview && !error && <p className="mt-4 text-sm text-slate-500">Working out what will change…</p>}

        {preview && (
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <h3 className="font-medium">Shop queue</h3>
              <p className="mt-1">
                {!me
                  ? 'The order of the shop queue does not change.'
                  : me.new === null
                    ? `Order ${request.order.order_code} leaves the shop queue${others.length ? '; the orders behind it move up' : ''}.`
                    : me.old === null
                      ? `Order ${request.order.order_code} joins the shop queue${request.anchor ? ` ${request.place === 'before' ? 'above' : 'below'} order ${request.anchor.order_code}` : ' at the end'}.`
                      : `Order ${request.order.order_code} moves ${me.new < me.old ? 'up' : 'down'} the queue${request.anchor ? `, ${request.place === 'before' ? 'above' : 'below'} order ${request.anchor.order_code}` : ''}.`}
              </p>
            </div>

            <div>
              <h3 className="font-medium">Serial numbers</h3>
              {preview.serials.length === 0 ? (
                <p className="mt-1 text-slate-500">No serial numbers change.</p>
              ) : (
                <>
                  <p className="mt-1 text-slate-600">
                    {preview.serials.length} serial number{preview.serials.length === 1 ? '' : 's'} will change, so
                    orders earlier in the queue keep the lower serials. Built machines are not affected.
                  </p>
                  <table className="mt-2 w-full text-left">
                    <thead className="text-xs text-slate-500">
                      <tr>
                        <th className="py-1 font-normal">Order</th>
                        <th className="py-1 font-normal">Machine</th>
                        <th className="py-1 font-normal">Old</th>
                        <th className="py-1 font-normal" />
                        <th className="py-1 font-normal">New</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-xs">
                      {preview.serials.map((s, i) => (
                        <tr key={i}>
                          <td className="py-1 font-sans">{s.order}</td>
                          <td className="py-1 font-sans">{s.machine_type}</td>
                          <td className="py-1">{s.old ?? '(none)'}</td>
                          <td className="py-1 text-slate-400">→</td>
                          <td className="py-1 font-semibold">{s.new ?? '(none)'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        )}

        {error && <p className="mt-4 text-sm font-medium text-red-600">{error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={buttonClass}
            onClick={confirm}
            disabled={!preview || saving}
          >
            {saving ? 'Saving…' : 'Confirm move'}
          </button>
        </div>
      </div>
    </div>
  )
}
