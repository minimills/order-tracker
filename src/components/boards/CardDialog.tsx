// @permission-scope boards.card.open
import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '../../lib/auth'
import {
  activeSeconds,
  averageFor,
  DUE_TONE,
  dueState,
  dueWords,
  eventText,
  formatDuration,
  initials,
  LABEL_COLOURS,
  openPause,
  pausesOf,
  progress,
  secondsBetween,
  taskKey,
  textOn,
  type BoardData,
  type BoardLevel,
  type Card,
  type CardEvent,
  type ChecklistItem,
  type Comment,
  type Pause,
  type TaskTime,
} from '../../lib/boards'
import { activityTime } from '../../lib/activity'
import { showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import RichText from '../RichText'
import RichTextEditor from '../RichTextEditor'
import { buttonClass, inputClass, narrowInputClass, secondaryButtonClass } from '../form'
import LinkPicker from './LinkPicker'
import CardNavigator from './CardNavigator'
import ColourPicker from './ColourPicker'
import CustomerLabelPicker from './CustomerLabelPicker'
import ProductionPanel from './ProductionPanel'
import ServiceCallPanel from './ServiceCallPanel'
import { askText, confirmAction } from '../../lib/confirm'
import Icon from '../Icon'

type Props = { cardId: string; data: BoardData; level: BoardLevel; onClose: () => void; onChanged: () => void; onOpenCard?: (id: string) => void }

const small = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-50'

/* @layout-helper */
function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-t border-slate-200 pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** The card window: everything about one card. Every change saves at once. */
export default function CardDialog({ cardId, data, level, onClose, onChanged, onOpenCard }: Props) {
  const { can } = usePermissions()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const today = todayISO()
  const board = data.board!
  const card = data.cards.find((c) => c.id === cardId) ?? null
  const mayEdit = level >= 2
  const [comments, setComments] = useState<Comment[]>([])
  const [events, setEvents] = useState<CardEvent[]>([])
  const [times, setTimes] = useState<TaskTime[]>([])
  const [title, setTitle] = useState(card?.title ?? '')
  const [desc, setDesc] = useState<string | null>(null) // null = not editing
  const [newComment, setNewComment] = useState('')
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null)
  const [newList, setNewList] = useState('')
  const [newItem, setNewItem] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [labelName, setLabelName] = useState('')
  const [labelColour, setLabelColour] = useState(LABEL_COLOURS[5])
  const [subFor, setSubFor] = useState<string | null>(null)
  const [subText, setSubText] = useState('')

  const thisCard = data.cards.find((c) => c.id === cardId)
  const lists = data.checklists
    .filter((l) => l.card_id === cardId)
    .sort((a, b) => Number(b.stage_id === thisCard?.stage_id) - Number(a.stage_id === thisCard?.stage_id) || a.sort_order - b.sort_order)
  const items = data.items.filter((i) => lists.some((l) => l.id === i.checklist_id))

  const loadDetails = useCallback(async () => {
    if (!supabase || !card) return
    const keys = [taskKey(card.title), ...items.map((i) => taskKey(i.item_text))]
    const [c, e, t] = await Promise.all([
      can('boards.card.comments') ? supabase.from('board_comments').select('*').eq('card_id', cardId).order('created_at') : Promise.resolve({ data: [] }),
      can('boards.card.history') ? supabase.from('board_card_events').select('*').eq('card_id', cardId).order('id', { ascending: false }).limit(200) : Promise.resolve({ data: [] }),
      can('boards.card.timing') ? supabase.from('board_task_times').select('kind, task_key, source_id, seconds').in('task_key', [...new Set(keys)]) : Promise.resolve({ data: [] }),
    ])
    setComments((c.data as Comment[]) ?? [])
    setEvents((e.data as CardEvent[]) ?? [])
    setTimes((t.data as TaskTime[]) ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, card?.title, items.length, can])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    loadDetails()
  }, [loadDetails])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && desc === null && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, desc])

  if (!card) {
    return (
      <Overlay onClose={onClose} title="Card">
        <p className="text-sm text-slate-600">This card could not be found. It may have been archived.</p>
      </Overlay>
    )
  }

  /** Runs a save, then reloads the board and this card's details. */
  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) {
    setBusy(true)
    const { error } = await fn()
    setBusy(false)
    if (error) {
      toast.error(friendlyError(error))
      return false
    }
    if (ok) toast.success(ok)
    onChanged()
    loadDetails()
    return true
  }
  const updateCard = (patch: Partial<Card>, ok?: string) => run(() => supabase!.from('board_cards').update(patch).eq('id', card.id), ok)
  const updateItem = (item: ChecklistItem, patch: Partial<ChecklistItem>) =>
    run(() => supabase!.from('board_checklist_items').update(patch).eq('id', item.id))

  const stages = data.stages.filter((s) => !s.archived)
  const inStage = data.cards.filter((c) => c.stage_id === card.stage_id)
  const pos = inStage.findIndex((c) => c.id === card.id)
  const move = (stageId: string, index: number) => run(() => supabase!.rpc('move_board_card', { p_card: card.id, p_stage: stageId, p_index: index }))
  const cardLabels = new Set(data.cardLabels.filter((l) => l.card_id === card.id).map((l) => l.label_id))
  const cardPeople = data.assignees.filter((a) => a.card_id === card.id).map((a) => a.user_email)
  const nameOf = (email: string) => data.people.find((p) => p.email === email)?.name ?? email
  const due = dueState(card.due_date, today, board.due_soon_days, Boolean(card.finished_at))
  const prog = progress(items)
  const cardAvg = averageFor(times, 'card', taskKey(card.title), card.id)

  async function addChecklist(e: FormEvent) {
    e.preventDefault()
    const preset = board.checklist_presets.find((p) => p.title === newList)
    const titleText = newList.trim()
    if (!titleText || !supabase) return
    setBusy(true)
    const { data: row, error } = await supabase
      .from('board_checklists')
      .insert({ card_id: card!.id, title: titleText, sort_order: lists.length + 1 })
      .select('id')
      .single()
    if (!error && preset?.items.length) {
      const { error: e2 } = await supabase.from('board_checklist_items').insert(preset.items.map((t, i) => ({ checklist_id: row.id, item_text: t, sort_order: i + 1 })))
      if (e2) toast.error(friendlyError(e2))
    }
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setNewList('')
    onChanged()
  }

  async function addItem(e: FormEvent, listId: string) {
    e.preventDefault()
    const text = (newItem[listId] ?? '').trim()
    if (!text) return
    if (await run(() => supabase!.from('board_checklist_items').insert({ checklist_id: listId, item_text: text }))) setNewItem((m) => ({ ...m, [listId]: '' }))
  }

  async function addComment(e: FormEvent) {
    e.preventDefault()
    if (!newComment.trim()) return
    if (await run(() => supabase!.from('board_comments').insert({ card_id: card!.id, body: newComment.trim() }))) setNewComment('')
  }

  /** Active time (pauses not counted): "1 h 15 min", or "running for …" / "paused at …" while not finished. */
  const timing = (started: string | null, finished: string | null, ps: Pause[]) => {
    if (!started) return null
    const secs = formatDuration(activeSeconds(started, finished, ps))
    if (finished) return secs
    return ps.some((p) => !p.resumed_at && p.paused_at >= started) ? `paused at ${secs}` : `running for ${secs}`
  }
  const cardPauses = pausesOf(data.pauses, card.id, null)
  const pauseTimer = async (itemId: string | null) => {
    const note = await askText('Pause the timer. Add a note if you like, for example “waiting for parts”.', { label: 'Note (optional)', confirmLabel: 'Pause' })
    if (note === null) return
    run(() => supabase!.rpc('pause_board_timer', { p_card: card.id, p_item: itemId, p_note: note.trim() || null }))
  }
  const resumeTimer = (itemId: string | null) => run(() => supabase!.rpc('resume_board_timer', { p_card: card.id, p_item: itemId }))
  /** Pause history of one timer. */
  const pauseList = (ps: Pause[]) =>
    ps.length > 0 && (
      <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600">
        {ps.map((p) => (
          <li key={p.id}>
            Paused {activityTime.format(new Date(p.paused_at))}
            {p.paused_by_name && ` by ${p.paused_by_name}`}
            {p.resumed_at ? ` · resumed ${activityTime.format(new Date(p.resumed_at))} (${formatDuration(secondsBetween(p.paused_at, p.resumed_at))})` : ' · still paused'}
            {p.note && <span className="text-slate-800"> · {p.note}</span>}
          </li>
        ))}
      </ul>
    )

  async function addLabel(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !labelName.trim()) return
    setBusy(true)
    const { data: id, error } = await supabase.rpc('add_board_label', { p_board: board.id, p_name: labelName.trim(), p_colour: labelColour })
    if (!error && can('boards.card.labels', 'edit')) await supabase.from('board_card_labels').insert({ card_id: card!.id, label_id: id })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setLabelName('')
    onChanged()
  }

  async function addSubTask(e: FormEvent, parent: ChecklistItem) {
    e.preventDefault()
    const text = subText.trim()
    if (!text) return
    if (await run(() => supabase!.from('board_checklist_items').insert({ checklist_id: parent.checklist_id, item_text: text, parent_id: parent.id }))) {
      setSubText('')
      setSubFor(null)
    }
  }

  return (
    <Overlay onClose={onClose} title={card.title} colour={board.colour}>
      {/* ---------- Title, stage, move ---------- */}
      <div className="space-y-2">
        <Can permission="boards.card.edit" level="edit" fallback={<h2 className="pr-8 text-xl font-semibold break-words">{card.title}</h2>}>
          <input
            aria-label="Card title"
            className="w-full rounded-md border border-transparent px-1 py-0.5 pr-8 text-xl font-semibold hover:border-slate-300 focus:border-slate-500 focus:outline-none disabled:bg-white"
            value={title}
            disabled={!mayEdit}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title.trim() !== card.title && updateCard({ title: title.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </Can>
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span>In</span>
          <Can
            permission="boards.card.move"
            level="edit"
            fallback={<strong>{stages.find((s) => s.id === card.stage_id)?.name}</strong>}
          >
            <select
              aria-label="Stage"
              className={`${narrowInputClass} w-auto py-1`}
              value={card.stage_id}
              disabled={!mayEdit || busy}
              onChange={(e) => move(e.target.value, data.cards.filter((c) => c.stage_id === e.target.value).length)}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className={small} disabled={!mayEdit || busy || pos <= 0} onClick={() => move(card.stage_id, pos - 1)} aria-label="Move up">
              ↑
            </button>
            <button type="button" className={small} disabled={!mayEdit || busy || pos >= inStage.length - 1} onClick={() => move(card.stage_id, pos + 1)} aria-label="Move down">
              ↓
            </button>
          </Can>
          <span className="text-xs text-slate-500">
            · added {showDate(card.created_at.slice(0, 10))}
            {card.created_by_name && ` by ${card.created_by_name}`}
          </span>
        </div>
        <Can permission="boards.card.navigate">{onOpenCard && <CardNavigator card={card} data={data} onOpenCard={onOpenCard} />}</Can>
      </div>

      <div className="mt-4 grid gap-5 md:grid-cols-[1fr_15rem]">
        <div className="min-w-0 space-y-4">
          {card.card_kind === 'service' ? (
            <ServiceCallPanel call={data.serviceCalls.find((c) => c.card_id === card.id) ?? null} />
          ) : (
            card.card_kind !== 'task' && <ProductionPanel card={card} data={data} onOpenCard={onOpenCard} />
          )}
          {/* ---------- Labels ---------- */}
          <Can permission="boards.card.labels">
            <Block title="Labels">
              <div className="flex flex-wrap gap-1.5">
                {data.labels
                  .filter((l) => !l.archived || cardLabels.has(l.id))
                  .map((l) => {
                    const on = cardLabels.has(l.id)
                    return (
                      <Can
                        key={l.id}
                        permission="boards.card.labels"
                        level="edit"
                        fallback={on ? <span className="rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: l.colour, color: textOn(l.colour) }}>{l.name}</span> : null}
                      >
                        <button
                          type="button"
                          aria-pressed={on}
                          disabled={!mayEdit || busy}
                          onClick={() =>
                            run(() =>
                              on
                                ? supabase!.from('board_card_labels').delete().eq('card_id', card.id).eq('label_id', l.id)
                                : supabase!.from('board_card_labels').insert({ card_id: card.id, label_id: l.id }),
                            )
                          }
                          className={`rounded px-2 py-0.5 text-xs font-medium ${on ? '' : 'opacity-35 hover:opacity-70'}`}
                          style={{ backgroundColor: l.colour, color: textOn(l.colour) }}
                        >
                          {on && <Icon name="check" className="mr-0.5 h-3 w-3" />}
                          {l.name}
                        </button>
                      </Can>
                    )
                  })}
                {data.labels.length === 0 && <span className="text-xs text-slate-500">This board has no labels.</span>}
              </div>
              <Can permission="boards.labels.create" level="edit">
                {mayEdit && (
                  <form onSubmit={addLabel} className="mt-2 space-y-1.5 rounded-md bg-slate-50 p-2">
                    <div className="flex gap-2">
                      <input
                        aria-label="New label name"
                        className={`${inputClass} py-1`}
                        placeholder="New label, for example Waiting for parts"
                        maxLength={40}
                        value={labelName}
                        onChange={(e) => setLabelName(e.target.value)}
                      />
                      <button type="submit" className={`${small} whitespace-nowrap`} disabled={busy || !labelName.trim()}>
                        Create Label
                      </button>
                    </div>
                    <ColourPicker colours={LABEL_COLOURS} value={labelColour} onChange={setLabelColour} label="Label colour" />
                  </form>
                )}
              </Can>
            </Block>
          </Can>

          {/* ---------- Customer label ---------- */}
          <Can permission="boards.card.customer_label">
            <Block title="Customer Label">
              <CustomerLabelPicker
                card={card}
                editable={mayEdit && can('boards.card.customer_label', 'edit')}
                busy={busy}
                onSave={(text) => updateCard({ customer_label: text })}
              />
            </Block>
          </Can>

          {/* ---------- Description ---------- */}
          <Can permission="boards.card.description">
            <Block
              title="Description"
              aside={
                desc === null && mayEdit ? (
                  <Can permission="boards.card.edit" level="edit">
                    <button type="button" className={small} onClick={() => setDesc(card.description ?? '')}>
                      Edit
                    </button>
                  </Can>
                ) : null
              }
            >
              {desc === null ? (
                <RichText value={card.description} className="text-sm" />
              ) : (
                <Can permission="boards.card.edit" level="edit">
                  <RichTextEditor label="Description" value={desc} onChange={setDesc} placeholder="What needs doing" />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy}
                      onClick={async () => (await updateCard({ description: desc || null })) && setDesc(null)}
                    >
                      Save Changes
                    </button>
                    <button type="button" className={secondaryButtonClass} onClick={() => setDesc(null)}>
                      Cancel
                    </button>
                  </div>
                </Can>
              )}
            </Block>
          </Can>

          {/* ---------- Checklists ---------- */}
          <Can permission="boards.card.checklists">
            <Block title={`Checklists${prog.total ? ` · ${prog.done} of ${prog.total} done (${prog.percent}%)` : ''}`}>
              {prog.total > 0 && (
                <div className="mb-3 h-2 overflow-hidden rounded bg-slate-200">
                  <div className={`h-full ${prog.percent === 100 ? 'bg-green-600' : 'bg-blue-600'}`} style={{ width: `${prog.percent}%` }} />
                </div>
              )}
              <div className="space-y-4">
                {lists.map((list) => {
                  const its = items.filter((i) => i.checklist_id === list.id)
                  const p = progress(its)
                  return (
                    <div key={list.id}>
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-medium">
                          {list.title} <span className="font-normal text-slate-500">· {p.percent}%</span>
                        </h4>
                        <Can permission="boards.card.checklists" level="edit">
                          {mayEdit && (
                            <button
                              type="button"
                              className="text-xs text-red-700 underline"
                              onClick={async () => (await confirmAction(`Permanently delete the checklist “${list.title}” and its tasks?`, { confirmLabel: 'Permanently Delete', danger: true })) && run(() => supabase!.from('board_checklists').delete().eq('id', list.id))}
                            >
                              Remove
                            </button>
                          )}
                        </Can>
                      </div>
                      <ul className="mt-1 divide-y divide-slate-100">
                        {its
                          .filter((it) => !it.parent_id || !its.some((p) => p.id === it.parent_id))
                          .flatMap((top) => [top, ...its.filter((c) => c.parent_id === top.id)])
                          .map((it) => {
                          const sub = Boolean(it.parent_id && its.some((p) => p.id === it.parent_id))
                          const itemPauses = pausesOf(data.pauses, card.id, it.id)
                          const paused = openPause(data.pauses, card.id, it.id, it.started_at, it.finished_at)
                          const avg = averageFor(times, 'task', taskKey(it.item_text), it.id)
                          const took = timing(it.started_at, it.finished_at, itemPauses)
                          const kids = its.filter((c) => c.parent_id === it.id)
                          const lastOfGroup = sub ? !its.some((c) => c.parent_id === it.parent_id && c.sort_order > it.sort_order) : kids.length === 0
                          const parent = sub ? its.find((p) => p.id === it.parent_id)! : it
                          return (
                            <Fragment key={it.id}>
                            <li key={it.id} className={`flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-sm ${sub ? 'ml-6 border-l-2 border-slate-200 pl-2' : ''}`}>
                              <Can permission="boards.card.checklists" level="edit" fallback={<span className="text-xs text-slate-500">{it.finished_at ? 'Completed' : 'Open'}</span>}>
                                <input
                                  type="checkbox"
                                  aria-label={`Mark complete: ${it.item_text}`}
                                  className="h-4 w-4"
                                  checked={Boolean(it.finished_at)}
                                  disabled={!mayEdit || busy}
                                  onChange={(e) => updateItem(it, { finished_at: e.target.checked ? new Date().toISOString() : null })}
                                />
                              </Can>
                              <span className={`flex-1 ${it.finished_at ? 'text-slate-500 line-through' : ''}`}>{it.item_text}</span>
                              <Can permission="boards.card.timing">
                                <span className="text-xs text-slate-500" title={[it.started_by_name && `Started by ${it.started_by_name}`, it.finished_by_name && `finished by ${it.finished_by_name}`].filter(Boolean).join(', ')}>
                                  {took && <><Icon name="timer" className="h-3.5 w-3.5" /> {took}</>}
                                  {avg && <> · usual {formatDuration(avg.seconds)} ({avg.count})</>}
                                  {!took && !avg && it.finished_at && it.finished_by_name && `Completed by ${it.finished_by_name}`}
                                </span>
                                <Can permission="boards.card.timing" level="edit">
                                  {mayEdit && !it.started_at && !it.finished_at && (
                                    <button type="button" className={small} disabled={busy} onClick={() => updateItem(it, { started_at: new Date().toISOString() })}>
                                      Start
                                    </button>
                                  )}
                                  {mayEdit && it.started_at && !it.finished_at && (
                                    <>
                                      {paused ? (
                                        <button type="button" className={small} disabled={busy} onClick={() => resumeTimer(it.id)}>
                                          Resume
                                        </button>
                                      ) : (
                                        <button type="button" className={small} disabled={busy} onClick={() => pauseTimer(it.id)}>
                                          Pause
                                        </button>
                                      )}
                                      <button type="button" className={small} disabled={busy} onClick={() => updateItem(it, { finished_at: new Date().toISOString() })}>
                                        Finish
                                      </button>
                                    </>
                                  )}
                                </Can>
                              </Can>
                              <Can permission="boards.card.checklists" level="edit">
                                {mayEdit && !sub && (
                                  <button type="button" className="text-xs text-slate-600 underline" onClick={() => { setSubFor(subFor === it.id ? null : it.id); setSubText('') }}>
                                    Add Sub-task
                                  </button>
                                )}
                                {mayEdit && (
                                  <button
                                    type="button"
                                    aria-label={`Remove task ${it.item_text}`}
                                    className="text-xs text-slate-400 hover:text-red-700"
                                    onClick={() => run(() => supabase!.from('board_checklist_items').delete().eq('id', it.id))}
                                  >
                                    ✕
                                  </button>
                                )}
                              </Can>
                              <Can permission="boards.card.timing">
                                <div className="w-full pl-6 empty:hidden">{pauseList(itemPauses)}</div>
                              </Can>
                            </li>
                            {lastOfGroup && subFor === parent.id && (
                              <Can permission="boards.card.checklists" level="edit">
                                <li className="ml-6 py-1.5 pl-2">
                                  <form onSubmit={(e) => addSubTask(e, parent)} className="flex gap-2">
                                    <input
                                      aria-label={`New sub-task of ${parent.item_text}`}
                                      className={`${inputClass} py-1`}
                                      placeholder="Add a sub-task"
                                      autoFocus
                                      value={subText}
                                      onChange={(e) => setSubText(e.target.value)}
                                      onKeyDown={(e) => e.key === 'Escape' && setSubFor(null)}
                                    />
                                    <button type="submit" className={small} disabled={busy}>
                                      Add
                                    </button>
                                  </form>
                                </li>
                              </Can>
                            )}
                            </Fragment>
                          )
                        })}
                      </ul>
                      <Can permission="boards.card.checklists" level="edit">
                        {mayEdit && (
                          <form onSubmit={(e) => addItem(e, list.id)} className="mt-1 flex gap-2">
                            <input
                              aria-label={`New task in ${list.title}`}
                              className={`${inputClass} py-1`}
                              placeholder="Add a task"
                              value={newItem[list.id] ?? ''}
                              onChange={(e) => setNewItem((m) => ({ ...m, [list.id]: e.target.value }))}
                            />
                            <button type="submit" className={small}>
                              Add
                            </button>
                          </form>
                        )}
                      </Can>
                    </div>
                  )
                })}
              </div>
              <Can permission="boards.card.checklists" level="edit">
                {mayEdit && (
                  <form onSubmit={addChecklist} className="mt-3 flex gap-2">
                    <input
                      aria-label="New checklist"
                      list={`presets-${board.id}`}
                      className={`${inputClass} py-1`}
                      placeholder={board.checklist_presets.length ? 'New checklist (enter a name or choose a ready-made one)' : 'New checklist name'}
                      value={newList}
                      onChange={(e) => setNewList(e.target.value)}
                    />
                    <datalist id={`presets-${board.id}`}>
                      {board.checklist_presets.map((p) => (
                        <option key={p.title} value={p.title} />
                      ))}
                    </datalist>
                    <button type="submit" className={`${small} whitespace-nowrap`} disabled={busy}>
                      Add Checklist
                    </button>
                  </form>
                )}
              </Can>
            </Block>
          </Can>

          {/* ---------- Photos / files (later) ---------- */}
          <Can permission="boards.card.attachments">
            <Block title="Photos and Files">
              <div className="rounded-md border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500">Photos and files on cards will be available in a future update.</div>
            </Block>
          </Can>

          {/* ---------- Comments ---------- */}
          <Can permission="boards.card.comments">
            <Block title={`Comments${comments.length ? ` (${comments.length})` : ''}`}>
              <ul className="space-y-2">
                {comments.map((c) => (
                  <li key={c.id} className="rounded-md bg-slate-50 p-2 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-500">
                      <span className="font-medium text-slate-700">{c.author_name}</span>
                      <span>
                        {activityTime.format(new Date(c.created_at))}
                        {c.edited_at && ' (edited)'}
                      </span>
                    </div>
                    {editingComment?.id === c.id ? (
                      <Can permission="boards.card.comments" level="edit">
                        <textarea
                          aria-label="Edit comment"
                          className={`${inputClass} mt-1`}
                          rows={3}
                          value={editingComment.body}
                          onChange={(e) => setEditingComment({ id: c.id, body: e.target.value })}
                        />
                        <div className="mt-1 flex gap-2">
                          <button
                            type="button"
                            className={small}
                            onClick={async () =>
                              editingComment.body.trim() &&
                              (await run(() => supabase!.from('board_comments').update({ body: editingComment.body.trim() }).eq('id', c.id))) &&
                              setEditingComment(null)
                            }
                          >
                            Save Changes
                          </button>
                          <button type="button" className={small} onClick={() => setEditingComment(null)}>
                            Cancel
                          </button>
                        </div>
                      </Can>
                    ) : (
                      <p className="mt-0.5 whitespace-pre-wrap break-words">{c.body}</p>
                    )}
                    {c.author_email === me && editingComment?.id !== c.id && (
                      <Can permission="boards.card.comments" level="edit">
                        <div className="mt-1 flex gap-3 text-xs">
                          <button type="button" className="text-slate-600 underline" onClick={() => setEditingComment({ id: c.id, body: c.body })}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-red-700 underline"
                            onClick={async () => (await confirmAction('Permanently delete this comment?', { confirmLabel: 'Permanently Delete', danger: true })) && run(() => supabase!.from('board_comments').delete().eq('id', c.id))}
                          >
                            Permanently Delete
                          </button>
                        </div>
                      </Can>
                    )}
                  </li>
                ))}
              </ul>
              <Can permission="boards.card.comments" level="edit">
                <form onSubmit={addComment} className="mt-2 space-y-1.5">
                  <textarea
                    aria-label="New comment"
                    className={inputClass}
                    rows={2}
                    placeholder="Write a comment"
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                  />
                  <button type="submit" className={secondaryButtonClass} disabled={busy || !newComment.trim()}>
                    Add Comment
                  </button>
                </form>
              </Can>
            </Block>
          </Can>

          {/* ---------- History ---------- */}
          <Can permission="boards.card.history">
            <Block title="History">
              {events.length === 0 ? (
                <p className="text-xs text-slate-500">No history recorded for this card yet.</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
                  {events.map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="shrink-0 text-slate-500">{activityTime.format(new Date(e.created_at))}</span>
                      <span>
                        <span className="font-medium">{e.actor_name ?? 'Someone'}</span>: {eventText(e)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Block>
          </Can>
        </div>

        {/* ---------- Side column ---------- */}
        <aside className="space-y-4">
          <Can permission="boards.card.assignees">
            <Block title="People">
              <ul className="space-y-1">
                {cardPeople.map((email) => (
                  <li key={email} className="flex items-center gap-2 text-sm">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-[10px] font-semibold text-white">{initials(nameOf(email))}</span>
                    <span className="flex-1 truncate">{nameOf(email)}</span>
                    <Can permission="boards.card.assignees" level="edit">
                      {mayEdit && (
                        <button
                          type="button"
                          aria-label={`Take ${nameOf(email)} off the card`}
                          className="text-xs text-slate-400 hover:text-red-700"
                          onClick={() => run(() => supabase!.from('board_card_assignees').delete().eq('card_id', card.id).eq('user_email', email))}
                        >
                          ✕
                        </button>
                      )}
                    </Can>
                  </li>
                ))}
                {cardPeople.length === 0 && <li className="text-xs text-slate-500">No one is assigned yet.</li>}
              </ul>
              <Can permission="boards.card.assignees" level="edit">
                {mayEdit && (
                  <select
                    aria-label="Put someone on the card"
                    className={`${inputClass} mt-2 py-1`}
                    value=""
                    disabled={busy}
                    onChange={(e) => e.target.value && run(() => supabase!.from('board_card_assignees').insert({ card_id: card.id, user_email: e.target.value }))}
                  >
                    <option value="">Add a person…</option>
                    {data.people
                      .filter((p) => !cardPeople.includes(p.email))
                      .map((p) => (
                        <option key={p.email} value={p.email}>
                          {p.name}
                          {p.email === me ? ' (me)' : ''}
                        </option>
                      ))}
                  </select>
                )}
              </Can>
            </Block>
          </Can>

          <Can permission="boards.card.due">
            <Block title="Due Date">
              {due && card.due_date && (
                <p className={`mb-2 inline-block rounded px-2 py-0.5 text-xs ring-1 ${DUE_TONE[due]}`}>
                  {showDate(card.due_date, 'EEE, MMM d')} · {due === 'done' ? 'finished' : dueWords(card.due_date, today)}
                </p>
              )}
              <Can permission="boards.card.edit" level="edit" fallback={!card.due_date ? <p className="text-xs text-slate-500">No due date set.</p> : null}>
                <input
                  type="date"
                  aria-label="Due date"
                  className={`${inputClass} py-1`}
                  value={card.due_date ?? ''}
                  disabled={!mayEdit || busy}
                  onChange={(e) => updateCard({ due_date: e.target.value || null })}
                />
              </Can>
            </Block>
          </Can>

          <Can permission="boards.card.timing">
            <Block title={card.card_kind === 'machine' ? 'Time in This Stage' : 'Time'}>
              <div className="space-y-1 text-sm">
                {card.started_at ? (
                  <p className="text-xs text-slate-600">
                    Started {activityTime.format(new Date(card.started_at))}
                    {card.started_by_name && ` by ${card.started_by_name}`}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500">Not started.</p>
                )}
                {card.finished_at && (
                  <p className="text-xs text-slate-600">
                    Finished {activityTime.format(new Date(card.finished_at))}
                    {card.finished_by_name && ` by ${card.finished_by_name}`}
                  </p>
                )}
                {timing(card.started_at, card.finished_at, cardPauses) && (
                  <p className="font-medium">
                    <Icon name="timer" /> {timing(card.started_at, card.finished_at, cardPauses)}
                    {cardPauses.length > 0 && <span className="block text-[11px] font-normal text-slate-500">Active time only: paused time is not counted.</span>}
                  </p>
                )}
                {pauseList(cardPauses.filter((p) => card.started_at && p.paused_at >= card.started_at))}
                {cardAvg && (
                  <p className="text-xs text-slate-600">
                    Usual for “{card.title}”: {formatDuration(cardAvg.seconds)} (average of {cardAvg.count})
                  </p>
                )}
              </div>
              <Can permission="boards.card.timing" level="edit">
                {mayEdit && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!card.started_at && (
                      <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => updateCard({ started_at: new Date().toISOString() })}>
                        {card.card_kind === 'machine' ? 'Start Stage' : 'Start'}
                      </button>
                    )}
                    {card.started_at && !card.finished_at && (
                      openPause(data.pauses, card.id, null, card.started_at, card.finished_at) ? (
                        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => resumeTimer(null)}>
                          Resume
                        </button>
                      ) : (
                        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => pauseTimer(null)}>
                          Pause
                        </button>
                      )
                    )}
                    {card.started_at && !card.finished_at && (
                      <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => updateCard({ finished_at: new Date().toISOString() })}>
                        {card.card_kind === 'machine' ? 'Finish Stage' : 'Finish'}
                      </button>
                    )}
                    {card.started_at && (
                      <button
                        type="button"
                        className="text-xs text-slate-600 underline"
                        onClick={async () => (await confirmAction('Clear the start and finish times?')) && updateCard({ started_at: null, finished_at: null })}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </Can>
            </Block>
          </Can>

          <Can permission="boards.card.link">
            <Block title="Linked To">
              <LinkPicker card={card} editable={mayEdit && can('boards.card.link', 'edit')} busy={busy} onSave={(patch) => updateCard(patch)} />
            </Block>
          </Can>

          <Can permission="boards.card.archive" level="edit">
            {mayEdit && (
              <div className="border-t border-slate-200 pt-3">
                <button
                  type="button"
                  className="text-sm text-red-700 underline"
                  onClick={async () => {
                    if (!(await confirmAction(`Archive the card “${card.title}”? It can be restored later.`, { confirmLabel: 'Archive' }))) return
                    if (await updateCard({ archived: true }, 'Card archived.')) onClose()
                  }}
                >
                  Archive Card
                </button>
              </div>
            )}
          </Can>
          <Can permission="order.page">
            {card.order_id && (
              <Link to={`/orders/${card.order_id}`} className="block text-sm text-blue-700 underline">
                Open the Linked Order →
              </Link>
            )}
          </Can>
        </aside>
      </div>
    </Overlay>
  )
}

/** A wide pop-up (cards need more room than the standard box). */
/* @layout-helper */
function Overlay({ title, colour, onClose, children }: { title: string; colour?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-start sm:p-6" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative max-h-[95vh] w-full overflow-y-auto rounded-t-lg bg-white p-5 shadow-xl sm:max-w-4xl sm:rounded-lg" style={colour ? { borderTop: `6px solid ${colour}` } : undefined}>
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3 rounded px-2 text-xl leading-none text-slate-500 hover:bg-slate-100">
          ×
        </button>
        {children}
      </div>
    </div>
  )
}
