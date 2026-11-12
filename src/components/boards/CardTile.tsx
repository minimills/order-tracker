// @permission-scope boards
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { showDate } from '../../lib/dates'
import {
  DUE_TONE,
  dueState,
  dueWords,
  initials,
  openPause,
  progress,
  textOn,
  type Card,
  type ChecklistItem,
  type Label,
  type Pause,
  type Person,
  type ProductionMachine,
  type ProductionStep,
} from '../../lib/boards'
import SerialNumber from '../SerialNumber'
import { serviceDates, type ServiceCallInfo } from '../../lib/service'
import Can from '../Can'
import Icon from '../Icon'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Props = {
  card: Card
  labels: Label[]
  people: Person[]
  items: ChecklistItem[]
  comments: number
  linkText: string | null
  today: string
  soonDays: number
  canOpen: boolean
  draggable: boolean
  dropHint: 'before' | 'after' | null
  dragging: boolean
  onOpen: () => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  /** Production boards: the machine on a machine card, and what the card's stage is. */
  machine?: ProductionMachine | null
  stageStep?: ProductionStep | null
  /** Service Calls board: the call behind this card. */
  serviceCall?: ServiceCallInfo | null
  /** Pauses of this card's timers (0038). */
  pauses?: Pause[]
  /** One-click Mark Complete / Mark Incomplete (null = not allowed here). */
  onToggleComplete?: (() => void) | null
}

/** A card on the board: the whole card opens it; drag it to move it. */
export default function CardTile(p: Props) {
  const { card } = p
  const prog = progress(p.items)
  const due = dueState(card.due_date, p.today, p.soonDays, Boolean(card.finished_at))
  const open = () => p.canOpen && p.onOpen()
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const paused = openPause(p.pauses ?? [], card.id, null, card.started_at, card.finished_at)
  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation()
  async function startFinalCheck(e: MouseEvent) {
    e.stopPropagation()
    if (!supabase || !card.machine_id) return
    setStarting(true)
    const { error } = await supabase.rpc('start_checklist', { p_machine_id: card.machine_id })
    setStarting(false)
    if (error) return toast.error(friendlyError(error))
    navigate(`/checklists/${card.machine_id}`)
  }
  const done = Boolean(card.finished_at)
  const complete = p.onToggleComplete ? (
    <Can permission="boards.card.complete" level="edit">
      <button
        type="button"
        draggable={false}
        onClick={(e) => {
          e.stopPropagation()
          p.onToggleComplete?.()
        }}
        onKeyDown={stop}
        aria-label={done ? `Mark incomplete: ${card.title}` : `Mark complete: ${card.title}`}
        title={done ? 'Mark Incomplete' : 'Mark Complete'}
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-opacity ${
          done
            ? 'border-green-600 bg-green-600 text-white'
            : 'border-slate-400 bg-white text-transparent opacity-0 group-hover:opacity-100 hover:border-green-600 hover:text-green-600 focus:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100'
        }`}
      >
        <Icon name="check" className="h-2.5 w-2.5" />
      </button>
    </Can>
  ) : null
  return (
    <div
      role={p.canOpen ? 'button' : undefined}
      tabIndex={p.canOpen ? 0 : undefined}
      onClick={open}
      onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && open()}
      draggable={p.draggable}
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onDragOver={p.onDragOver}
      className={`group relative rounded-md border p-2.5 text-sm shadow-sm ${
        card.card_kind === 'leftover' ? 'border-dashed border-amber-400 bg-amber-50' : 'border-slate-200 bg-white'
      } ${p.canOpen ? 'cursor-pointer hover:border-slate-400' : ''} ${p.dragging ? 'opacity-40' : ''}`}
      aria-label={`Card: ${card.title}`}
    >
      {p.dropHint === 'before' && <div className="absolute -top-1.5 right-0 left-0 h-1 rounded bg-blue-500" />}
      {p.dropHint === 'after' && <div className="absolute right-0 -bottom-1.5 left-0 h-1 rounded bg-blue-500" />}
      <Can permission="boards.card.labels">
        {p.labels.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {p.labels.map((l) => (
              <span key={l.id} className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: l.colour, color: textOn(l.colour) }}>
                {l.name}
              </span>
            ))}
          </div>
        )}
      </Can>
      {card.card_kind === 'leftover' && (
        <div className="mb-1">
          <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">Leftover</span>
        </div>
      )}
      <div className="flex items-start gap-1.5">
        {complete}
        {card.card_kind === 'machine' && p.machine ? (
          <div className="min-w-0">
            <div className={`font-medium break-words ${done ? 'text-slate-500' : ''}`}>{p.machine.machine_type}</div>
            {p.machine.serial_number ? (
              <SerialNumber serial={p.machine.serial_number} className="text-xs" />
            ) : (
              <span className="text-xs text-slate-500">No serial number yet</span>
            )}
          </div>
        ) : (
          <div className={`min-w-0 font-medium break-words ${done ? 'text-slate-500' : ''}`}>{card.title}</div>
        )}
      </div>
      <Can permission="boards.card.customer_label">
        {card.customer_label && (
          <div className="mt-1">
            <span className="inline-flex max-w-full items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-900">
              <Icon name="user" className="h-3 w-3 shrink-0" />
              <span className="truncate">{card.customer_label}</span>
            </span>
          </div>
        )}
      </Can>
      {card.card_kind === 'service' && p.serviceCall && (
        <Can permission="service.calls">
          <div className="mt-1 space-y-1 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-1">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">{p.serviceCall.call_code}</span>
              {p.serviceCall.customer_name ? (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-900">{p.serviceCall.customer_name}</span>
              ) : (
                <span className="text-amber-800">No customer yet</span>
              )}
            </div>
            {p.serviceCall.machines.length > 0 && (
              <div className="flex flex-wrap gap-x-2">
                {p.serviceCall.machines.map((m) => (
                  <span key={m.machine_id}>
                    {m.machine} {m.serial && <SerialNumber serial={m.serial} />}
                  </span>
                ))}
              </div>
            )}
            {(p.serviceCall.technician_name || p.serviceCall.planned_start) && (
              <div>
                {[p.serviceCall.technician_name, serviceDates(p.serviceCall.planned_start, p.serviceCall.planned_end)].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        </Can>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 empty:hidden">
        <Can permission="boards.card.due">
          {due && card.due_date && (
            <span className={`rounded px-1.5 py-0.5 ring-1 ${DUE_TONE[due]}`} title={dueWords(card.due_date, p.today)}>
              {due === 'late' ? '! ' : ''}
              {showDate(card.due_date, 'MMM d')}
            </span>
          )}
        </Can>
        <Can permission="boards.card.timing">
          {card.started_at && !card.finished_at && !paused && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-800 ring-1 ring-blue-200">Started</span>}
          {paused && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-900 ring-1 ring-amber-300" title={paused.note ?? undefined}>
              Paused
            </span>
          )}
          {card.finished_at && <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-800 ring-1 ring-green-200">Finished</span>}
        </Can>
        <Can permission="boards.card.link">{p.linkText && <span className="rounded bg-slate-100 px-1.5 py-0.5">Linked: {p.linkText}</span>}</Can>
        <Can permission="boards.card.comments">
          {p.comments > 0 && (
            <span>
              {p.comments} comment{p.comments === 1 ? '' : 's'}
            </span>
          )}
        </Can>
      </div>
      {card.card_kind === 'machine' && p.stageStep === 'final_check' && p.machine && (
        <Can permission="order.machines.checklist">
          <div className="mt-2 text-[11px] text-slate-600">
            Final check:{' '}
            {p.machine.checklist_status === 'signed'
              ? 'complete'
              : p.machine.checklist_status === 'in_progress'
                ? `${p.machine.checklist_completed ?? 0} of ${p.machine.checklist_total ?? 0} items`
                : 'not started'}
          </div>
          {p.machine.checklist_status === 'in_progress' || p.machine.checklist_status === 'signed' ? (
            <Can permission="checklist">
              <Link
                to={`/checklists/${card.machine_id}`}
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                className="mt-1 block rounded border border-slate-300 bg-white px-2 py-1 text-center text-xs font-medium hover:bg-slate-50"
              >
                {p.machine.checklist_status === 'signed' ? 'View Final Check' : 'Continue Final Check'}
              </Link>
            </Can>
          ) : (
            <Can permission="checklist.start" level="edit">
              <button
                type="button"
                draggable={false}
                disabled={starting}
                onClick={startFinalCheck}
                onKeyDown={stop}
                className="mt-1 w-full rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {starting ? 'Starting…' : 'Start Final Check'}
              </button>
            </Can>
          )}
        </Can>
      )}
      <Can permission="boards.card.checklists">
        {prog.total > 0 && (
          <div className="mt-2" title={`${prog.done} of ${prog.total} tasks completed`}>
            <div className="flex justify-between text-[11px] text-slate-500">
              <span>
                {prog.done} of {prog.total} task{prog.total === 1 ? '' : 's'}
              </span>
              <span>{prog.percent}%</span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-slate-200">
              <div className={`h-full ${prog.percent === 100 ? 'bg-green-600' : 'bg-blue-600'}`} style={{ width: `${prog.percent}%` }} />
            </div>
          </div>
        )}
      </Can>
      <Can permission="boards.card.assignees">
        {p.people.length > 0 && (
          <div className="mt-2 flex justify-end -space-x-1.5">
            {p.people.map((x) => (
              <span
                key={x.email}
                title={x.name}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-[10px] font-semibold text-white ring-2 ring-white"
              >
                {initials(x.name)}
              </span>
            ))}
          </div>
        )}
      </Can>
    </div>
  )
}
