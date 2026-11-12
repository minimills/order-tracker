// @permission-scope chat
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { toast } from 'sonner'
import Can from '../Can'
import Icon from '../Icon'
import RichTextEditor, { type EditorApi } from '../RichTextEditor'
import { buttonClass, secondaryButtonClass } from '../form'
import ConversationInfo from './ConversationInfo'
import MessageItem from './MessageItem'
import { StatusDot } from './ChatList'
import { confirmAction } from '../../lib/confirm'
import {
  dayLabel,
  findMentions,
  refreshChatUnread,
  sameDay,
  type ChatMessage,
  type ConversationRow,
  type Member,
  type MentionTarget,
  type Person,
  type Reaction,
  type Status,
  type TimeOff,
  TIME_OFF_WORDS,
} from '../../lib/chat'
import { showDate } from '../../lib/dates'
import { usePermissions } from '../../lib/permissions'
import { friendlyError } from '../../lib/format'
import { isEmptyRichText, richTextToPlain } from '../../lib/richText'
import { supabase } from '../../lib/supabase'

const PAGE = 50

/** One conversation: messages (live), composer, typing, "seen", pins and members. */
export default function Conversation({
  id,
  row,
  me,
  presence,
  onChanged,
}: {
  id: string
  row: ConversationRow | null
  me: string
  presence: Map<string, Status>
  onChanged: () => void
}) {
  const [params] = useSearchParams()
  const focusId = params.get('m')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [extra, setExtra] = useState<Map<string, ChatMessage>>(new Map())
  const [reactions, setReactions] = useState<Reaction[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [targets, setTargets] = useState<MentionTarget[]>([])
  const [myGroups, setMyGroups] = useState<Set<string>>(new Set())
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [html, setHtml] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<ChatMessage | null>(null)
  const [sending, setSending] = useState(false)
  const [typing, setTyping] = useState<Map<string, number>>(new Map())
  const [panel, setPanel] = useState<'info' | 'pins' | null>(null)
  const [highlight, setHighlight] = useState<string | null>(focusId)
  const editor = useRef<EditorApi | null>(null)
  const channel = useRef<RealtimeChannel | null>(null)
  const lastTyping = useRef(0)
  const bottom = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const scroller = useRef<HTMLDivElement>(null)

  const names = useMemo(() => new Map(people.map((p) => [p.email, p.name])), [people])
  const canSeeTimeOff = usePermissions().can('chat.time_off')

  const load = useCallback(
    async (older?: string) => {
      if (!supabase) return
      let q = supabase.from('chat_messages').select('*').eq('conversation_id', id).order('created_at', { ascending: false }).limit(PAGE)
      if (older) q = q.lt('created_at', older)
      const [m, mem] = await Promise.all([q, supabase.from('chat_members').select('*').eq('conversation_id', id)])
      if (m.error) {
        if (navigator.onLine) toast.error(friendlyError(m.error))
        return
      }
      const got = ((m.data as ChatMessage[] | null) ?? []).reverse()
      setMore(got.length === PAGE)
      setMessages((prev) => {
        if (!older) {
          // keep earlier pages already loaded, replace the newest page
          const oldest = got[0]?.created_at
          const keep = oldest ? prev.filter((x) => x.created_at < oldest) : []
          return [...keep, ...got]
        }
        return [...got, ...prev]
      })
      if (!mem.error) setMembers((mem.data as Member[] | null) ?? [])
      setLoaded(true)
    },
    [id],
  )

  // Reactions and quoted messages for what is on screen.
  const ids = useMemo(() => messages.map((x) => x.id), [messages])
  useEffect(() => {
    if (!supabase || !ids.length) return
    supabase
      .from('chat_reactions')
      .select('message_id, user_email, emoji')
      .in('message_id', ids)
      .then(({ data }) => setReactions((data as Reaction[] | null) ?? []))
    const missing = messages.filter((x) => x.reply_to && !ids.includes(x.reply_to) && !extra.has(x.reply_to)).map((x) => x.reply_to!)
    if (missing.length) {
      supabase
        .from('chat_messages')
        .select('*')
        .in('id', missing)
        .then(({ data }) => setExtra((e) => new Map([...e, ...((data as ChatMessage[] | null) ?? []).map((x) => [x.id, x] as const)])))
    }
  }, [ids, messages, extra])

  useEffect(() => {
    if (!supabase) return
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
    supabase.rpc('chat_people').then(({ data }) => setPeople((data as Person[] | null) ?? []))
    supabase.rpc('chat_mention_targets').then(({ data }) => {
      const groups = ((data as { type: 'department' | 'group'; key: string; label: string }[] | null) ?? []).map((t) => ({
        ...t,
        hint: t.type === 'department' ? 'Department' : 'Group',
      }))
      setTargets((t) => [...t.filter((x) => x.type === 'user'), ...groups])
    })
    supabase.rpc('chat_my_targets').then(({ data }) => setMyGroups(new Set((data as string[] | null) ?? [])))

    // Live: new / changed messages, reactions, read marks; typing as broadcasts. A 15-second check is the fallback.
    const ch = supabase
      .channel(`chat:${id}`, { config: { private: true, broadcast: { self: false } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${id}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members', filter: `conversation_id=eq.${id}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reactions' }, () => setMessages((m) => [...m]))
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const who = String((payload as { email?: string }).email ?? '')
        if (who && who !== me) setTyping((t) => new Map(t).set(who, Date.now()))
      })
      .subscribe()
    channel.current = ch
    const poll = window.setInterval(() => void load(), 15_000)
    const tidy = window.setInterval(() => setTyping((t) => new Map([...t].filter(([, at]) => Date.now() - at < 5000))), 2000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tidy)
      void supabase?.removeChannel(ch)
    }
  }, [id, me, load])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setTargets((t) => [...people.map((p) => ({ type: 'user' as const, key: p.email, label: p.name, hint: p.email })), ...t.filter((x) => x.type !== 'user')])
  }, [people])

  // Read: when new messages arrive while the conversation is on screen.
  const newest = messages[messages.length - 1]?.id
  useEffect(() => {
    if (!supabase || !newest || document.hidden) return
    supabase.rpc('mark_chat_read', { p_conv: id }).then(() => {
      void refreshChatUnread()
      onChanged()
    })
  }, [id, newest, onChanged])

  // Scroll: to the message asked for (?m=), else stay at the bottom.
  useEffect(() => {
    if (!loaded) return
    if (focusId) {
      const el = document.getElementById(`msg-${focusId}`)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        return
      }
    }
    if (atBottom.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [loaded, messages, focusId])

  const onScroll = () => {
    const el = scroller.current
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // @mention suggestions for what is being typed at the end ("@bo").
  const plain = richTextToPlain(html)
  const partial = /(?:^|\s)@([\p{L}\p{N} .'-]{0,30})$/u.exec(plain.replace(/\s+$/, (s) => (s.includes('\n') ? '\n' : s)))
  const suggestions =
    partial && !partial[1].endsWith(' ') ? targets.filter((t) => t.label.toLowerCase().startsWith(partial[1].toLowerCase()) && t.key !== me).slice(0, 6) : []

  function onType(next: string) {
    setHtml(next)
    if (Date.now() - lastTyping.current > 3000 && channel.current) {
      lastTyping.current = Date.now()
      void channel.current.send({ type: 'broadcast', event: 'typing', payload: { email: me } })
    }
  }

  async function send() {
    if (!supabase || sending) return
    if (isEmptyRichText(html)) return
    const mentions = findMentions(richTextToPlain(html), targets)
    setSending(true)
    const { error } = editing
      ? await supabase.rpc('edit_chat_message', { p_id: editing.id, p_body: html, p_mentions: mentions })
      : await supabase.rpc('post_chat_message', { p_conv: id, p_body: html, p_reply_to: replyTo?.id ?? null, p_mentions: mentions })
    setSending(false)
    if (error) return toast.error(friendlyError(error))
    setHtml('')
    setReplyTo(null)
    setEditing(null)
    setEditorKey((k) => k + 1)
    atBottom.current = true
    void load()
    onChanged()
  }

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    const { error } = await fn()
    if (error) toast.error(friendlyError(error as Parameters<typeof friendlyError>[0]))
    void load()
  }

  // Seen (direct messages): the other person has read my last message.
  const other = row?.kind === 'direct' ? members.find((x) => x.user_email !== me) : undefined
  const myLast = [...messages].reverse().find((x) => x.author_email === me && !x.deleted_at)
  const seen = other && myLast && other.last_read_at >= myLast.created_at
  const typers = [...typing.keys()].map((e) => names.get(e) ?? e)
  const pinned = messages.filter((x) => x.pinned_at)
  const byId = useMemo(() => new Map([...extra, ...messages.map((x) => [x.id, x] as const)]), [messages, extra])
  const canPost = row?.can_post ?? false

  // People here who are on approved time off (from the time-off step, when it is in place).
  const [away, setAway] = useState<TimeOff[]>([])
  useEffect(() => {
    if (!supabase || !canSeeTimeOff) return
    supabase.rpc('chat_time_off', { p_conv: id }).then(({ data }) => setAway((data as TimeOff[] | null) ?? []))
  }, [id, canSeeTimeOff])

  return (
    <>
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <Link to="/chat" className="rounded px-2 py-1 text-lg md:hidden" aria-label="Back to conversations">
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 truncate font-semibold">
            <Can permission="chat.presence">{row?.other_email && <StatusDot status={presence.get(row.other_email)} />}</Can>
            {row?.name ?? 'Conversation'}
          </h2>
          <p className="truncate text-xs text-slate-500">
            {row?.kind === 'direct'
              ? row.other_email && presence.get(row.other_email)
                ? presence.get(row.other_email) === 'online'
                  ? 'Online'
                  : 'Away'
                : 'Direct message'
              : `${row?.members ?? members.length} members`}
            {row?.notify === 'mute' ? ' · muted' : row?.notify === 'mentions' ? ' · mentions only' : ''}
            {row?.archived ? ' · archived' : ''}
          </p>
        </div>
        {pinned.length > 0 && (
          <Can permission="chat">
            <button type="button" className={secondaryButtonClass} onClick={() => setPanel(panel === 'pins' ? null : 'pins')}>
              Pinned ({pinned.length})
            </button>
          </Can>
        )}
        <Can permission="chat.members">
          <button type="button" className={secondaryButtonClass} onClick={() => setPanel(panel === 'info' ? null : 'info')}>
            Details
          </button>
        </Can>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto py-2">
            {more && (
              <div className="py-2 text-center">
                <Can permission="chat">
                  <button type="button" className="text-sm text-blue-700 underline" onClick={() => void load(messages[0]?.created_at)}>
                    Load Earlier Messages
                  </button>
                </Can>
              </div>
            )}
            {loaded && messages.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No messages yet. Say hello.</p>}
            {messages.map((m, i) => {
              const prev = messages[i - 1]
              const newDay = !prev || !sameDay(prev.created_at, m.created_at)
              const header = newDay || !prev || prev.author_email !== m.author_email || Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60_000
              return (
                <div key={m.id}>
                  {newDay && <div className="my-2 text-center text-[11px] font-medium text-slate-500">{dayLabel(m.created_at)}</div>}
                  <MessageItem
                    m={m}
                    me={me}
                    myGroups={myGroups}
                    replied={m.reply_to ? byId.get(m.reply_to) : null}
                    reactions={reactions.filter((r) => r.message_id === m.id)}
                    names={names}
                    showHeader={header}
                    highlight={highlight === m.id}
                    canPost={canPost}
                    onReply={() => {
                      setEditing(null)
                      setReplyTo(m)
                      editor.current?.focus()
                    }}
                    onEdit={() => {
                      setReplyTo(null)
                      setEditing(m)
                      setHtml(m.body)
                      editor.current?.setContent(m.body)
                      editor.current?.focus()
                    }}
                    onDelete={async () => {
                      if (
                        !(await confirmAction('Delete this message? Everyone will see “Message deleted” instead.', {
                          confirmLabel: 'Delete Message',
                          danger: true,
                        }))
                      )
                        return
                      void run(() => supabase!.rpc('delete_chat_message', { p_id: m.id }))
                    }}
                    onPin={() => void run(() => supabase!.rpc('pin_chat_message', { p_id: m.id, p_pinned: !m.pinned_at }))}
                    onReact={(emoji) => void run(() => supabase!.rpc('toggle_chat_reaction', { p_id: m.id, p_emoji: emoji }))}
                    onUnsend={() =>
                      void (async () => {
                        const { error } = await supabase!.rpc('unsend_chat_message', { p_id: m.id })
                        if (error) return toast.error(friendlyError(error))
                        setMessages((list) => list.filter((x) => x.id !== m.id))
                        toast.success('Message unsent.')
                        void load()
                        onChanged()
                      })()
                    }
                    onJump={(target) => {
                      setHighlight(target)
                      document.getElementById(`msg-${target}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                    }}
                  />
                </div>
              )
            })}
            {seen && <p className="px-3 text-right text-[11px] text-slate-500">Seen</p>}
            <div ref={bottom} />
          </div>

          <div className="h-5 px-3 text-xs text-slate-500" aria-live="polite">
            {typers.length > 0 && `${typers.join(', ')} ${typers.length === 1 ? 'is' : 'are'} typing…`}
          </div>

          {canPost && away.length > 0 && (
            <Can permission="chat.time_off">
              <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
                {away.map((p) => (
                  <p key={p.email}>
                    {p.name} is on {TIME_OFF_WORDS[p.kind] ?? p.kind}
                    {p.return_date ? ` and may not read this until ${showDate(p.return_date, 'EEE, MMM d')}.` : ' and may not read this right away.'}
                  </p>
                ))}
              </div>
            </Can>
          )}
          {canPost ? (
            <Can anyOf={['chat.send', 'chat.channels.post']} level="edit">
              <div className="border-t border-slate-200 p-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
                {(replyTo || editing) && (
                  <div className="mb-1 flex items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {editing ? 'Editing your message' : `Replying to ${replyTo!.author_name}: ${replyTo!.body_text}`}
                    </span>
                    <Can anyOf={['chat.send', 'chat.channels.post']} level="edit">
                      <button
                        type="button"
                        aria-label="Cancel"
                        className="px-1"
                        onClick={() => {
                          setReplyTo(null)
                          if (editing) {
                            setEditing(null)
                            setHtml('')
                            setEditorKey((k) => k + 1)
                          }
                        }}
                      >
                        ×
                      </button>
                    </Can>
                  </div>
                )}
                {suggestions.length > 0 && (
                  <ul className="mb-1 max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white text-sm shadow" role="listbox" aria-label="Mention">
                    {suggestions.map((s) => (
                      <li key={`${s.type}-${s.key}`}>
                        <Can anyOf={['chat.send', 'chat.channels.post']} level="edit">
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-slate-50"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              editor.current?.replaceBeforeCursor(partial![1].length + 1, `@${s.label} `)
                            }}
                          >
                            <span>@{s.label}</span>
                            <span className="text-xs text-slate-500">{s.hint}</span>
                          </button>
                        </Can>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Can anyOf={['chat.send', 'chat.channels.post']} level="edit">
                      <RichTextEditor
                        key={editorKey}
                        value={editing ? editing.body : ''}
                        onChange={onType}
                        onSubmit={send}
                        onReady={(api) => {
                          editor.current = api
                        }}
                        minHeight="2.5rem"
                        label={`Message ${row?.name ?? ''}`}
                      />
                    </Can>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Can permission="chat.attachments">
                      <button
                        type="button"
                        className={`${secondaryButtonClass} px-2`}
                        disabled
                        title="Photos and files will be available in a future update."
                        aria-label="Attach a photo or file (available in a future update)"
                      >
                        <Icon name="paperclip" />
                      </button>
                    </Can>
                    <Can anyOf={['chat.send', 'chat.channels.post']} level="edit">
                      <button type="button" className={buttonClass} onClick={send} disabled={sending || isEmptyRichText(html)}>
                        {editing ? 'Save Changes' : 'Send'}
                      </button>
                    </Can>
                  </div>
                </div>
                <p className="mt-1 hidden text-[11px] text-slate-400 md:block">
                  Ctrl+Enter (or Cmd+Enter) sends. Type @ to mention someone; #86 links an order; serial numbers and card names become links.
                </p>
              </div>
            </Can>
          ) : (
            <p className="border-t border-slate-200 p-3 text-center text-sm text-slate-500">
              {row?.archived ? 'This conversation is archived.' : 'You can read this conversation but not write in it.'}
            </p>
          )}
        </div>

        {panel && (
          <aside className="fixed inset-0 z-40 overflow-y-auto bg-white md:static md:z-auto md:w-72 md:border-l md:border-slate-200">
            {panel === 'pins' ? (
              <div className="p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold">Pinned Messages</h3>
                  <Can permission="chat">
                    <button type="button" aria-label="Close" className="px-2 text-lg" onClick={() => setPanel(null)}>
                      ×
                    </button>
                  </Can>
                </div>
                <ul className="space-y-2 text-sm">
                  {pinned.map((m) => (
                    <li key={m.id}>
                      <Can permission="chat">
                        <button
                          type="button"
                          className="w-full rounded border border-slate-200 p-2 text-left hover:bg-slate-50"
                          onClick={() => {
                            setPanel(null)
                            setHighlight(m.id)
                            document.getElementById(`msg-${m.id}`)?.scrollIntoView({ block: 'center' })
                          }}
                        >
                          <span className="block text-xs text-slate-500">{m.author_name}</span>
                          <span className="line-clamp-3">{m.body_text}</span>
                        </button>
                      </Can>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              row && (
                <ConversationInfo
                  row={row}
                  members={members}
                  names={names}
                  people={people}
                  me={me}
                  presence={presence}
                  onClose={() => setPanel(null)}
                  onChanged={() => {
                    void load()
                    onChanged()
                  }}
                />
              )
            )}
          </aside>
        )}
      </div>
    </>
  )
}
