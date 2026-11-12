// @permission-scope chat
import { useEffect, useRef, useState, type TouchEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, inputClass } from '../form'
import NewChatDialog from './NewChatDialog'
import { chatTime, KIND_LABEL, STATE_DONE, stateAction, SWIPE_ACTIONS, type ConversationKind, type ConversationRow, type Status, type SwipeAction } from '../../lib/chat'
import { confirmAction } from '../../lib/confirm'
import { usePermissions } from '../../lib/permissions'
import { friendlyError } from '../../lib/format'
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

  /** Archive, Hide, Clear chat, Delete for me, Mark read / unread: only my own view changes. */
  async function act(r: ConversationRow, a: SwipeAction) {
    if (!supabase) return
    const action = stateAction(a, r)
    if (action === 'delete' && !(await confirmAction(`Delete “${r.name ?? 'this conversation'}” for you? Its messages disappear from your list only; the others keep them. It comes back if someone writes again.`, { confirmLabel: 'Delete for Me', danger: true }))) return
    if (action === 'clear' && !(await confirmAction(`Clear the messages of “${r.name ?? 'this conversation'}” for you? The others keep them.`, { confirmLabel: 'Clear Chat', danger: true }))) return
    const { error } = await supabase.rpc('set_chat_state', { p_conv: r.id, p_action: action })
    if (error) return toast.error(friendlyError(error))
    toast.success(STATE_DONE[action] ?? 'Done.')
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

  const visible = rows.filter((r) => (showArchived || !r.archived) && !r.my_archived && !r.hidden)
  const myArchived = rows.filter((r) => r.my_archived && !r.hidden)
  const hiddenRows = rows.filter((r) => r.hidden)
  /* @rendered-inside-can */ const item = (r: ConversationRow) => (
    <ConversationItem key={r.id} r={r} active={r.id === activeId} presence={presence} canAct={canAct} swipe={swipe} onAct={(a) => void act(r, a)} />
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

      <div className="flex-1 overflow-y-auto">
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

/**
 * One conversation in the list. Phones: swipe left or right (Settings → Chat).
 * Computers: Archive and More appear on hover.
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
  onAct: (a: SwipeAction) => void
}) {
  const [dx, setDx] = useState(0)
  const [menu, setMenu] = useState(false)
  const start = useRef<{ x: number; y: number; moving: boolean; dx: number } | null>(null)
  const label = (a: SwipeAction) => {
    const act = stateAction(a, r)
    return act === 'unarchive' ? 'Unarchive' : act === 'unhide' ? 'Unhide' : act === 'read' ? 'Mark Read' : act === 'unread' ? 'Mark Unread' : SWIPE_ACTIONS.find((x) => x.value === a)!.label
  }
  const onTouchStart = (e: TouchEvent) => {
    if (!canAct) return
    const t = e.touches[0]
    start.current = { x: t.clientX, y: t.clientY, moving: false, dx: 0 }
  }
  const onTouchMove = (e: TouchEvent) => {
    const s = start.current
    if (!s) return
    const t = e.touches[0]
    const x = t.clientX - s.x
    if (!s.moving && Math.abs(t.clientY - s.y) > Math.abs(x)) {
      start.current = null
      return
    }
    s.moving = Math.abs(x) > 8
    s.dx = Math.max(-140, Math.min(140, x))
    setDx(s.dx)
  }
  const onTouchEnd = () => {
    const moved = start.current?.dx ?? 0
    const done = Math.abs(moved) > 80
    const dir = moved < 0 ? 'left' : 'right'
    start.current = null
    setDx(0)
    if (done) onAct(swipe[dir])
  }
  return (
    <li className="group relative overflow-hidden" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      {dx !== 0 && (
        <div className={`absolute inset-0 flex items-center px-4 text-xs font-semibold text-white ${dx < 0 ? 'justify-end bg-slate-700' : 'justify-start bg-red-700'}`} aria-hidden="true">
          {label(dx < 0 ? swipe.left : swipe.right)}
        </div>
      )}
      <Link
        to={`/chat/${r.id}`}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        onClick={(e) => Math.abs(dx) > 8 && e.preventDefault()}
        className={`relative flex items-center gap-2 bg-white px-3 py-2 text-sm ${active ? 'bg-slate-100' : 'hover:bg-slate-50'} ${r.archived ? 'opacity-60' : ''}`}
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
      {canAct && (
        <Can permission="chat.list_actions" level="edit">
          <div
            className={`absolute top-1/2 right-2 z-10 -translate-y-1/2 items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5 text-xs shadow-sm ${
              menu ? 'flex' : 'hidden md:group-hover:flex md:group-focus-within:flex'
            }`}
          >
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" onClick={() => onAct('archive')}>
              {label('archive')}
            </button>
            <span className="relative">
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                More ▾
              </button>
              {menu && (
                <span className="absolute top-6 right-0 z-20 flex w-40 flex-col rounded-md border border-slate-200 bg-white py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
                  {(['read_toggle', 'hide', 'clear', 'delete'] as SwipeAction[]).map((a) => (
                    <button
                      key={a}
                      type="button"
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
