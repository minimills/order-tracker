import type { ServiceCallInfo } from './service'
/**
 * Kanban boards (migration 0023): row types and small helpers shared by the
 * Boards page, the board page, the card window and the admin pages.
 * Board access (owner / shared / admin) is worked out by the database
 * (`board_level()`); permissions decide which parts each person sees.
 */
import { addDays, differenceInCalendarDays, parseISO } from 'date-fns'
import { supabase } from './supabase'
import { richTextInline } from './richText'
import { tr } from '../i18n'

export type ChecklistPreset = { title: string; items: string[] }

export type Board = {
  id: string
  name: string
  description: string | null
  colour: string
  owner_email: string | null
  purpose: string
  template_id: string | null
  /** Production boards: the order this board is for. */
  order_id: string | null
  checklist_presets: ChecklistPreset[]
  due_soon_days: number
  archived: boolean
  created_at: string
  /** 0050: every board has a number ("Board 12"). */
  board_number?: number
  /** 0050: closed boards leave the Boards page and can only be viewed until reopened. */
  closed_at?: string | null
  closed_by_name?: string | null
  close_reason?: 'shipped' | 'manual' | null
}
/** What a production stage means (deadline, build checklist, step times). */
export type ProductionStep = 'fabrication' | 'pickup' | 'sandblasting' | 'powder_coating' | 'assembly' | 'final_check' | 'crating' | 'shipping' | 'other'
export type Stage = { id: string; board_id: string; name: string; sort_order: number; archived: boolean; step: ProductionStep | null; department_id: string | null }
export type Label = { id: string; board_id: string; name: string; colour: string; sort_order: number; archived: boolean }
export type Card = {
  id: string
  board_id: string
  stage_id: string
  title: string
  description: string | null
  due_date: string | null
  sort_order: number
  order_id: string | null
  customer_id: string | null
  machine_id: string | null
  started_at: string | null
  started_by_name: string | null
  finished_at: string | null
  finished_by_name: string | null
  archived: boolean
  created_at: string
  created_by_name: string | null
  /** task = an ordinary card; machine = one machine on a production board; leftover = its unfinished items. */
  card_kind: 'task' | 'machine' | 'leftover' | 'service'
  leftover_of: string | null
  /** 0038: free-text link ("Linked to") and the customer label. */
  link_text?: string | null
  customer_label?: string | null
}
export type Checklist = { id: string; card_id: string; title: string; sort_order: number; stage_id: string | null; merge_into: string | null }
export type ChecklistItem = {
  id: string
  checklist_id: string
  item_text: string
  sort_order: number
  started_at: string | null
  started_by_name: string | null
  finished_at: string | null
  finished_by_name: string | null
  template_item_id?: string | null
  /** 0038: a sub-task of this item (one level only). */
  parent_id?: string | null
  /** 0050: who does it and by when (assigned_auto = from Admin → Production Assignments). */
  assignee_email?: string | null
  due_date?: string | null
  assigned_auto?: boolean
}
/** One pause of a card's timer (item_id empty) or a task's (0038). */
export type Pause = {
  id: string
  card_id: string
  item_id: string | null
  paused_at: string
  paused_by_name: string | null
  note: string | null
  resumed_at: string | null
  resumed_by_name: string | null
}
export type Person = { email: string; name: string }
export type ShareType = 'user' | 'group' | 'department' | 'everyone'
export type ShareLevel = 'view' | 'edit' | 'manage'
export type Share = { id: string; board_id: string; share_type: ShareType; target: string | null; level: ShareLevel }
export type NotifyEvent = 'card_created' | 'card_moved' | 'assigned' | 'due_soon' | 'overdue' | 'comment'
export type NotifyTarget = ShareType | 'assignees'
export type NotifyRule = {
  id: string
  board_id: string
  event: NotifyEvent
  stage_id: string | null
  target_type: NotifyTarget
  target: string | null
  channels: string[]
}
export type BoardTemplate = {
  id: string
  name: string
  description: string | null
  colour: string
  stages: string[]
  labels: { name: string; colour: string }[]
  checklists: ChecklistPreset[]
  archived: boolean
}
export type CardEvent = { id: number; card_id: string; kind: string; details: Record<string, unknown>; actor_name: string | null; created_at: string }
export type Comment = { id: string; card_id: string; body: string; author_email: string | null; author_name: string | null; created_at: string; edited_at: string | null }
export type Group = { id: string; name: string; description: string | null; archived: boolean }

/** 0 = none, 1 = view, 2 = edit (cards), 3 = manage (settings, sharing, notifications). */
export type BoardLevel = 0 | 1 | 2 | 3

export const BOARD_COLOURS = ['#2563eb', '#0891b2', '#059669', '#65a30d', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#475569']
export const LABEL_COLOURS = ['#dc2626', '#d97706', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#64748b']

export const SHARE_LEVEL_TEXT: Record<ShareLevel, string> = {
  get view() {
    return tr("Can view")
  },
  get edit() {
    return tr("Can work on cards")
  },
  get manage() {
    return tr("Can manage the board")
  },
}

export const NOTIFY_EVENTS: { value: NotifyEvent; label: string }[] = [
  { value: 'card_created', get label() {
    return tr("A card is created")
  } },
  { value: 'card_moved', get label() {
    return tr("A card is moved to…")
  } },
  { value: 'assigned', get label() {
    return tr("Someone is assigned to a card")
  } },
  { value: 'due_soon', get label() {
    return tr("A card is due soon")
  } },
  { value: 'overdue', get label() {
    return tr("A card is overdue")
  } },
  { value: 'comment', get label() {
    return tr("Someone adds a comment")
  } },
]

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------
export type DueState = 'done' | 'late' | 'soon' | 'ok'
/** Late = past and not finished; soon = within the board's "due soon" days. */
export function dueState(due: string | null, today: string, soonDays: number, finished: boolean): DueState | null {
  if (!due) return null
  if (finished) return 'done'
  if (due < today) return 'late'
  return due <= addDays(parseISO(today), soonDays).toISOString().slice(0, 10) ? 'soon' : 'ok'
}
export const DUE_TONE: Record<DueState, string> = {
  done: 'bg-green-50 text-green-800 ring-green-200',
  late: 'bg-red-50 text-red-800 ring-red-300',
  soon: 'bg-amber-50 text-amber-900 ring-amber-300',
  ok: 'bg-slate-50 text-slate-700 ring-slate-200',
}
export function dueWords(due: string, today: string) {
  const d = differenceInCalendarDays(parseISO(due), parseISO(today))
  if (d === 0) return tr("due today")
  if (d === 1) return tr("due tomorrow")
  if (d < 0) return tr("{{value}} day{{value2}} late", { value: -d, value2: d === -1 ? '' : 's' })
  return tr("due in {{d}} days", { d: d })
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------
/** 0 → "under a minute", 4500 → "1 h 15 min", 200000 → "2 d 7 h". */
export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || seconds < 0) return '—'
  if (seconds < 60) return tr("under a minute")
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
  const d = Math.floor(h / 24)
  return `${d} d${h % 24 ? ` ${h % 24} h` : ''}`
}
export const secondsBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)

/** Pauses of one timer: the card's own (itemId null) or one task's, oldest first. */
export const pausesOf = (pauses: Pause[], cardId: string, itemId: string | null) =>
  pauses.filter((p) => p.card_id === cardId && p.item_id === itemId).sort((a, b) => a.paused_at.localeCompare(b.paused_at))

/** The pause still running, if any (only while the timer runs). */
export function openPause(pauses: Pause[], cardId: string, itemId: string | null, started: string | null, finished: string | null) {
  if (!started || finished) return null
  return pausesOf(pauses, cardId, itemId).find((p) => !p.resumed_at && p.paused_at >= started) ?? null
}

/** Active seconds between Start and Finish (or now): paused time is not counted. */
export function activeSeconds(started: string, finished: string | null, pauses: Pause[]) {
  const from = new Date(started).getTime()
  const to = finished ? new Date(finished).getTime() : Date.now()
  const paused = pauses.reduce((sum, p) => {
    const a = Math.max(new Date(p.paused_at).getTime(), from)
    const b = Math.min(p.resumed_at ? new Date(p.resumed_at).getTime() : Date.now(), to)
    return sum + Math.max(0, b - a)
  }, 0)
  return Math.max(0, Math.round((to - from - paused) / 1000))
}

/** Customer label text: "Company (or name) – City/State, Country". */
export function customerLabelText(c: { name: string; company: string | null; state_province: string | null; country: string | null }) {
  const who = c.company?.trim() || c.name.trim()
  const place = [c.state_province?.trim(), c.country?.trim()].filter(Boolean).join(', ')
  return place ? `${who} – ${place}` : who
}
/** A time to send for Start / Finish (the database stamps its own time). */
export const stampNow = () => new Date().toISOString()
export const taskKey = (text: string) => text.trim().toLowerCase()

/** Average time of the same task on other cards (from the board_task_times view). */
export type TaskTime = { kind: 'card' | 'task'; task_key: string; source_id: string; seconds: number }
export function averageFor(times: TaskTime[], kind: TaskTime['kind'], key: string, exceptId: string) {
  const same = times.filter((t) => t.kind === kind && t.task_key === key && t.source_id !== exceptId)
  if (!same.length) return null
  return { seconds: Math.round(same.reduce((a, t) => a + Number(t.seconds), 0) / same.length), count: same.length }
}

// ---------------------------------------------------------------------------
// Little things
// ---------------------------------------------------------------------------
export function initials(name: string) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Checklist progress over all of a card's checklists. */
export function progress(items: ChecklistItem[]) {
  const done = items.filter((i) => i.finished_at).length
  return { done, total: items.length, percent: items.length ? Math.round((done / items.length) * 100) : 0 }
}

/** Text colour that reads well on a label colour. */
export function textOn(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.6 ? '#0f172a' : '#ffffff'
}

/** One line of card history in plain words. */
export function eventText(e: CardEvent) {
  const d = e.details as Record<string, string | number | null>
  switch (e.kind) {
    case 'created': return tr("Card added to {{stage}}", { stage: d.stage })
    case 'moved': return tr("Moved from {{from}} to {{to}}", { from: d.from, to: d.to })
    case 'renamed': return tr("Renamed from “{{old}}” to “{{new}}”", { old: d.old, new: d.new })
    case 'description': return tr("Description changed")
    case 'due': return d.new ? tr("Due date set to {{new}}{{value}}", { new: d.new, value: d.old ? tr(" (was {{old}})", { old: d.old }) : '' }) : tr("Due date removed")
    case 'linked': return [d.order && `Linked to order ${d.order}`, d.customer && `customer ${d.customer}`, d.machine && `machine ${d.machine}`].filter(Boolean).join(', ') || tr("Link removed")
    case 'started': return 'Started'
    case 'finished': return tr("Finished (took {{formatDuration}})", { formatDuration: formatDuration(Number(d.seconds)) })
    case 'timing_reset': return tr("Start / Finish cleared")
    case 'archived': return 'Archived'
    case 'restored': return tr("Restored from the archive")
    case 'assigned': return tr("{{name}} assigned to the card", { name: d.name })
    case 'unassigned': return tr("{{name}} removed from the card", { name: d.name })
    case 'label_added': return tr("Label “{{name}}” added", { name: d.name })
    case 'label_removed': return tr("Label “{{name}}” removed", { name: d.name })
    case 'checklist_added': return tr("Checklist “{{title}}” added", { title: d.title })
    case 'checklist_removed': return tr("Checklist “{{title}}” removed", { title: d.title })
    case 'task_started': return `Started “${d.task}”`
    case 'task_done': return `Finished “${d.task}”${d.seconds != null ? ` (took ${formatDuration(Number(d.seconds))})` : ''}`
    case 'task_reopened': return tr("Marked “{{task}}” incomplete", { task: d.task })
    case 'paused': return `Paused${d.task ? ` “${d.task}”` : tr(" the timer")}${d.note ? `: ${d.note}` : ''}`
    case 'resumed': return `Resumed${d.task ? ` “${d.task}”` : tr(" the timer")}${d.seconds != null ? ` after ${formatDuration(Number(d.seconds))}` : ''}`
    case 'comment': return tr("Added a comment: “{{richTextInline}}”", { richTextInline: richTextInline(String(d.excerpt ?? '')) })
    case 'leftover_split': return tr("{{number}} unfinished item{{value}} moved to a leftover card in {{stage}}", { number: d.count, value: Number(d.count) === 1 ? '' : 's', stage: d.stage })
    case 'leftover_created': return tr("Leftover card created for {{machine}} ({{stage}})", { machine: d.machine, stage: d.stage })
    case 'leftover_merged': return tr("{{number}} leftover item{{value}} merged back as completed ({{reason}})", { number: d.count, value: Number(d.count) === 1 ? '' : 's', reason: d.reason })
    case 'task_renamed': return tr("Task renamed from “{{old}}” to “{{new}}”", { old: d.old, new: d.new })
    case 'task_due': return d.new ? `“${d.task}” due ${d.new}${d.old ? ` (was ${d.old})` : ''}` : tr("Due date of “{{task}}” removed", { task: d.task })
    case 'task_assigned':
      return d.name
        ? tr("“{{task}}” assigned to {{name}}{{value}}{{value2}}{{value3}}", { task: d.task, name: d.name, value: d.old ? tr(" (was {{old}})", { old: d.old }) : '', value2: d.auto ? tr(" automatically") : '', value3: d.running ? tr("; its timer keeps running") : '' })
        : tr("Nobody assigned to “{{task}}” any more{{value}}", { task: d.task, value: d.old ? tr(" (was {{old}})", { old: d.old }) : '' })
    case 'copied_from': return tr("Copied from “{{title}}” on {{board}}", { title: d.title, board: d.board })
    case 'copied_to': return tr("Copied to {{board}} ({{stage}})", { board: d.board, stage: d.stage })
    case 'moved_board': return tr("Moved from the board {{from}} to {{to}} ({{stage}})", { from: d.from, to: d.to, stage: d.stage })
    case 'stage_time': return `Left ${d.stage}${d.auto_started || d.auto_finished ? tr(" (times filled in automatically)") : ''}`
    default: return e.kind
  }
}

/** "Board 12". */
export const boardNumberText = (b: Pick<Board, 'board_number'>) => (b.board_number ? `Board ${b.board_number}` : '')

/** The boards a person can put cards on (open, not archived), production boards first. */
export type BoardChoice = { id: string; name: string; purpose: string; board_number: number }
export async function loadBoardChoices(): Promise<BoardChoice[]> {
  if (!supabase) return []
  const { data } = await supabase.from('boards').select('id, name, purpose, board_number').eq('archived', false).is('closed_at', null)
  return ((data as BoardChoice[]) ?? []).sort(
    (a, b) => Number(b.purpose === 'production') - Number(a.purpose === 'production') || a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
}

/** Everything the board page shows (one load). */
export async function loadBoard(id: string, opts: { comments: boolean; timing?: boolean }) {
  if (!supabase) throw new Error(tr("Not connected"))
  const [b, lvl, st, lb, cards, people] = await Promise.all([
    supabase.from('boards').select('*').eq('id', id).maybeSingle(),
    supabase.rpc('board_level', { p_board: id }),
    supabase.from('board_stages').select('*').eq('board_id', id).order('sort_order').order('created_at'),
    supabase.from('board_labels').select('*').eq('board_id', id).order('sort_order').order('created_at'),
    supabase.from('board_cards').select('*').eq('board_id', id).eq('archived', false).order('sort_order').order('created_at'),
    supabase.rpc('board_people', { p_board: id }),
  ])
  const err = b.error ?? st.error ?? lb.error ?? cards.error
  if (err) throw err
  const cardIds = ((cards.data as Card[]) ?? []).map((c) => c.id)
  const chunk = <T,>(fn: (ids: string[]) => PromiseLike<{ data: T[] | null }>) =>
    Promise.all(Array.from({ length: Math.ceil(cardIds.length / 150) }, (_, i) => fn(cardIds.slice(i * 150, i * 150 + 150)))).then((r) =>
      r.flatMap((x) => x.data ?? []),
    )
  const [cardLabels, assignees, checklists, comments, pauses] = await Promise.all([
    chunk<{ card_id: string; label_id: string }>((ids) => supabase!.from('board_card_labels').select('card_id, label_id').in('card_id', ids)),
    chunk<{ card_id: string; user_email: string }>((ids) => supabase!.from('board_card_assignees').select('card_id, user_email').in('card_id', ids)),
    chunk<Checklist>((ids) => supabase!.from('board_checklists').select('*').in('card_id', ids).order('sort_order')),
    opts.comments ? chunk<{ card_id: string }>((ids) => supabase!.from('board_comments').select('card_id').in('card_id', ids)) : Promise.resolve([]),
    // Pauses (0038; empty without the timing permission or before the migration).
    opts.timing ? chunk<Pause>((ids) => supabase!.from('board_time_pauses').select('*').in('card_id', ids).order('paused_at')) : Promise.resolve([] as Pause[]),
  ])
  const listIds = checklists.map((l) => l.id)
  const items = listIds.length
    ? (
        await Promise.all(
          Array.from({ length: Math.ceil(listIds.length / 150) }, (_, i) =>
            supabase!.from('board_checklist_items').select('*').in('checklist_id', listIds.slice(i * 150, i * 150 + 150)).order('sort_order'),
          ),
        )
      ).flatMap((r) => (r.data as ChecklistItem[]) ?? [])
    : []
  // Production boards: each machine's serial, type and final check progress.
  const machineIds = [...new Set(((cards.data as Card[]) ?? []).map((c) => c.machine_id).filter(Boolean))] as string[]
  const board = b.data as Board | null
  const machines: ProductionMachine[] =
    board?.purpose === 'production' && machineIds.length
      ? (((await supabase.from('order_machine_status').select('id, serial_number, machine_type, needs_crate, checklist_status, checklist_total, checklist_completed').in('id', machineIds)).data ??
          []) as ProductionMachine[])
      : []
  // Service Calls board: customer, technician, dates and machines of each call.
  const serviceCalls: ServiceCallInfo[] =
    board?.purpose === 'service' ? (((await supabase.from('service_call_info').select('*').eq('board_id', board.id)).data ?? []) as ServiceCallInfo[]) : []
  return {
    board,
    machines,
    serviceCalls,
    level: (Number(lvl.data ?? 0) as BoardLevel),
    stages: (st.data as Stage[]) ?? [],
    labels: (lb.data as Label[]) ?? [],
    cards: (cards.data as Card[]) ?? [],
    people: (people.data as Person[]) ?? [],
    cardLabels,
    assignees,
    checklists,
    items,
    pauses,
    commentCounts: comments.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.card_id]: (acc[c.card_id] ?? 0) + 1 }), {}),
  }
}
export type BoardData = Awaited<ReturnType<typeof loadBoard>>

export type ProductionMachine = {
  id: string
  serial_number: string | null
  machine_type: string
  needs_crate: boolean | null
  checklist_status: 'not_started' | 'in_progress' | 'signed' | null
  checklist_total: number | null
  checklist_completed: number | null
}
/** A machine's production stage and % (machine_production_progress view, 0038). */
export type MachineProgress = {
  machine_id: string
  order_id: string
  card_id: string
  board_id: string
  stage_name: string
  step: string | null
  stage_number: number
  stage_count: number
  items_done: number
  items_total: number
  percent: number
}
/** "Assembly – 60%" */
export const progressText = (p: MachineProgress) => `${p.stage_name} – ${p.percent}%`

export type StageTime = {
  id: string
  stage_name: string
  step: string | null
  entered_at: string
  left_at: string | null
  started_at: string | null
  started_by_name: string | null
  finished_at: string | null
  finished_by_name: string | null
  auto_started: boolean
  auto_finished: boolean
}

/** The checklists of a card that belong to its current stage (production), or all of them. */
export function currentStageItems(data: BoardData, card: Card) {
  const lists = data.checklists.filter((l) => l.card_id === card.id && (card.card_kind !== 'machine' || l.stage_id === card.stage_id))
  return data.items.filter((i) => lists.some((l) => l.id === i.checklist_id))
}
