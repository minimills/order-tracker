import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import MoveDialog, { type MoveRequest } from '../components/board/MoveDialog'
import { ChipLegend, type ChipMachine } from '../components/board/MachineChips'
import OrderCard from '../components/board/OrderCard'
import Can from '../components/Can'
import { secondaryButtonClass } from '../components/form'
import { addDaysISO, todayISO } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { useStageLabels } from '../lib/stages'
import { supabase } from '../lib/supabase'
import { BOARD_STAGES, STAGES, type OrderSummaryRow, type Stage } from '../lib/types'

type Column = { stage: Stage; title: string; hint?: string; permission: string }

const COLUMNS: Column[] = [
  { stage: 'Quote', title: 'Quote', permission: 'orders.board.column.quote' },
  { stage: 'Confirmed', title: 'Confirmed', permission: 'orders.board.column.confirmed' },
  { stage: 'In production', title: 'In production', permission: 'orders.board.column.in_production' },
  { stage: 'Ready', title: 'Ready', permission: 'orders.board.column.ready' },
  { stage: 'Ready to ship', title: 'Ready to ship', permission: 'orders.board.column.ready_to_ship' },
  { stage: 'Shipped', title: 'Shipped', hint: 'last 30 days', permission: 'orders.board.column.shipped' },
]

type DropTarget = { stage: Stage; anchorId: string | null; place: 'before' | 'after' }

function sortColumn(stage: Stage, orders: OrderSummaryRow[]) {
  const list = orders.filter((o) => o.stage === stage)
  if (BOARD_STAGES.includes(stage)) return list.sort((a, b) => (a.board_position ?? 0) - (b.board_position ?? 0))
  if (stage === 'Shipped')
    return list.sort((a, b) => (b.actual_ship_date ?? '').localeCompare(a.actual_ship_date ?? ''))
  return list.sort((a, b) => b.order_number - a.order_number || (b.split_number ?? 0) - (a.split_number ?? 0))
}

export default function OrdersBoardPage() {
  const { can } = usePermissions()
  const canReorder = can('orders.board.reorder', 'edit')
  const canChangeStage = can('orders.board.change_stage', 'edit')
  const seesChips = can('orders.board.card.machines')
  const label = useStageLabels()
  const [machines, setMachines] = useState<Map<string, ChipMachine[]>>(new Map())
  const [orders, setOrders] = useState<OrderSummaryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [request, setRequest] = useState<MoveRequest | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const since = addDaysISO(todayISO(), -30)
    const [open, shipped] = await Promise.all([
      fetchAll<OrderSummaryRow>(() =>
        supabase!
          .from('order_summary')
          .select('*')
          .eq('archived', false)
          .in('stage', ['Quote', ...BOARD_STAGES])
          .order('id'),
      ),
      fetchAll<OrderSummaryRow>(() =>
        supabase!
          .from('order_summary')
          .select('*')
          .eq('archived', false)
          .eq('stage', 'Shipped')
          .gte('actual_ship_date', since)
          .order('id'),
      ),
    ])
    const all = [...open.data, ...shipped.data]
    // Machines for the chips (only when this person may see them).
    const byOrder = new Map<string, ChipMachine[]>()
    let machineError = null
    if (seesChips) {
      const ids = all.map((o) => o.id)
      for (let i = 0; i < ids.length; i += 150) {
        const m = await fetchAll<ChipMachine>(() =>
          supabase!.from('order_machine_status').select('*').in('order_id', ids.slice(i, i + 150)).order('id'),
        )
        machineError ??= m.error
        for (const row of m.data) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), row])
      }
    }
    const error = open.error ?? shipped.error ?? machineError
    if (error) toast.error(friendlyError(error))
    setMachines(byOrder)
    setOrders(all)
    setLoading(false)
  }, [seesChips])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  // Only the columns this person may see; queue order still comes from all orders.
  const columns = COLUMNS.filter((c) => can(c.permission)).map((c) => ({ ...c, orders: sortColumn(c.stage, orders) }))
  const byId = new Map(orders.map((o) => [o.id, o]))

  // --- Asking for a move ---------------------------------------------------
  function ask(order: OrderSummaryRow, stage: Stage | null, anchor: OrderSummaryRow | null, place: 'before' | 'after') {
    const stageChange = stage !== null && stage !== order.stage
    const where = anchor ? `${place === 'before' ? 'above' : 'below'} order ${anchor.order_code}` : ''
    const description = stageChange
      ? `move to ${label(stage)}${where ? `, ${where}` : ''}`
      : `move ${where}`
    setRequest({ order, stage: stageChange ? stage : null, anchor, place, description })
  }

  function moveWithin(order: OrderSummaryRow, direction: 'up' | 'down') {
    const list = columns.find((c) => c.stage === order.stage)!.orders
    const i = list.findIndex((o) => o.id === order.id)
    const neighbour = list[direction === 'up' ? i - 1 : i + 1]
    if (neighbour) ask(order, null, neighbour, direction === 'up' ? 'before' : 'after')
  }

  // --- Drag and drop -------------------------------------------------------
  function onCardDragOver(e: DragEvent, stage: Stage, card: OrderSummaryRow) {
    if (!dragId) return
    if (!canChangeStage && byId.get(dragId)?.stage !== stage) return
    e.preventDefault()
    e.stopPropagation()
    if (!BOARD_STAGES.includes(stage)) {
      setDropTarget({ stage, anchorId: null, place: 'after' })
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const place = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (dropTarget?.anchorId !== card.id || dropTarget.place !== place || dropTarget.stage !== stage) {
      setDropTarget({ stage, anchorId: card.id, place })
    }
  }

  function onColumnDragOver(e: DragEvent, column: (typeof columns)[number]) {
    if (!dragId) return
    if (!canChangeStage && byId.get(dragId)?.stage !== column.stage) return
    e.preventDefault()
    // Dropped on empty space: go to the end of this column.
    const last = column.orders.filter((o) => o.id !== dragId).at(-1)
    const anchorId = BOARD_STAGES.includes(column.stage) && last ? last.id : null
    if (dropTarget?.stage !== column.stage || dropTarget.anchorId !== anchorId || dropTarget.place !== 'after') {
      setDropTarget({ stage: column.stage, anchorId, place: 'after' })
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    const order = dragId ? byId.get(dragId) : undefined
    const target = dropTarget
    setDragId(null)
    setDropTarget(null)
    if (!order || !target) return
    const anchor = target.anchorId ? byId.get(target.anchorId) ?? null : null

    if (target.stage !== order.stage && !canChangeStage) return
    if (target.stage === order.stage) {
      if (!canReorder) return
      // Same column: ignore drops that would not change the order.
      if (!BOARD_STAGES.includes(order.stage) || !anchor || anchor.id === order.id) return
      const list = columns.find((c) => c.stage === order.stage)!.orders
      const i = list.findIndex((o) => o.id === order.id)
      if (target.place === 'before' && list[i + 1]?.id === anchor.id) return
      if (target.place === 'after' && list[i - 1]?.id === anchor.id) return
    }
    ask(order, target.stage, anchor, target.place)
  }

  const canDrag = canReorder || canChangeStage

  return (
    <Can permission="orders.board">
      <div className="-m-4 flex h-[calc(100%+2rem)] flex-col p-4 md:-m-8 md:h-[calc(100%+4rem)] md:p-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Orders board</h1>
            {canDrag && (
              <p className="text-sm text-slate-600">
                Drag a card to {canChangeStage ? 'change its stage or ' : ''}its place in the queue
                {canReorder ? ', or use the ↑ ↓ buttons' : ''}
                {canChangeStage ? ' and “Move to…”' : ''}.
              </p>
            )}
            <Can permission="orders.board.card.chip_status">
              <div className="mt-1">
                <ChipLegend showCrated={can('crating')} />
              </div>
            </Can>
          </div>
          <div className="flex gap-2">
            <Can permission="orders.board.refresh">
              <button type="button" className={secondaryButtonClass} onClick={load}>
                Refresh
              </button>
            </Can>
            <Can permission="shop_board">
              <Link to="/shop-board" className={secondaryButtonClass}>
                🖨 Shop board
              </Link>
            </Can>
            <Can permission="orders.new" level="edit">
              <Link to="/orders/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
                + New order
              </Link>
            </Can>
          </div>
        </div>

        {loading ? (
          <p className="text-center text-slate-500">Loading…</p>
        ) : columns.length === 0 ? (
          <p className="text-center text-slate-500">No columns of the board are switched on for you.</p>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
            {columns.map((column) => {
              const isTarget = dropTarget?.stage === column.stage
              return (
                <Can key={column.stage} permission={column.permission}>
                  <div
                    onDragOver={(e) => onColumnDragOver(e, column)}
                    onDrop={onDrop}
                    className={`flex w-72 shrink-0 flex-col rounded-lg border xl:w-auto xl:min-w-52 xl:flex-1 xl:shrink ${
                      isTarget ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-slate-100'
                    }`}
                  >
                    <div className="flex items-baseline justify-between px-3 pt-3 pb-2">
                      <h2 className="font-semibold">
                        {label(column.stage)}
                        {column.hint && <span className="ml-1 text-xs font-normal text-slate-500">({column.hint})</span>}
                      </h2>
                      <span className="text-xs text-slate-500">{column.orders.length}</span>
                    </div>
                    <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                      {column.orders.length === 0 && (
                        <p className="px-1 py-4 text-center text-xs text-slate-400">No orders</p>
                      )}
                      {column.orders.map((o, i) => {
                        const onBoard = BOARD_STAGES.includes(column.stage)
                        return (
                          <OrderCard
                            key={o.id}
                            order={o}
                            machines={machines.get(o.id) ?? []}
                            canMoveUp={canReorder && onBoard && i > 0}
                            canMoveDown={canReorder && onBoard && i < column.orders.length - 1}
                            onMoveUp={() => moveWithin(o, 'up')}
                            onMoveDown={() => moveWithin(o, 'down')}
                            onChangeStage={(stage) => ask(o, stage, null, 'after')}
                            stageChoices={canChangeStage ? [...STAGES] : []}
                            draggable={canDrag}
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = 'move'
                              e.dataTransfer.setData('text/plain', o.id)
                              setDragId(o.id)
                            }}
                            onDragEnd={() => {
                              setDragId(null)
                              setDropTarget(null)
                            }}
                            onDragOver={(e) => onCardDragOver(e, column.stage, o)}
                            dropHint={
                              dragId && dragId !== o.id && dropTarget?.anchorId === o.id ? dropTarget.place : null
                            }
                            dragging={dragId === o.id}
                          />
                        )
                      })}
                    </div>
                  </div>
                </Can>
              )
            })}
          </div>
        )}

        {request && (
          <MoveDialog
            request={request}
            onClose={() => setRequest(null)}
            onDone={(n) => {
              toast.success(
                `Order ${request.order.order_code} moved.${n ? ` ${n} serial number${n === 1 ? '' : 's'} changed.` : ''}`,
              )
              setRequest(null)
              load()
            }}
          />
        )}
      </div>
    </Can>
  )
}
