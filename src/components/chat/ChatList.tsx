// @permission-scope chat
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, inputClass } from '../form'
import NewChatDialog from './NewChatDialog'
import { chatTime, KIND_LABEL, type ConversationKind, type ConversationRow, type Status } from '../../lib/chat'
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

  const visible = rows.filter((r) => showArchived || !r.archived)
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
            {loaded && visible.length === 0 && <p className="p-4 text-sm text-slate-500">No conversations yet. Start one with New Chat.</p>}
            {ORDER.map((kind) => {
              const list = visible.filter((r) => r.kind === kind)
              if (!list.length) return null
              return (
                <div key={kind}>
                  <h2 className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">{KIND_LABEL[kind]}</h2>
                  <ul>
                    {list.map((r) => (
                      <li key={r.id}>
                        <Link
                          to={`/chat/${r.id}`}
                          className={`flex items-center gap-2 px-3 py-2 text-sm ${r.id === activeId ? 'bg-slate-100' : 'hover:bg-slate-50'} ${r.archived ? 'opacity-60' : ''}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <Can permission="chat.presence">{r.other_email && <StatusDot status={presence.get(r.other_email)} />}</Can>
                              <span className={`truncate ${r.unread && r.notify !== 'mute' ? 'font-semibold' : 'font-medium'}`}>
                                {r.name ?? 'Conversation'}
                              </span>
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
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
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
