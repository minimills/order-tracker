// @permission-scope orders.board
import type { DragEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { countryFlag } from '../../lib/country'
import { showDate } from '../../lib/dates'
import { usePermissions } from '../../lib/permissions'
import { stageLabel } from '../../lib/stages'
import { STAGES, type OrderSummaryRow, type Stage } from '../../lib/types'
import Can from '../Can'
import { badgeClass, orderBadges, type Badge } from './badges'
import MachineChips, { type ChipMachine } from './MachineChips'
import { DEADLINE_TONE, STEP_LABEL, type PromisedItem } from '../../lib/schedule'

type Props = {
  order: OrderSummaryRow
  /** This order's machines, for the chips. */
  machines: ChipMachine[]
  /** The next promised department deadline (amber = close, red = missed). */
  deadline?: PromisedItem | null
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onChangeStage: (stage: Stage) => void
  /** Stages this person may move the order to (empty = no "Move to…"). */
  stageChoices: Stage[]
  /** Dragging is on when the person may move cards. */
  draggable: boolean
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  dropHint: 'before' | 'after' | null
  dragging: boolean
}

/* @layout-helper */
function Badges({ badges, kind }: { badges: Badge[]; kind: Badge['kind'] }) {
  return (
    <>
      {badges
        .filter((b) => b.kind === kind)
        .map((b) => (
          <span key={b.label} className={`rounded px-1.5 py-0.5 text-xs font-medium ring-1 ${badgeClass[b.tone]}`}>
            {b.label}
          </span>
        ))}
    </>
  )
}

/** One order on the board. Drag it, or use the buttons (handy on a phone). */
export default function OrderCard(props: Props) {
  const { order: o, dropHint } = props
  const flag = countryFlag(o.customer_country)
  const badges = orderBadges(o)
  const allReady = o.machines_count > 0 && o.machines_ready_count === o.machines_count
  const STAGE_SET = new Set(props.stageChoices)
  const { can } = usePermissions()
  const navigate = useNavigate()
  // The whole card opens the order; buttons, menus, links and chips keep their own job.
  const opens = can('order.page')
  const openOrder = (e: { target: EventTarget | null }) => {
    if (!opens) return
    const el = e.target as HTMLElement | null
    if (el?.closest('button, a, select, input, label, [role="tooltip"]')) return
    navigate(`/orders/${o.id}`)
  }

  return (
    <div
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onClick={openOrder}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) openOrder(e)
      }}
      tabIndex={opens ? 0 : undefined}
      aria-label={opens ? `Order ${o.order_code}, open` : undefined}
      className={`relative rounded-md border border-slate-200 bg-white p-3 text-sm shadow-sm ${opens ? 'cursor-pointer hover:border-slate-400 hover:shadow focus:ring-2 focus:ring-blue-400 focus:outline-none' : ''} ${
        props.draggable ? 'cursor-grab active:cursor-grabbing' : ''
      } ${props.dragging ? 'opacity-40' : ''}`}
    >
      {dropHint === 'before' && <div className="absolute -top-1.5 right-0 left-0 h-1 rounded bg-blue-500" />}
      {dropHint === 'after' && <div className="absolute right-0 -bottom-1.5 left-0 h-1 rounded bg-blue-500" />}

      <div className="flex items-start justify-between gap-2">
        <Can permission="order.page" fallback={<span className="font-semibold">Order {o.order_code}</span>}>
          <Link to={`/orders/${o.id}`} className="font-semibold hover:underline" draggable={false}>
            Order {o.order_code}
          </Link>
        </Can>
        <Can permission="orders.board.card.built">
          <span className={`shrink-0 text-xs ${allReady ? 'font-medium text-green-700' : 'text-slate-500'}`}>
            {o.machines_ready_count}/{o.machines_count} ready
          </span>
        </Can>
      </div>

      <div className="mt-1 truncate" title={o.customer_company ?? undefined}>
        <Can permission="orders.board.card.customer">{o.customer_name}</Can>
        <Can permission="orders.board.card.company">
          {o.customer_company && <span className="text-slate-500"> · {o.customer_company}</span>}
        </Can>
      </div>
      <Can permission="orders.board.card.country">
        <div className="text-xs text-slate-500">
          {flag && <span className="mr-1">{flag}</span>}
          {o.customer_country ?? 'Country not set'}
        </div>
      </Can>
      <Can permission="orders.board.card.machines">
        <MachineChips
          machines={props.machines}
          showStatus={can('orders.board.card.chip_status')}
          showCrated={can('crating')}
          showSerials={can('orders.board.card.chip_serials')}
        />
      </Can>
      <Can permission="orders.board.card.ship_date">
        <div className="mt-1 text-xs text-slate-600">
          {o.stage === 'Shipped' ? <>Shipped {showDate(o.actual_ship_date)}</> : <>Ship by {showDate(o.expected_ship_date)}</>}
        </div>
      </Can>

      {props.deadline && (
        <Can permission="orders.board.card.deadline">
          <div className="mt-1 text-xs">
            <span className={`rounded px-1.5 py-0.5 ring-1 ${DEADLINE_TONE[props.deadline.state]}`}>
              {props.deadline.state === 'missed' ? 'Missed: ' : 'Next: '}
              {STEP_LABEL[props.deadline.step]} {showDate(props.deadline.due, 'MMM d')}
            </span>
          </div>
        </Can>
      )}

      {badges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 empty:hidden">
          <Can permission="orders.board.card.badge_voltage">
            <Badges badges={badges} kind="voltage" />
          </Can>
          <Can permission="orders.board.card.badge_payment">
            <Badges badges={badges} kind="payment" />
          </Can>
          <Can permission="orders.board.card.badge_ship_date">
            <Badges badges={badges} kind="ship_date" />
          </Can>
        </div>
      )}

      {(props.canMoveUp || props.canMoveDown || STAGE_SET.size > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
          <Can permission="orders.board.reorder" level="edit">
            {(props.canMoveUp || props.canMoveDown) && (
              <>
                <button
                  type="button"
                  onClick={props.onMoveUp}
                  disabled={!props.canMoveUp}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-40"
                  title="Move up the queue"
                >
                  ↑ Up
                </button>
                <button
                  type="button"
                  onClick={props.onMoveDown}
                  disabled={!props.canMoveDown}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-40"
                  title="Move down the queue"
                >
                  ↓ Down
                </button>
              </>
            )}
          </Can>
          {STAGE_SET.size > 0 && (
            <Can permission="orders.board.change_stage" level="edit">
              <select
                aria-label={`Move order ${o.order_code} to`}
                className="ml-auto rounded border border-slate-300 bg-white px-1 py-0.5 text-xs"
                value=""
                onChange={(e) => e.target.value && props.onChangeStage(e.target.value as Stage)}
              >
                <option value="">Move to…</option>
                {STAGES.filter((s) => s !== o.stage && STAGE_SET.has(s)).map((s) => (
                  <option key={s} value={s}>
                    {stageLabel(s)}
                  </option>
                ))}
              </select>
            </Can>
          )}
        </div>
      )}
    </div>
  )
}
