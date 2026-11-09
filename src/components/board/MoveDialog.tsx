// @permission-scope orders.board.reorder, orders.board.change_stage, order.action.change_stage, order.action.mark_shipped
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAlerts } from '../../lib/alerts'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import type { OrderSummaryRow, Stage } from '../../lib/types'
import Can from '../Can'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../form'
import Icon from '../Icon'

/** What the user asked for: a new stage and/or a new place on the board. */
export type MoveRequest = {
  order: OrderSummaryRow
  stage: Stage | null
  anchor: OrderSummaryRow | null
  place: 'before' | 'after'
  /** Plain-words description, for example "Move up, above order 76". */
  description: string
}

type SerialChange = { order: string; machine_type: string; old: string | null; new: string | null }
type PositionChange = { order: string; old: number | null; new: number | null }
type Preview = { serials: SerialChange[]; positions: PositionChange[]; numbers?: { old: string; new: string }[] }

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
  const { can } = usePermissions()
  const warnCrating = can('crating.ship_warning')
  const canOverride = can('checklist.override', 'edit')
  // Final checks: machines not signed (moving to Ready to ship / Shipped), or
  // built machines whose final check hasn't started (moving to Ready).
  const gateMove =
    (request.stage === 'Ready to ship' || request.stage === 'Shipped') &&
    request.order.stage !== 'Ready to ship' &&
    request.order.stage !== 'Shipped'
  const toReady = request.stage === 'Ready'
  const [notSigned, setNotSigned] = useState<string[]>([])
  const [notStarted, setNotStarted] = useState<string[]>([])
  const [overrideReason, setOverrideReason] = useState('')
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
    if (!supabase || !gateMove) return
    let cancelled = false
    supabase.rpc('checklist_gate_problems', { p_order_id: request.order.id }).then(({ data }) => {
      if (!cancelled) setNotSigned((data as string[] | null) ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [request, gateMove])

  useEffect(() => {
    if (!supabase || !toReady || !can('checklist.ready_reminder')) return
    let cancelled = false
    supabase
      .from('machine_checklist_status')
      .select('machine_type, serial_number')
      .eq('order_id', request.order.id)
      .eq('ready', true)
      .eq('status', 'not_started')
      .then(({ data }) => {
        if (cancelled) return
        setNotStarted(
          ((data as { machine_type: string; serial_number: string | null }[] | null) ?? []).map(
            (m) => `${m.machine_type}${m.serial_number ? ` ${m.serial_number}` : ''}`,
          ),
        )
      })
    return () => {
      cancelled = true
    }
  }, [request, toReady, can])

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
    const blocked = gateMove && notSigned.length > 0
    if (blocked && (!canOverride || !overrideReason.trim())) {
      setError(canOverride ? 'Enter a reason for moving on without signed final checks.' : 'Sign the final checks first, then try again.')
      return
    }
    setSaving(true)
    const args = rpcArgs(request, toShipped ? shipDate : null, toShipped && markBuilt)
    const { data, error: e } = blocked
      ? await supabase.rpc('apply_board_change_override', { ...args, p_reason: overrideReason.trim() })
      : await supabase.rpc('apply_board_change', args)
    setSaving(false)
    if (e) {
      setError(friendlyError(e))
      return
    }
    if (toReady && notStarted.length) {
      toast.warning(`Remember the final check for: ${notStarted.join(', ')}.`, { duration: 10000 })
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
                <Icon name="alert" className="mr-1 h-4 w-4" />
                {notCratedText(notCrated, request.order.machines_count)} You can still mark it as shipped and enter the crates
                later from the Order page.
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

        {!preview && !error && <p className="mt-4 text-sm text-slate-500">Calculating the changes…</p>}

        {preview && (
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <h3 className="font-medium">Shop Queue</h3>
              <p className="mt-1">
                {!me
                  ? 'The order of the shop queue does not change.'
                  : me.new === null
                    ? `Order ${request.order.order_code} leaves the shop queue${others.length ? '; the orders behind it move up' : ''}.`
                    : me.old === null
                      ? `Order ${request.order.order_code} joins the shop queue${request.anchor ? ` ${request.place === 'before' ? 'above' : 'below'} order ${request.anchor.order_code}` : ' at the end'}.`
                      : `Order ${request.order.order_code} moves ${me.new < me.old ? 'up' : 'down'} the queue${request.anchor ? `, ${request.place === 'before' ? 'above' : 'below'} order ${request.anchor.order_code}` : ''}.`}
              </p>
              {me && (
                <p className="mt-1 text-xs text-slate-500">
                  Promised ship dates and department deadlines do not change by themselves. If the new queue gives
                  different dates, they appear as suggestions on the Order page and the Dashboard, where they can be accepted or kept.
                </p>
              )}
            </div>

            {(preview.numbers?.length ?? 0) > 0 && (
              <div>
                <h3 className="font-medium">Order Numbers</h3>
                <p className="mt-1 text-slate-600">
                  A cancelled order gives its number back: it is called “C-” plus its old number, and every later order
                  moves down by one number. Customers may need to be told about the new numbers.
                </p>
                <ul className="mt-2 grid gap-x-6 tabular-nums sm:grid-cols-2">
                  {preview.numbers!.map((n) => (
                    <li key={n.old}>
                      Order {n.old} → <strong>{n.new}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h3 className="font-medium">Serial Numbers</h3>
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

        <Can permission="checklist.ready_reminder">
          {toReady && notStarted.length > 0 && (
            <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900" role="status">
              Final check not started yet for: <strong>{notStarted.join(', ')}</strong>. Start it from the order page or
              the machine chip on the board.
            </div>
          )}
        </Can>

        {gateMove && notSigned.length > 0 && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
            <p>
              Every machine’s final check must be signed first. Not signed yet: <strong>{notSigned.join(', ')}</strong>.
            </p>
            <Can permission="checklist.override" level="edit">
              <label className="mt-3 block">
                <span className="mb-1 block font-medium">Move anyway? Enter a reason (it is recorded):</span>
                <textarea
                  rows={2}
                  className={inputClass}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="For example: the customer is checking the machine at pick-up"
                />
              </label>
            </Can>
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
            disabled={!preview || saving || (gateMove && notSigned.length > 0 && (!canOverride || !overrideReason.trim()))}
          >
            {saving ? 'Saving…' : gateMove && notSigned.length > 0 ? 'Override and Move' : 'Confirm Move'}
          </button>
        </div>
      </div>
    </div>
  )
}
