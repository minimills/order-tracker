import type { DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { countryFlag } from '../../lib/country'
import { showDate } from '../../lib/dates'
import { STAGES, type OrderSummaryRow, type Stage } from '../../lib/types'
import { badgeClass, orderBadges } from './badges'

type Props = {
  order: OrderSummaryRow
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onChangeStage: (stage: Stage) => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  dropHint: 'before' | 'after' | null
  dragging: boolean
}

/** One order on the board. Drag it, or use the buttons (handy on a phone). */
export default function OrderCard(props: Props) {
  const { order: o, dropHint } = props
  const flag = countryFlag(o.customer_country)
  const badges = orderBadges(o)
  const allReady = o.machines_count > 0 && o.machines_ready_count === o.machines_count

  return (
    <div
      draggable
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      className={`relative cursor-grab rounded-md border border-slate-200 bg-white p-3 text-sm shadow-sm active:cursor-grabbing ${
        props.dragging ? 'opacity-40' : ''
      }`}
    >
      {dropHint === 'before' && <div className="absolute -top-1.5 right-0 left-0 h-1 rounded bg-blue-500" />}
      {dropHint === 'after' && <div className="absolute right-0 -bottom-1.5 left-0 h-1 rounded bg-blue-500" />}

      <div className="flex items-start justify-between gap-2">
        <Link to={`/orders/${o.id}`} className="font-semibold hover:underline" draggable={false}>
          {o.board_position !== null && (
            <span className="mr-1.5 inline-block min-w-7 rounded bg-slate-900 px-1.5 text-center text-white">
              {o.board_position}
            </span>
          )}
          Order {o.order_code}
        </Link>
        <span className={`shrink-0 text-xs ${allReady ? 'font-medium text-green-700' : 'text-slate-500'}`}>
          {o.machines_ready_count}/{o.machines_count} ready
        </span>
      </div>

      <div className="mt-1 truncate" title={o.customer_company ?? undefined}>
        {o.customer_name}
        {o.customer_company && <span className="text-slate-500"> · {o.customer_company}</span>}
      </div>
      <div className="text-xs text-slate-500">
        {flag && <span className="mr-1">{flag}</span>}
        {o.customer_country ?? 'Country not set'}
      </div>
      {o.machines_list && <div className="mt-1 text-xs text-slate-600">{o.machines_list}</div>}
      <div className="mt-1 text-xs text-slate-600">
        {o.stage === 'Shipped' ? (
          <>Shipped {showDate(o.actual_ship_date)}</>
        ) : (
          <>Ship by {showDate(o.expected_ship_date)}</>
        )}
      </div>

      {badges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {badges.map((b) => (
            <span key={b.label} className={`rounded px-1.5 py-0.5 text-xs font-medium ring-1 ${badgeClass[b.tone]}`}>
              {b.label}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
        {(props.canMoveUp || props.canMoveDown) && (
          <>
            <button
              type="button"
              onClick={props.onMoveUp}
              disabled={!props.canMoveUp}
              className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-40"
              title="Move up the board"
            >
              ↑ Up
            </button>
            <button
              type="button"
              onClick={props.onMoveDown}
              disabled={!props.canMoveDown}
              className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-40"
              title="Move down the board"
            >
              ↓ Down
            </button>
          </>
        )}
        <select
          aria-label={`Move order ${o.order_code} to`}
          className="ml-auto rounded border border-slate-300 bg-white px-1 py-0.5 text-xs"
          value=""
          onChange={(e) => e.target.value && props.onChangeStage(e.target.value as Stage)}
        >
          <option value="">Move to…</option>
          {STAGES.filter((s) => s !== o.stage).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
