// @permission-scope dashboard.widget.my_work
/* Drawn only inside a widget frame that checked dashboard.widget.my_work (and boards). The timer buttons need boards.card.timing (edit) and edit access to the board; the database checks both again. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import Icon from '../Icon'
import { useAuth } from '../../lib/auth'
import { activeSeconds, formatDuration, openPause, pausesOf, type Pause } from '../../lib/boards'
import { askText } from '../../lib/confirm'
import type { DashData } from '../../lib/dashboardData'
import { showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import type { Widget } from '../../lib/widgets'
import { ACTION } from '../../lib/wording'

type WorkCard = {
  id: string
  title: string
  due_date: string | null
  board_id: string
  stage_id: string
  card_kind: string
  started_at: string | null
  finished_at: string | null
}
type WorkItem = { id: string; checklist_id: string; item_text: string; sort_order: number; started_at: string | null; finished_at: string | null; parent_id: string | null }
type Work = {
  cards: WorkCard[]
  /** Open tasks per card (production cards: only the current stage's). */
  items: Map<string, WorkItem[]>
  pauses: Pause[]
  boards: Map<string, string>
  stages: Map<string, string>
  /** Boards where the person may press the buttons (edit level). */
  editable: Set<string>
}

const now = () => new Date().toISOString()

/** Tables whose changes refresh this widget at once (row security decides what reaches each person). */
const LIVE = ['board_cards', 'board_checklist_items', 'board_time_pauses', 'board_card_assignees']

async function loadWork(email: string, data: DashData): Promise<Work> {
  const db = supabase!
  const a = await db.from('board_card_assignees').select('card_id').eq('user_email', email)
  if (a.error) throw a.error
  const ids = ((a.data as { card_id: string }[] | null) ?? []).map((r) => r.card_id).slice(0, 300)
  const empty: Work = { cards: [], items: new Map(), pauses: [], boards: new Map(), stages: new Map(), editable: new Set() }
  if (!ids.length) return empty
  const [c, boards] = await Promise.all([
    db.from('board_cards').select('id, title, due_date, board_id, stage_id, card_kind, started_at, finished_at').in('id', ids).eq('archived', false).is('finished_at', null),
    data.boards(),
  ])
  if (c.error) throw c.error
  const names = new Map(boards.map((b) => [b.id, b.name]))
  const cards = ((c.data as WorkCard[] | null) ?? []).filter((x) => names.has(x.board_id)).sort((x, y) => (x.due_date ?? '9999').localeCompare(y.due_date ?? '9999') || x.title.localeCompare(y.title))
  if (!cards.length) return empty
  const cardIds = cards.map((x) => x.id)
  const boardIds = [...new Set(cards.map((x) => x.board_id))]
  const [lists, pauses, stages, levels] = await Promise.all([
    db.from('board_checklists').select('id, card_id, stage_id').in('card_id', cardIds),
    db.from('board_time_pauses').select('*').in('card_id', cardIds).order('paused_at'),
    db.from('board_stages').select('id, name').in('id', [...new Set(cards.map((x) => x.stage_id))]),
    Promise.all(boardIds.map(async (b) => [b, ((await db.rpc('board_level', { p_board: b })).data as number | null) ?? 0] as const)),
  ])
  const byCard = new Map(cards.map((x) => [x.id, x]))
  // Production machine cards: only the checklists of the stage the card is in.
  const current = ((lists.data as { id: string; card_id: string; stage_id: string | null }[] | null) ?? []).filter((l) => {
    const card = byCard.get(l.card_id)
    return card && (card.card_kind !== 'machine' || l.stage_id === card.stage_id)
  })
  const listCard = new Map(current.map((l) => [l.id, l.card_id]))
  const items = new Map<string, WorkItem[]>()
  if (current.length) {
    const it = await db
      .from('board_checklist_items')
      .select('id, checklist_id, item_text, sort_order, started_at, finished_at, parent_id')
      .in('checklist_id', current.map((l) => l.id))
      .is('finished_at', null)
      .order('sort_order')
    for (const row of (it.data as WorkItem[] | null) ?? []) {
      const card = listCard.get(row.checklist_id)!
      items.set(card, [...(items.get(card) ?? []), row])
    }
  }
  return {
    cards,
    items,
    pauses: (pauses.data as Pause[] | null) ?? [],
    boards: names,
    stages: new Map(((stages.data as { id: string; name: string }[] | null) ?? []).map((s) => [s.id, s.name])),
    editable: new Set(levels.filter(([, l]) => l >= 2).map(([b]) => b)),
  }
}

/** "My Work": the cards assigned to me and their open tasks, with Start / Pause / Resume / Finish and pause notes. */
export default function MyWorkWidget({ widget, data, print }: { widget: Widget; data: DashData; print?: boolean }) {
  const { session } = useAuth()
  const { can } = usePermissions()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [work, setWork] = useState<Work | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const timer = useRef<number | undefined>(undefined)

  const reload = useCallback(async () => {
    if (!supabase || !me) return
    try {
      setWork(await loadWork(me, data))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [me, data])

  useEffect(() => {
    // reload() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    reload()
  }, [reload])

  // Live: any change to cards, tasks, pauses or assignments reloads this widget within a second.
  useEffect(() => {
    if (!supabase || print) return
    const bump = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(reload, 700)
    }
    let ch = supabase.channel(`my-work-${widget.id}-${Math.random().toString(36).slice(2)}`)
    for (const t of LIVE) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, bump)
    ch.subscribe()
    // Running timers count up on the screen.
    const every = window.setInterval(() => setTick((n) => n + 1), 30000)
    return () => {
      window.clearTimeout(timer.current)
      window.clearInterval(every)
      supabase?.removeChannel(ch)
    }
  }, [reload, widget.id, print])

  if (failed) return <p className="py-3 text-sm text-slate-500">This could not be loaded. It will try again at the next refresh.</p>
  if (!work) return <p className="py-3 text-sm text-slate-500">Loading…</p>
  const board = widget.filters?.board
  const cards = work.cards.filter((c) => !board || c.board_id === board).slice(0, widget.limit ?? 8)
  if (!cards.length) return <p className="py-3 text-sm text-slate-500">No open cards are assigned to you.</p>
  const today = todayISO()

  async function run(key: string, fn: () => PromiseLike<{ error: unknown }>, ok?: string) {
    setBusy(key)
    const { error } = await fn()
    setBusy(null)
    if (error) return toast.error(friendlyError(error as Error))
    if (ok) toast.success(ok)
    reload()
  }
  const setCard = (c: WorkCard, patch: Partial<WorkCard>, ok?: string) => run(c.id, () => supabase!.from('board_cards').update(patch).eq('id', c.id), ok)
  const setItem = (it: WorkItem, patch: Partial<WorkItem>, ok?: string) => run(it.id, () => supabase!.from('board_checklist_items').update(patch).eq('id', it.id), ok)
  async function pause(c: WorkCard, it: WorkItem | null) {
    const note = await askText('Pause the timer. Add a note if you like, for example “waiting for parts”.', { label: 'Note (optional)', confirmLabel: ACTION.pause })
    if (note === null) return
    run(it?.id ?? c.id, () => supabase!.rpc('pause_board_timer', { p_card: c.id, p_item: it?.id ?? null, p_note: note.trim() || null }))
  }
  const resume = (c: WorkCard, it: WorkItem | null) => run(it?.id ?? c.id, () => supabase!.rpc('resume_board_timer', { p_card: c.id, p_item: it?.id ?? null }))

  const small = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-50'
  /** Status words and the buttons of one timer (a card's own or one task's). */
  const timerControls = (c: WorkCard, it: WorkItem | null) => {
    const started = it ? it.started_at : c.started_at
    const finished = it ? it.finished_at : c.finished_at
    const ps = pausesOf(work.pauses, c.id, it?.id ?? null)
    const paused = openPause(work.pauses, c.id, it?.id ?? null, started, finished)
    const machine = c.card_kind === 'machine' && !it
    const mayPress = !print && work.editable.has(c.board_id)
    const disabled = busy === (it?.id ?? c.id)
    const status = !started ? 'Not started' : paused ? `Paused at ${formatDuration(activeSeconds(started, finished, ps))}` : `Running for ${formatDuration(activeSeconds(started, finished, ps))}`
    return (
      <Can permission="boards.card.timing">
        <span className={`text-xs ${paused ? 'font-medium text-amber-800' : started ? 'text-green-800' : 'text-slate-500'}`}>
          {started && <Icon name="timer" className="mr-0.5 inline h-3.5 w-3.5" />}
          {status}
          {paused?.note && <span className="text-slate-700"> · {paused.note}</span>}
        </span>
        {mayPress && (
          <Can permission="boards.card.timing" level="edit">
            <span className="flex flex-wrap gap-1">
              {!started && (
                <button type="button" className={small} disabled={disabled} onClick={() => (it ? setItem(it, { started_at: now() }) : setCard(c, { started_at: now() }))}>
                  {machine ? 'Start Stage' : ACTION.start}
                </button>
              )}
              {started &&
                (paused ? (
                  <button type="button" className={small} disabled={disabled} onClick={() => resume(c, it)}>
                    {ACTION.resume}
                  </button>
                ) : (
                  <button type="button" className={small} disabled={disabled} onClick={() => pause(c, it)}>
                    {ACTION.pause}
                  </button>
                ))}
              {started && (
                <button
                  type="button"
                  className={small}
                  disabled={disabled}
                  onClick={() => (it ? setItem(it, { finished_at: now() }, 'Task completed.') : setCard(c, { finished_at: now() }, machine ? 'Stage finished.' : 'Card finished.'))}
                >
                  {machine ? 'Finish Stage' : ACTION.finish}
                </button>
              )}
            </span>
          </Can>
        )}
      </Can>
    )
  }

  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {cards.map((c) => {
        const open = can('boards.card.open')
        const tasks = work.items.get(c.id) ?? []
        const late = c.due_date && c.due_date < today
        return (
          <li key={c.id} className="py-2">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1">
                {open ? (
                  <Link to={`/boards/${c.board_id}?card=${c.id}`} className="block truncate font-medium hover:underline">
                    {c.title}
                  </Link>
                ) : (
                  <span className="block truncate font-medium">{c.title}</span>
                )}
                <span className="block truncate text-xs text-slate-500">
                  {work.boards.get(c.board_id)}
                  {work.stages.get(c.stage_id) && ` · ${work.stages.get(c.stage_id)}`}
                </span>
              </span>
              <span className={`shrink-0 text-xs ${late ? 'font-semibold text-red-700' : 'text-slate-600'}`}>{c.due_date ? `Due ${showDate(c.due_date, 'MMM d')}` : 'No due date'}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {timerControls(c, null)}
              {open && !print && (
                <Link to={`/boards/${c.board_id}?card=${c.id}`} className="text-xs text-blue-700 underline">
                  Open Card
                </Link>
              )}
            </div>
            {tasks.length > 0 && (
              <Can permission="boards.card.checklists">
                <ul className="mt-1.5 space-y-1 border-l-2 border-slate-200 pl-2">
                  {tasks.slice(0, 6).map((it) => (
                    <li key={it.id} className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${it.parent_id ? 'pl-4' : ''}`}>
                      <span className="min-w-[8rem] flex-1 text-slate-800 [overflow-wrap:anywhere]">{it.item_text}</span>
                      {timerControls(c, it)}
                    </li>
                  ))}
                  {tasks.length > 6 && (
                    <li className="text-xs text-slate-500">
                      {tasks.length - 6} more open task{tasks.length - 6 === 1 ? '' : 's'}
                      {open && (
                        <>
                          {' · '}
                          <Link to={`/boards/${c.board_id}?card=${c.id}`} className="underline">
                            Open Card
                          </Link>
                        </>
                      )}
                    </li>
                  )}
                </ul>
              </Can>
            )}
          </li>
        )
      })}
    </ul>
  )
}
