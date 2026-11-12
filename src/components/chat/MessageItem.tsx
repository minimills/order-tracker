// @permission-scope chat
import { useEffect, useMemo, useState } from 'react'
import Can from '../Can'
import { clockTime, linkHref, loadPreview, messageHtml, REACTIONS, type ChatLink, type ChatMessage, type Preview, type Reaction } from '../../lib/chat'

/** Small previews under a message for the orders, machines, boards and cards it mentions. */
/* @rendered-inside-can */
function LinkPreviews({ links }: { links: ChatLink[] }) {
  const [items, setItems] = useState<{ link: ChatLink; preview: Preview }[]>([])
  useEffect(() => {
    let live = true
    Promise.all(links.slice(0, 4).map(async (link) => ({ link, preview: await loadPreview(link) }))).then((r) => live && setItems(r))
    return () => {
      live = false
    }
  }, [links])
  if (!items.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {items.map(({ link, preview }) => (
        <a
          key={`${link.type}-${link.id}`}
          href={linkHref(link)}
          className="block max-w-xs rounded-md border border-slate-200 bg-white px-2 py-1 text-xs hover:border-slate-400"
        >
          {preview ? (
            <>
              <span className="block truncate font-medium text-slate-800">{preview.title}</span>
              {preview.detail && <span className="block truncate text-slate-500">{preview.detail}</span>}
            </>
          ) : (
            <span className="text-slate-500">{link.text}: not available to you</span>
          )}
        </a>
      ))}
    </div>
  )
}

/** One message: who, when, the text, a reply quote, reactions, and its actions. */
export default function MessageItem({
  m,
  me,
  myGroups,
  replied,
  reactions,
  names,
  showHeader,
  highlight,
  canPost,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onReact,
  onJump,
  onUnsend,
}: {
  m: ChatMessage
  me: string
  myGroups: Set<string>
  replied: ChatMessage | null | undefined
  reactions: Reaction[]
  names: Map<string, string>
  showHeader: boolean
  highlight: boolean
  canPost: boolean
  onReply: () => void
  onEdit: () => void
  onDelete: () => void
  onPin: () => void
  onReact: (emoji: string) => void
  onJump: (id: string) => void
  /** Take the message back completely (own messages, first 30 seconds). */
  onUnsend?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [picker, setPicker] = useState(false)
  const mine = m.author_email === me
  // Seconds left to unsend my own new message (counts down, then the button goes).
  const [left, setLeft] = useState(() => Math.max(0, 30 - Math.floor((Date.now() - Date.parse(m.created_at)) / 1000)))
  useEffect(() => {
    if (!mine || left <= 0) return
    const t = window.setInterval(() => setLeft(Math.max(0, 30 - Math.floor((Date.now() - Date.parse(m.created_at)) / 1000))), 1000)
    return () => window.clearInterval(t)
  }, [mine, left, m.created_at])
  const html = useMemo(() => (m.deleted_at ? '' : messageHtml(m, me, myGroups)), [m, me, myGroups])
  const grouped = useMemo(() => {
    const g = new Map<string, string[]>()
    for (const r of reactions) g.set(r.emoji, [...(g.get(r.emoji) ?? []), r.user_email])
    return [...g.entries()]
  }, [reactions])

  return (
    <div
      id={`msg-${m.id}`}
      className={`group relative rounded-md px-3 py-1 ${highlight ? 'bg-amber-50 ring-1 ring-amber-300' : 'hover:bg-slate-50'}`}
      onClick={() => setOpen((o) => !o)}
    >
      {showHeader && (
        <div className="flex items-baseline gap-2 pt-1">
          <span className="text-sm font-semibold">{m.author_name ?? 'Someone'}</span>
          <span className="text-[11px] text-slate-400">{clockTime(m.created_at)}</span>
        </div>
      )}
      {m.reply_to && (
        <button
          type="button"
          className="mt-0.5 mb-1 block w-full max-w-md truncate border-l-2 border-slate-300 pl-2 text-left text-xs text-slate-500"
          onClick={(e) => {
            e.stopPropagation()
            onJump(m.reply_to!)
          }}
        >
          {replied ? (
            <>
              <span className="font-medium">{replied.author_name}: </span>
              {replied.deleted_at ? 'Message deleted' : replied.body_text}
            </>
          ) : (
            'Reply to an earlier message'
          )}
        </button>
      )}
      {m.deleted_at ? (
        <p className="text-sm text-slate-400 italic">Message deleted</p>
      ) : (
        <div className="rich-text rich-text-readonly chat-body text-sm break-words" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {mine && left > 0 && onUnsend && !m.deleted_at && (
        <Can permission="chat.unsend" level="edit">
          <button
            type="button"
            className="mt-0.5 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            onClick={(e) => {
              e.stopPropagation()
              onUnsend()
            }}
          >
            Unsend ({left} s)
          </button>
        </Can>
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
        {!showHeader && <span className="opacity-0 group-hover:opacity-100">{clockTime(m.created_at)}</span>}
        {m.edited_at && !m.deleted_at && <span>(edited)</span>}
        {m.pinned_at && <span className="text-amber-700">Pinned{m.pinned_by ? ` by ${m.pinned_by}` : ''}</span>}
      </div>
      {!m.deleted_at && m.links?.length > 0 && <LinkPreviews links={m.links} />}

      {grouped.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {grouped.map(([emoji, who]) => (
            <Can
              key={emoji}
              permission="chat.send"
              level="edit"
              fallback={
                <span className="rounded-full border border-slate-200 px-2 text-xs">
                  {emoji} {who.length}
                </span>
              }
            >
              <button
                type="button"
                className={`rounded-full border px-2 text-xs ${who.includes(me) ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'}`}
                title={who.map((e) => names.get(e) ?? e).join(', ')}
                onClick={(e) => {
                  e.stopPropagation()
                  onReact(emoji)
                }}
              >
                {emoji} {who.length}
              </button>
            </Can>
          ))}
        </div>
      )}

      {!m.deleted_at && (
        <div
          className={`${open ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'} absolute -top-3 right-2 z-10 items-center gap-1 rounded-md border border-slate-200 bg-white px-1 py-0.5 text-xs shadow-sm`}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(false)
          }}
        >
          {canPost && (
            <>
              <Can permission="chat.send" level="edit">
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" onClick={() => setPicker((p) => !p)} aria-label="Add a reaction">
                  React
                </button>
              </Can>
              <Can permission="chat.send" level="edit">
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" onClick={onReply}>
                  Reply
                </button>
              </Can>
            </>
          )}
          <Can permission="chat.pin" level="edit">
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" onClick={onPin}>
              {m.pinned_at ? 'Unpin' : 'Pin'}
            </button>
          </Can>
          {mine && canPost && (
            <>
              <Can permission="chat.send" level="edit">
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-slate-100" onClick={onEdit}>
                  Edit
                </button>
              </Can>
              <Can permission="chat.send" level="edit">
                <button type="button" className="rounded px-1.5 py-0.5 text-red-700 hover:bg-red-50" onClick={onDelete}>
                  Delete
                </button>
              </Can>
            </>
          )}
        </div>
      )}
      {picker && (
        <div className="absolute top-4 right-2 z-20 flex gap-1 rounded-md border border-slate-200 bg-white p-1 shadow" onClick={(e) => e.stopPropagation()}>
          {REACTIONS.map((r) => (
            <Can key={r} permission="chat.send" level="edit">
              <button
                type="button"
                className="rounded px-1 text-lg hover:bg-slate-100"
                aria-label={`React with ${r}`}
                onClick={() => {
                  setPicker(false)
                  onReact(r)
                }}
              >
                {r}
              </button>
            </Can>
          ))}
        </div>
      )}
    </div>
  )
}
