// @permission-scope chat
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, inputClass } from '../form'
import NewChatDialog from './NewChatDialog'
import { chatTime, KIND_LABEL, STATE_DONE, STATE_UNDO, stateAction, SWIPE_ACTIONS, type ConversationKind, type ConversationRow, type Status, type SwipeAction } from '../../lib/chat'
import { confirmAction } from '../../lib/confirm'
import { usePermissions } from '../../lib/permissions'
import { friendlyError } from '../../lib/format'
import { ACTION } from '../../lib/wording'
import { supabase } from '../../lib/supabase'

type Hit = { id: string; conversation_id: string; conversation_name: string | null; author_name: string | null; body_text: string; created_at: string }
const ORDER: ConversationKind[] = ['direct', 'group', 'department', 'user_group', 'channel']

/** Status dot: green online, amber away (nothing when offline or hidden). */
/* @layout-helper */
export function StatusDot({ status }: { status: Status | undefined }) {
  if (!status) return null
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white ${status === 'online' ? 'bg-green-500' : 'bg-amber-400'}`}
      title={status === 'online' ? 'Online' : 'Away'}
      aria-label={status === 'online' ? 'Online' : 'Away'}
    />
  )
}

/** The list of my conversations, grouped, with unread counts and search. */
export default function ChatList({
  rows,
  loaded,
  activeId,
  presence,
  onChanged,
}: {
  rows: ConversationRow[]
  loaded: boolean
  activeId: string | null
  presence: Map<string, Status>
  onChanged: () => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [newChat, setNewChat] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [openSection, setOpenSection] = useState<'archived' | 'hidden' | null>(null)
  const [swipe, setSwipe] = useState<{ left: SwipeAction; right: SwipeAction }>({ left: 'archive', right: 'delete' })
  const { can } = usePermissions()
  const navigate = useNavigate()
  const canAct = can('chat.list_actions', 'edit')

  // My swipe choices (Settings → Chat).
  useEffect(() => {
    supabase
      ?.from('chat_settings')
      .select('swipe_left, swipe_right')
      .maybeSingle()
      .then(({ data }) => data && setSwipe({ left: (data.swipe_left as SwipeAction) ?? 'archive', right: (data.swipe_right as SwipeAction) ?? 'delete' }))
  }, [])

  /** Delete for me / Clear chat after a full swipe wait a few seconds (Undo), so these rows are hidden or marked meanwhile. */
  const [waiting, setWaiting] = useState<Record<string, 'delete' | 'clear'>>({})

  async function setState(r: ConversationRow, action: string) {
    const { error } = await supabase!.rpc('set_chat_state', { p_conv: r.id, p_action: action })
    if (error) {
      toast.error(friendlyError(error))
      return false
    }
    return true
  }

  /**
   * Archive, Hide, Clear chat, Delete for me, Mark read / unread: only my own view changes.
   * full = a long full swipe: done straight away (no question), with Undo for a few seconds.
   */
  async function act(r: ConversationRow, a: SwipeAction, full = false) {
    if (!supabase) return
    const action = stateAction(a, r)
    const name = r.name ?? 'this conversation'
    if (full && (action === 'delete' || action === 'clear')) {
      // Cannot be taken back once done: wait 5 seconds, Undo cancels.
      setWaiting((m) => ({ ...m, [r.id]: action }))
      let undone = false
      const timer = window.setTimeout(async () => {
        if (undone) return
        const ok = await setState(r, action)
        setWaiting((m) => {
          const n = { ...m }
          delete n[r.id]
          return n
        })
        if (!ok) return
        if (action === 'delete' && r.id === activeId) navigate('/chat')
        onChanged()
      }, 5000)
      toast(action === 'delete' ? `“${name}” will be deleted for you.` : `The messages of “${name}” will be cleared for you.`, {
        duration: 5000,
        action: {
          label: ACTION.undo,
          onClick: () => {
            undone = true
            window.clearTimeout(timer)
            setWaiting((m) => {
              const n = { ...m }
              delete n[r.id]
              return n
            })
          },
        },
      })
      return
    }
    if (!full && action === 'delete' && !(await confirmAction(`Delete “${name}” for you? Its messages disappear from your list only; the others keep them. It comes back if someone writes again.`, { confirmLabel: 'Delete for Me', danger: true }))) return
    if (!full && action === 'clear' && !(await confirmAction(`Clear the messages of “${name}” for you? The others keep them.`, { confirmLabel: 'Clear Chat', danger: true }))) return
    if (!(await setState(r, action))) return
    const undo = STATE_UNDO[action]
    toast.success(STATE_DONE[action] ?? 'Done.', {
      duration: full && undo ? 5000 : undefined,
      action:
        full && undo
          ? {
              label: ACTION.undo,
              onClick: async () => {
                if (await setState(r, undo)) onChanged()
              },
            }
          : undefined,
    })
    if (action === 'delete' && r.id === activeId) navigate('/chat')
    onChanged()
  }

  useEffect(() => {
    if (!supabase) return
    const text = q.trim()
    if (text.length < 2) {
      // oxlint-disable-next-line react/set-state-in-effect
      setHits(null)
      return
    }
    const t = window.setTimeout(async () => {
      const { data, error } = await supabase!.rpc('search_chat', { p_query: text })
      if (error) return toast.error(friendlyError(error))
      setHits((data as Hit[] | null) ?? [])
    }, 300)
    return () => window.clearTimeout(t)
  }, [q])

  const visible = rows.filter((r) => (showArchived || !r.archived) && !r.my_archived && !r.hidden && waiting[r.id] !== 'delete')
  const myArchived = rows.filter((r) => r.my_archived && !r.hidden && waiting[r.id] !== 'delete')
  const hiddenRows = rows.filter((r) => r.hidden && waiting[r.id] !== 'delete')
  /* @rendered-inside-can */ const item = (r: ConversationRow) => (
    <ConversationItem key={r.id} r={r} active={r.id === activeId} presence={presence} canAct={canAct} swipe={swipe} onAct={(a, full) => void act(r, a, full)} />
  )
  return (
    <>
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Chat</h1>
          <Can anyOf={['chat.direct', 'chat.groups']} level="edit">
            <button type="button" className={buttonClass} onClick={() => setNewChat(true)}>
              New Chat
            </button>
          </Can>
        </div>
        <Can permission="chat.search">
          <input
            type="search"
            aria-label="Search messages"
            className={inputClass}
            placeholder="Search all your conversations"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </Can>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-x-contain">
        {hits ? (
          <ul className="divide-y divide-slate-100">
            {hits.length === 0 && <li className="p-4 text-sm text-slate-500">No messages match.</li>}
            {hits.map((h) => (
              <li key={h.id}>
                <Link to={`/chat/${h.conversation_id}?m=${h.id}`} className="block px-3 py-2 text-sm hover:bg-slate-50" onClick={() => setQ('')}>
                  <div className="flex justify-between gap-2 text-xs text-slate-500">
                    <span className="truncate font-medium text-slate-700">{h.conversation_name}</span>
                    <span>{chatTime(h.created_at)}</span>
                  </div>
                  <div className="line-clamp-2">
                    <span className="text-slate-500">{h.author_name}: </span>
                    {h.body_text}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <>
            {loaded && visible.length === 0 && (
              <p className="p-4 text-sm text-slate-500">
                {rows.length ? 'No other conversations. Your archived and hidden ones are below.' : 'No conversations yet. Start one with New Chat.'}
              </p>
            )}
            {ORDER.map((kind) => {
              const list = visible.filter((r) => r.kind === kind)
              if (!list.length) return null
              return (
                <div key={kind}>
                  <h2 className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">{KIND_LABEL[kind]}</h2>
                  <ul>{list.map(item)}</ul>
                </div>
              )
            })}
            {(
              [
                ['archived', 'Archived', myArchived],
                ['hidden', 'Hidden', hiddenRows],
              ] as const
            ).map(([key, label, list]) =>
              list.length ? (
                <div key={key} className="border-t border-slate-100">
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 px-3 pt-3 pb-1 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase"
                    aria-expanded={openSection === key}
                    onClick={() => setOpenSection(openSection === key ? null : key)}
                  >
                    {openSection === key ? '▾' : '▸'} {label} ({list.length})
                  </button>
                  {openSection === key && <ul>{list.map(item)}</ul>}
                </div>
              ) : null,
            )}
            {rows.some((r) => r.archived) && (
              <label className="flex items-center gap-2 px-3 py-3 text-xs text-slate-600">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived channels
              </label>
            )}
          </>
        )}
      </div>
      {newChat && (
        <NewChatDialog
          onClose={() => setNewChat(false)}
          onCreated={() => {
            setNewChat(false)
            onChanged()
          }}
        />
      )}
    </>
  )
}

/** Widths of the swipe buttons (px). */
const MAIN_W = 92
const EXTRA_W = 80
const EXTRAS = 2
const ALL_ACTIONS: SwipeAction[] = ['archive', 'read_toggle', 'hide', 'clear', 'delete']
const TONE: Record<SwipeAction, string> = { archive: 'bg-slate-700', read_toggle: 'bg-blue-700', hide: 'bg-slate-500', clear: 'bg-amber-700', delete: 'bg-red-700' }

/**
 * One conversation in the list. Swipe it (finger, mouse drag or two-finger
 * trackpad swipe): a short swipe shows the saved action of that side, a
 * longer one shows more actions, a long full swipe runs the saved action at
 * once (with Undo). Computers: Archive and More also appear on hover.
 */
/* @rendered-inside-can */
function ConversationItem({
  r,
  active,
  presence,
  canAct,
  swipe,
  onAct,
}: {
  r: ConversationRow
  active: boolean
  presence: Map<string, Status>
  canAct: boolean
  swipe: { left: SwipeAction; right: SwipeAction }
  onAct: (a: SwipeAction, full?: boolean) => void
}) {
  const [dx, setDx] = useState(0)
  const [open, setOpen] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  const start = useRef<{ x: number; y: number; base: number; moving: boolean; id: number } | null>(null)
  const swallowClick = useRef(false)
  const wheel = useRef<{ sum: number; base: number; timer?: number; quietTimer?: number; locked: boolean }>({ sum: 0, base: 0, locked: false })
  const live = useRef({ dx: 0, open: 0 })
  live.current = { dx, open }

  const label = (a: SwipeAction) => {
    const act = stateAction(a, r)
    return act === 'unarchive' ? 'Unarchive' : act === 'unhide' ? 'Unhide' : act === 'read' ? 'Mark Read' : act === 'unread' ? 'Mark Unread' : SWIPE_ACTIONS.find((x) => x.value === a)!.label
  }
  const width = () => row.current?.clientWidth ?? 360
  /** Past this distance a release runs the saved action straight away. */
  const fullAt = () => Math.max(MAIN_W + EXTRAS * EXTRA_W + 48, width() * 0.7)
  const sideOf = (d: number) => (d < 0 ? 'left' : 'right')
  const actionsFor = (d: number) => {
    const main = swipe[sideOf(d)]
    return { main, extras: ALL_ACTIONS.filter((a) => a !== main).slice(0, EXTRAS) }
  }

  function release(d: number) {
    const abs = Math.abs(d)
    if (abs >= fullAt()) {
      setDx(0)
      setOpen(0)
      onAct(swipe[sideOf(d)], true)
    } else if (abs >= MAIN_W + EXTRA_W / 2) {
      setOpen(Math.sign(d) * (MAIN_W + EXTRAS * EXTRA_W))
      setDx(Math.sign(d) * (MAIN_W + EXTRAS * EXTRA_W))
    } else if (abs >= 44) {
      setOpen(Math.sign(d) * MAIN_W)
      setDx(Math.sign(d) * MAIN_W)
    } else {
      setOpen(0)
      setDx(0)
    }
  }
  const close = () => {
    setOpen(0)
    setDx(0)
  }
  const clamp = (d: number) => Math.max(-width(), Math.min(width(), d))

  // Mouse, pen and finger: one set of pointer events.
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!canAct || (e.pointerType === 'mouse' && e.button !== 0)) return
    if ((e.target as HTMLElement).closest('[data-swipe-tools]')) return
    start.current = { x: e.clientX, y: e.clientY, base: live.current.open, moving: false, id: e.pointerId }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    const x = e.clientX - s.x
    const y = e.clientY - s.y
    if (!s.moving) {
      if (Math.abs(y) > 8 && Math.abs(y) > Math.abs(x)) {
        start.current = null
        return
      }
      if (Math.abs(x) < 8) return
      s.moving = true
      setDragging(true)
      setMenu(false)
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* the pointer is already gone */
      }
    }
    setDx(clamp(s.base + x))
  }
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = start.current
    start.current = null
    if (!s || s.id !== e.pointerId || !s.moving) return
    swallowClick.current = true
    window.setTimeout(() => (swallowClick.current = false), 400)
    setDragging(false)
    release(live.current.dx)
  }
  const onPointerCancel = () => {
    if (start.current?.moving) {
      setDragging(false)
      setDx(live.current.open)
    }
    start.current = null
  }

  // Trackpad: a two-finger sideways swipe arrives as horizontal wheel events.
  useEffect(() => {
    const el = row.current
    if (!el || !canAct) return
    const onWheel = (e: WheelEvent) => {
      const w = wheel.current
      const ddx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX
      const horizontal = Math.abs(ddx) > Math.abs(e.deltaY) && Math.abs(ddx) > 0
      if (w.locked) {
        // After a release the trackpad keeps sending its glide: wait until it is quiet.
        if (horizontal) e.preventDefault()
        window.clearTimeout(w.quietTimer)
        w.quietTimer = window.setTimeout(() => (w.locked = false), 250)
        return
      }
      if (!horizontal && w.timer === undefined) return
      e.preventDefault()
      if (w.timer === undefined) {
        w.sum = 0
        w.base = live.current.open
        setDragging(true)
        setMenu(false)
      }
      w.sum += ddx
      setDx(clamp(w.base - w.sum))
      window.clearTimeout(w.timer)
      w.timer = window.setTimeout(() => {
        w.timer = undefined
        w.locked = true
        w.quietTimer = window.setTimeout(() => (w.locked = false), 250)
        setDragging(false)
        release(live.current.dx)
      }, 160)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // release / clamp read the latest values through refs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [canAct, swipe])

  /** A click that ends a drag started on the hover buttons is not a click on them. */
  const afterDrag = () => {
    const was = swallowClick.current
    swallowClick.current = false
    return was
  }
  // The More menu closes when the person clicks somewhere else.
  useEffect(() => {
    if (!menu) return
    const out = (e: PointerEvent) => !row.current?.contains(e.target as Node) && setMenu(false)
    document.addEventListener('pointerdown', out)
    return () => document.removeEventListener('pointerdown', out)
  }, [menu])
  // An open row closes when the person clicks or taps somewhere else.
  useEffect(() => {
    if (!open) return
    const out = (e: PointerEvent) => !row.current?.contains(e.target as Node) && close()
    document.addEventListener('pointerdown', out)
    return () => document.removeEventListener('pointerdown', out)
  }, [open])

  const { main, extras } = actionsFor(dx || open)
  const abs = Math.abs(dx)
  const full = abs >= fullAt()
  const showExtras = !full && abs > MAIN_W + 8
  const press = (a: SwipeAction) => {
    close()
    onAct(a)
  }
  const btn = (a: SwipeAction, w: number | null, extra: boolean) => (
    <button
      key={a}
      type="button"
      tabIndex={open ? 0 : -1}
      className={`flex h-full shrink-0 items-center justify-center px-2 text-center text-xs leading-tight font-semibold text-white ${TONE[a]} ${w === null ? 'min-w-0 flex-1' : ''}`}
      style={w === null ? undefined : { width: w }}
      onClick={() => press(a)}
    >
      {full && !extra ? `Release to ${label(a)}` : label(a)}
    </button>
  )

  return (
    <li
      ref={row}
      className={`group relative ${canAct ? 'touch-pan-y' : ''} ${dragging ? 'select-none' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="relative overflow-hidden">
        {dx !== 0 && (
          <div className={`absolute inset-y-0 flex ${dx < 0 ? 'right-0 flex-row' : 'left-0 flex-row-reverse'}`} style={{ width: abs }} data-swipe-tools>
            {showExtras && extras.map((a) => btn(a, EXTRA_W, true))}
            {btn(main, null, false)}
          </div>
        )}
        <Link
          to={`/chat/${r.id}`}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={dx ? { transform: `translateX(${dx}px)` } : undefined}
          onClick={(e) => {
            if (swallowClick.current || open) {
              e.preventDefault()
              swallowClick.current = false
              if (open) close()
            }
          }}
          className={`relative flex items-center gap-2 bg-white px-3 py-2 text-sm ${dragging ? '' : 'transition-transform duration-150'} ${active ? 'bg-slate-100' : 'hover:bg-slate-50'} ${r.archived ? 'opacity-60' : ''}`}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <Can permission="chat.presence">{r.other_email && <StatusDot status={presence.get(r.other_email)} />}</Can>
              <span className={`truncate ${r.unread && r.notify !== 'mute' ? 'font-semibold' : 'font-medium'}`}>{r.name ?? 'Conversation'}</span>
              {r.notify === 'mute' && <span className="text-xs text-slate-400">muted</span>}
              {r.archived && <span className="text-xs text-slate-400">archived</span>}
            </span>
            <span className="block truncate text-xs text-slate-500">
              {r.last_text ? `${r.kind === 'direct' ? '' : `${r.last_author ?? ''}: `}${r.last_text}` : 'No messages yet'}
            </span>
          </span>
          <span className="flex flex-col items-end gap-1">
            <span className="text-[11px] text-slate-400">{chatTime(r.last_message_at)}</span>
            {r.unread > 0 && (
              <span
                className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold text-white ${r.mentions ? 'bg-red-600' : r.notify === 'mute' ? 'bg-slate-400' : 'bg-blue-600'}`}
                aria-label={`${r.unread} unread${r.mentions ? `, ${r.mentions} mentioning you` : ''}`}
              >
                {r.mentions ? '@' : ''}
                {r.unread}
              </span>
            )}
          </span>
        </Link>
      </div>
      {canAct && dx === 0 && (
        <Can permission="chat.list_actions" level="edit">
          <div
            className={`absolute top-1/2 right-2 z-10 -translate-y-1/2 items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5 text-xs shadow-sm ${
              menu ? 'flex' : 'hidden [@media(hover:hover)]:group-hover:flex [@media(hover:hover)]:group-focus-within:flex'
            }`}
          >
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" onClick={() => !afterDrag() && onAct('archive')}>
              {label('archive')}
            </button>
            <span className="relative">
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" aria-expanded={menu} aria-haspopup="menu" onClick={() => !afterDrag() && setMenu((m) => !m)}>
                More ▾
              </button>
              {menu && (
                <span role="menu" className="absolute top-6 right-0 z-20 flex w-40 flex-col rounded-md border border-slate-200 bg-white py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
                  {(['read_toggle', 'hide', 'clear', 'delete'] as SwipeAction[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="menuitem"
                      className={`px-3 py-1.5 text-left hover:bg-slate-50 ${a === 'delete' ? 'text-red-700' : ''}`}
                      onClick={() => {
                        setMenu(false)
                        onAct(a)
                      }}
                    >
                      {label(a)}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </div>
        </Can>
      )}
    </li>
  )
}
