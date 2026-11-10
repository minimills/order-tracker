import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import ChatList from '../components/chat/ChatList'
import Conversation from '../components/chat/Conversation'
import { useAuth } from '../lib/auth'
import { refreshChatUnread, usePresence, type ConversationRow } from '../lib/chat'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'

/**
 * Chat: conversation list and the open conversation side by side; on a phone
 * one at a time (the conversation fills the screen; swipe right to go back).
 */
export default function ChatPage() {
  const { conversationId } = useParams()
  const navigate = useNavigate()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const { can } = usePermissions()
  const [rows, setRows] = useState<ConversationRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [hidden, setHidden] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.rpc('my_chat_conversations')
    if (error) {
      if (navigator.onLine) toast.error(friendlyError(error))
      return
    }
    setRows((data as ConversationRow[] | null) ?? [])
    setLoaded(true)
    void refreshChatUnread()
  }, [])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
    if (!supabase) return
    // Live: any new message, member or conversation change refreshes the list (plus a 20-second check).
    const ch = supabase
      .channel('chat-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members' }, () => void load())
      .subscribe()
    const timer = window.setInterval(() => void load(), 20_000)
    supabase
      .from('chat_settings')
      .select('hide_status')
      .maybeSingle()
      .then(({ data }) => setHidden(Boolean(data?.hide_status)))
    return () => {
      window.clearInterval(timer)
      void supabase?.removeChannel(ch)
    }
  }, [load])

  const presence = usePresence(can('chat'), me, hidden)
  const current = rows.find((r) => r.id === conversationId) ?? null

  // Swipe right from the left edge on a phone = back to the list.
  const touch = useRef<{ x: number; y: number } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touch.current = t.clientX < 40 ? { x: t.clientX, y: t.clientY } : null
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touch.current) return
    const t = e.changedTouches[0]
    if (t.clientX - touch.current.x > 80 && Math.abs(t.clientY - touch.current.y) < 60) navigate('/chat')
    touch.current = null
  }

  return (
    <Can permission="chat">
      <div className="-m-4 flex h-[calc(100dvh-3.3rem)] overflow-hidden bg-white md:-m-8">
        <aside className={`${conversationId ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-slate-200 md:w-80 md:shrink-0`}>
          <ChatList rows={rows} loaded={loaded} activeId={conversationId ?? null} presence={presence} onChanged={load} />
        </aside>
        <section
          className={`${conversationId ? 'fixed inset-0 z-30 flex md:static md:z-auto' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-white`}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {conversationId ? (
            current || !loaded ? (
              <Conversation key={conversationId} id={conversationId} row={current} me={me} presence={presence} onChanged={load} />
            ) : (
              <div className="m-auto max-w-sm p-6 text-center text-sm text-slate-500">
                This conversation could not be found. You may have left it, or it was archived.
              </div>
            )
          ) : (
            <div className="m-auto p-6 text-center text-sm text-slate-500">Choose a conversation, or start a new one.</div>
          )}
        </section>
      </div>
    </Can>
  )
}
