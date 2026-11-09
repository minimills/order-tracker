import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import BoardSettingsDialog from '../components/boards/BoardSettingsDialog'
import CardDialog from '../components/boards/CardDialog'
import CardTile from '../components/boards/CardTile'
import NotifyDialog from '../components/boards/NotifyDialog'
import SaveTemplateDialog from '../components/boards/SaveTemplateDialog'
import ShareDialog from '../components/boards/ShareDialog'
import { inputClass, narrowInputClass, secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { currentStageItems, loadBoard, type BoardData, type Card } from '../lib/boards'
import { useDepartments } from '../lib/useDepartments'
import { todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { confirmAction } from '../lib/confirm'
import Icon from '../components/Icon'

type Drop = { stageId: string; cardId: string | null; place: 'before' | 'after' }
type Dialog = 'share' | 'notify' | 'settings' | 'template' | null

/** /boards/:id – the board: stages side by side, cards in them. ?card=<id> opens a card. */
export default function BoardPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { can } = usePermissions()
  const { departments } = useDepartments()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const today = todayISO()
  const [data, setData] = useState<BoardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [links, setLinks] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [q, setQ] = useState('')
  const [labelFilter, setLabelFilter] = useState('')
  const [personFilter, setPersonFilter] = useState('')
  const seesComments = can('boards.card.comments')
  const seesLinks = can('boards.card.link')

  const load = useCallback(async () => {
    try {
      const d = await loadBoard(id, { comments: seesComments })
      if (!d.board) {
        setError('This board could not be found, or it has not been shared with you.')
        return
      }
      setData(d)
      setError(null)
      if (seesLinks && supabase) {
        const orderIds = [...new Set(d.cards.map((c) => c.order_id).filter(Boolean))] as string[]
        const customerIds = [...new Set(d.cards.map((c) => c.customer_id).filter(Boolean))] as string[]
        const machineIds = [...new Set(d.cards.map((c) => c.machine_id).filter(Boolean))] as string[]
        const [o, c, m] = await Promise.all([
          orderIds.length ? supabase.from('order_summary').select('id, order_code').in('id', orderIds) : Promise.resolve({ data: [] }),
          customerIds.length ? supabase.from('customer_list').select('id, name').in('id', customerIds) : Promise.resolve({ data: [] }),
          machineIds.length ? supabase.from('order_machine_status').select('id, serial_number, machine_type').in('id', machineIds) : Promise.resolve({ data: [] }),
        ])
        const map: Record<string, string> = {}
        for (const r of (o.data ?? []) as { id: string; order_code: string }[]) map[r.id] = `Order ${r.order_code}`
        for (const r of (c.data ?? []) as { id: string; name: string }[]) map[r.id] = r.name
        for (const r of (m.data ?? []) as { id: string; serial_number: string | null; machine_type: string }[]) map[r.id] = r.serial_number ?? r.machine_type
        setLinks(map)
      }
    } catch (e) {
      setError(friendlyError(e as Error))
    }
  }, [id, seesComments, seesLinks])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const stages = useMemo(() => (data?.stages ?? []).filter((s) => !s.archived), [data])
  const level = data?.level ?? 0
  const openCard = params.get('card')
  const setCard = (cardId: string | null) =>
    setParams(
      (p) => {
        if (cardId) p.set('card', cardId)
        else p.delete('card')
        return p
      },
      { replace: !cardId },
    )

  const visibleCards = useMemo(() => {
    if (!data) return []
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return data.cards.filter((c) => {
      if (words.length && !words.every((w) => c.title.toLowerCase().includes(w))) return false
      if (labelFilter && !data.cardLabels.some((l) => l.card_id === c.id && l.label_id === labelFilter)) return false
      const who = personFilter === 'me' ? me : personFilter
      if (who && !data.assignees.some((a) => a.card_id === c.id && a.user_email === who)) return false
      return true
    })
  }, [data, q, labelFilter, personFilter, me])

  if (error)
    return (
      <Can permission="boards">
        <div className="mx-auto max-w-3xl">
          <p className="text-slate-700">{error}</p>
          <Link to="/boards" className="mt-3 inline-block text-sm underline">
            ← Boards
          </Link>
        </div>
      </Can>
    )
  if (!data?.board)
    return (
      <Can permission="boards">
        <p className="p-8 text-center text-slate-500">Loading…</p>
      </Can>
    )
  const board = data.board
  const canMove = level >= 2 && can('boards.card.move', 'edit')

  // ---------- Drag and drop ----------
  function onDragOverCard(e: DragEvent, stageId: string, card: Card) {
    if (!dragId) return
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDrop({ stageId, cardId: card.id, place: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
  }
  async function onDropStage(stageId: string) {
    const cardId = dragId
    const target = drop
    setDragId(null)
    setDrop(null)
    if (!cardId || !supabase) return
    const list = data!.cards.filter((c) => c.stage_id === stageId && c.id !== cardId)
    let index = list.length
    if (target?.stageId === stageId && target.cardId) {
      const i = list.findIndex((c) => c.id === target.cardId)
      if (i >= 0) index = target.place === 'before' ? i : i + 1
    }
    const card = data!.cards.find((c) => c.id === cardId)!
    const old = data!.cards.filter((c) => c.stage_id === card.stage_id).findIndex((c) => c.id === cardId)
    if (card.stage_id === stageId && old === index) return
    // Show it straight away, then save.
    setData((d) => d && { ...d, cards: moveLocal(d.cards, cardId, stageId, index) })
    const { error: e } = await supabase.rpc('move_board_card', { p_card: cardId, p_stage: stageId, p_index: index })
    if (e) toast.error(friendlyError(e))
    load()
  }

  async function addCard(e: FormEvent, stageId: string) {
    e.preventDefault()
    if (!supabase || !newTitle.trim()) return
    const { error: err } = await supabase.from('board_cards').insert({ board_id: board.id, stage_id: stageId, title: newTitle.trim() })
    if (err) return toast.error(friendlyError(err))
    setNewTitle('')
    load()
  }

  async function archiveBoard() {
    if (!supabase) return
    if (!board.archived && !(await confirmAction(`Archive the board “${board.name}”? It is removed from the Boards page and can be restored later.`, { confirmLabel: 'Archive' }))) return
    const { error: err } = await supabase.from('boards').update({ archived: !board.archived }).eq('id', board.id)
    if (err) return toast.error(friendlyError(err))
    toast.success(board.archived ? 'Board restored.' : 'Board archived.')
    load()
  }

  const peopleByEmail = new Map(data.people.map((p) => [p.email, p]))
  return (
    <Can permission="boards">
      <div className="flex h-full min-h-[70vh] flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link to="/boards" className="text-sm text-slate-600 underline">
              ← Boards
            </Link>
            <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
              <span className="inline-block h-4 w-4 shrink-0 rounded" style={{ backgroundColor: board.colour }} aria-hidden />
              {board.name}
              {board.archived && <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">Archived</span>}
            </h1>
            {board.description && <p className="text-sm text-slate-600">{board.description}</p>}
            {board.purpose === 'production' && board.order_id && (
              <Can permission="order.page">
                <Link to={`/orders/${board.order_id}`} className="text-sm text-blue-700 underline">
                  Open the Order
                </Link>
              </Can>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {level >= 3 && (
              <>
                <Can permission="boards.share" level="edit">
                  <button type="button" className={secondaryButtonClass} onClick={() => setDialog('share')}>
                    <Icon name="share" /> Share
                  </button>
                </Can>
                <Can permission="boards.notifications">
                  <button type="button" className={secondaryButtonClass} onClick={() => setDialog('notify')}>
                    <Icon name="bell" /> Notifications
                  </button>
                </Can>
                <Can permission="boards.manage" level="edit">
                  <button type="button" className={secondaryButtonClass} onClick={() => setDialog('settings')}>
                    <Icon name="settings" /> Stages and Labels
                  </button>
                </Can>
                <Can permission="boards.archive" level="edit">
                  <button type="button" className={secondaryButtonClass} onClick={archiveBoard}>
                    {board.archived ? 'Restore Board' : 'Archive Board'}
                  </button>
                </Can>
              </>
            )}
            <Can permission="admin.board_templates" level="edit">
              <button type="button" className={secondaryButtonClass} onClick={() => setDialog('template')}>
                Save as Template
              </button>
            </Can>
          </div>
        </div>

        <Can permission="boards.filter">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Search cards" className={`${inputClass} max-w-xs`} placeholder="Search cards" value={q} onChange={(e) => setQ(e.target.value)} />
            <Can permission="boards.card.labels">
              <select aria-label="Label" className={`${narrowInputClass} w-44`} value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)}>
                <option value="">All Labels</option>
                {data.labels
                  .filter((l) => !l.archived)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </Can>
            <Can permission="boards.card.assignees">
              <select aria-label="Person" className={`${narrowInputClass} w-48`} value={personFilter} onChange={(e) => setPersonFilter(e.target.value)}>
                <option value="">Everyone</option>
                <option value="me">My Cards</option>
                {data.people.map((p) => (
                  <option key={p.email} value={p.email}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Can>
          </div>
        </Can>

        {stages.length === 0 && (
          <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
            This board has no stages yet.
            {level >= 3 && can('boards.manage', 'edit') && ' Use “Stages and Labels” to add stages (for example To do, Doing, Done).'}
          </p>
        )}

        <div className="-mx-4 flex flex-1 gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0">
          {stages.map((stage) => {
            const cards = visibleCards.filter((c) => c.stage_id === stage.id)
            return (
              <section
                key={stage.id}
                aria-label={stage.name}
                className={`flex w-72 shrink-0 flex-col rounded-lg bg-slate-100 ${drop?.stageId === stage.id && !drop.cardId ? 'ring-2 ring-blue-400' : ''}`}
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  if (drop?.stageId !== stage.id || drop.cardId) setDrop({ stageId: stage.id, cardId: null, place: 'after' })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  onDropStage(stage.id)
                }}
              >
                <h2 className="flex items-center justify-between px-3 pt-2.5 pb-1.5 text-sm font-semibold">
                  <span>
                    {stage.name}
                    {stage.department_id && (
                      <span className="block text-[11px] font-normal text-slate-500">{departments.find((d) => d.id === stage.department_id)?.name}</span>
                    )}
                  </span>
                  <span className="rounded-full bg-white px-2 text-xs font-normal text-slate-600">{cards.length}</span>
                </h2>
                <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {cards.map((card) => (
                    <CardTile
                      key={card.id}
                      card={card}
                      labels={data.labels.filter((l) => data.cardLabels.some((x) => x.card_id === card.id && x.label_id === l.id))}
                      people={data.assignees.filter((a) => a.card_id === card.id).map((a) => peopleByEmail.get(a.user_email) ?? { email: a.user_email, name: a.user_email })}
                      items={currentStageItems(data, card)}
                      machine={data.machines.find((m) => m.id === card.machine_id) ?? null}
                      serviceCall={data.serviceCalls.find((c) => c.card_id === card.id) ?? null}
                      stageStep={stage.step}
                      comments={data.commentCounts[card.id] ?? 0}
                      linkText={[card.order_id, card.customer_id, card.machine_id].map((x) => (x ? links[x] : null)).filter(Boolean).join(' · ') || null}
                      today={today}
                      soonDays={board.due_soon_days}
                      canOpen={can('boards.card.open')}
                      draggable={canMove}
                      dragging={dragId === card.id}
                      dropHint={drop?.cardId === card.id ? drop.place : null}
                      onOpen={() => setCard(card.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', card.id)
                        setDragId(card.id)
                      }}
                      onDragEnd={() => {
                        setDragId(null)
                        setDrop(null)
                      }}
                      onDragOver={(e) => onDragOverCard(e, stage.id, card)}
                    />
                  ))}
                </div>
                {level >= 2 && (
                  <Can permission="boards.card.create" level="edit">
                    <div className="px-2 pb-2">
                      {adding === stage.id ? (
                        <form onSubmit={(e) => addCard(e, stage.id)} className="space-y-1.5">
                          <input
                            aria-label={`New card in ${stage.name}`}
                            className={inputClass}
                            placeholder="Enter a card title, then press Enter"
                            value={newTitle}
                            autoFocus
                            onChange={(e) => setNewTitle(e.target.value)}
                            onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
                          />
                          <div className="flex gap-2">
                            <button type="submit" className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white">
                              Add Card
                            </button>
                            <button type="button" className="text-xs text-slate-600 underline" onClick={() => setAdding(null)}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="w-full rounded-md px-2 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-200"
                          onClick={() => {
                            setAdding(stage.id)
                            setNewTitle('')
                          }}
                        >
                          Add Card
                        </button>
                      )}
                    </div>
                  </Can>
                )}
              </section>
            )
          })}
        </div>
        {canMove && (
          <Can permission="boards.card.move" level="edit">
            <p className="text-xs text-slate-500">
              Drag cards between stages or up and down. A card can move to the next stage even when its checklist is not complete.
            </p>
          </Can>
        )}

        {openCard && (
          <Can permission="boards.card.open">
            <CardDialog key={openCard} cardId={openCard} data={data} level={level} onClose={() => setCard(null)} onChanged={load} onOpenCard={(id) => setCard(id)} />
          </Can>
        )}
        {dialog === 'share' && (
          <Can permission="boards.share" level="edit">
            <ShareDialog board={board} onClose={() => setDialog(null)} onChanged={load} />
          </Can>
        )}
        {dialog === 'notify' && (
          <Can permission="boards.notifications">
            <NotifyDialog board={board} stages={stages} onClose={() => setDialog(null)} />
          </Can>
        )}
        {dialog === 'settings' && (
          <Can permission="boards.manage" level="edit">
            <BoardSettingsDialog data={data} onClose={() => setDialog(null)} onChanged={load} />
          </Can>
        )}
        {dialog === 'template' && (
          <Can permission="admin.board_templates" level="edit">
            <SaveTemplateDialog board={board} onClose={() => setDialog(null)} />
          </Can>
        )}
      </div>
    </Can>
  )
}

/** Moves a card in the local list (before the database answers). */
function moveLocal(cards: Card[], cardId: string, stageId: string, index: number) {
  const card = cards.find((c) => c.id === cardId)!
  const others = cards.filter((c) => c.id !== cardId)
  const inStage = others.filter((c) => c.stage_id === stageId)
  inStage.splice(index, 0, { ...card, stage_id: stageId })
  const order = new Map(inStage.map((c, i) => [c.id, i + 1]))
  return [...others.filter((c) => c.stage_id !== stageId), ...inStage].map((c) => (order.has(c.id) ? { ...c, sort_order: order.get(c.id)! } : c))
}
