// @permission-scope notices
import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { REACTIONS } from '../../lib/chat'
import { confirmAction } from '../../lib/confirm'
import { showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import {
  acknowledgeNotice,
  colourOf,
  PRIORITY,
  refreshUrgentNotices,
  showDateTime,
  showDay,
  tiltOf,
  type Notice,
  type NoticeComment,
  type NoticeReaction,
  type NoticeRead,
} from '../../lib/notices'
import { supabase } from '../../lib/supabase'
import { ACTION, confirmText } from '../../lib/wording'
import Can from '../Can'
import Icon from '../Icon'
import RichText from '../RichText'
import { narrowInputClass } from '../form'

type Props = {
  notice: Notice
  me: string
  audienceText: string
  read: NoticeRead | undefined
  reactions: NoticeReaction[]
  comments: NoticeComment[]
  isNew: boolean
  canManage: boolean
  highlight: boolean
  /** "board" = sticky note on the whiteboard; "list" = plain row (phones, archive). */
  layout: 'board' | 'list'
  onEdit: () => void
  onAcks: () => void
  onChanged: () => void
}

/** One notice: a sticky note (or a white pinned card) on the board. */
export default function NoticeCard(props: Props) {
  const { notice: n, me, read, reactions, comments, isNew, canManage, highlight, layout } = props
  const [busy, setBusy] = useState(false)
  const [showComments, setShowComments] = useState(highlight && comments.length > 0)
  const [comment, setComment] = useState('')
  const [picker, setPicker] = useState(false)
  const [expanded, setExpanded] = useState(highlight)
  const colour = colourOf(n.colour)
  const today = todayISO()
  const scheduled = n.show_from > today
  const expired = !!n.show_until && n.show_until < today
  const needsAck = (n.priority === 'important' || n.priority === 'urgent') && n.author_email !== me && !n.archived && !scheduled && !expired
  const pinnedLook = n.pinned || n.priority === 'urgent' || n.colour === 'white'
  const long = n.body_text.length > 360

  async function run(fn: () => PromiseLike<{ error: { message?: string; code?: string } | null }>, done?: string) {
    setBusy(true)
    const { error } = await fn()
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    if (done) toast.success(done)
    props.onChanged()
  }

  const acknowledge = () => run(() => acknowledgeNotice(n.id), 'Thank you. The notice is acknowledged.')
  const pin = () => run(() => supabase!.rpc('pin_notice', { p_notice: n.id, p_pinned: !n.pinned }), n.pinned ? 'Notice unpinned.' : 'Notice pinned to the top.')
  async function archive() {
    if (!n.archived && !(await confirmAction(confirmText.archive('this notice'), { confirmLabel: ACTION.archive }))) return
    await run(() => supabase!.rpc('archive_notice', { p_notice: n.id, p_archived: !n.archived }), n.archived ? 'Notice restored.' : 'Notice archived.')
    void refreshUrgentNotices()
  }
  const react = (emoji: string) => {
    setPicker(false)
    void run(() => supabase!.rpc('toggle_notice_reaction', { p_notice: n.id, p_emoji: emoji }))
  }
  async function postComment() {
    if (!comment.trim()) return
    await run(() => supabase!.rpc('post_notice_comment', { p_notice: n.id, p_body: comment.trim() }))
    setComment('')
    setShowComments(true)
  }
  async function deleteComment(id: string) {
    if (!(await confirmAction(confirmText.permanentlyDelete('this comment'), { confirmLabel: ACTION.permanentlyDelete, danger: true }))) return
    await run(() => supabase!.rpc('delete_notice_comment', { p_comment: id }))
  }

  const counts = REACTIONS.map((e) => ({ emoji: e, n: reactions.filter((r) => r.emoji === e).length, mine: reactions.some((r) => r.emoji === e && r.user_email === me) })).filter(
    (r) => r.n > 0,
  )

  const style = { '--tilt': tiltOf(n.id), backgroundColor: colour.paper, borderColor: colour.edge } as CSSProperties
  const boardLook =
    layout === 'board'
      ? 'md:[rotate:var(--tilt)] md:transition-transform md:hover:[rotate:0deg] shadow-[0_1px_2px_rgba(15,23,42,0.08),0_6px_14px_-6px_rgba(15,23,42,0.25)]'
      : 'shadow-sm'

  return (
    <article
      id={`notice-${n.id}`}
      style={style}
      className={`keep-light relative flex flex-col rounded-sm border px-4 pb-3 pt-5 text-slate-800 ${boardLook} ${
        n.priority === 'urgent' ? 'ring-2 ring-red-500/70' : ''
      } ${highlight ? 'outline outline-3 outline-offset-4 outline-blue-500' : ''} ${scheduled ? 'opacity-80' : ''}`}
    >
      {/* Pin or tape at the top */}
      {layout === 'board' &&
        (pinnedLook ? (
          <span aria-hidden="true" className="absolute -top-2.5 left-1/2 -translate-x-1/2">
            <span className={`block h-4 w-4 rounded-full shadow-[0_2px_3px_rgba(0,0,0,0.35)] ${n.priority === 'urgent' ? 'bg-red-600' : 'bg-slate-600'}`} />
          </span>
        ) : (
          <span aria-hidden="true" className="absolute -top-3 left-1/2 h-6 w-20 -translate-x-1/2 -rotate-2 bg-white/60 shadow-[0_1px_2px_rgba(0,0,0,0.12)] backdrop-blur-[1px]" />
        ))}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        {n.priority !== 'normal' && <span className={`rounded px-1.5 py-0.5 ${PRIORITY[n.priority].badge}`}>{PRIORITY[n.priority].label}</span>}
        {n.category && <span className="rounded bg-black/5 px-1.5 py-0.5 text-slate-700">{n.category}</span>}
        {n.pinned && (
          <span className="flex items-center gap-1 text-slate-600">
            <Icon name="pin" className="h-3 w-3" /> Pinned
          </span>
        )}
        {isNew && <span className="rounded bg-blue-600 px-1.5 py-0.5 text-white">New</span>}
        {scheduled && <span className="rounded bg-slate-700 px-1.5 py-0.5 text-white">Scheduled · shows from {showDate(n.show_from, 'MMM d')}</span>}
        {n.archived && <span className="rounded bg-slate-500 px-1.5 py-0.5 text-white">Archived</span>}
        {!n.archived && expired && <span className="rounded bg-slate-500 px-1.5 py-0.5 text-white">Expired</span>}
      </div>

      <h3 className="mt-2 text-base font-semibold leading-snug text-slate-900">{n.title}</h3>
      {n.body_text && (
        <div className={`mt-1.5 text-sm leading-relaxed ${long && !expanded ? 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}`}>
          <RichText value={n.body} />
        </div>
      )}
      {long && (
        <button type="button" className="mt-1 self-start text-xs font-medium text-slate-700 underline" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show Less' : 'Read More'}
        </button>
      )}

      <div className="mt-3 space-y-0.5 border-t border-black/10 pt-2 text-xs text-slate-600">
        <div>
          Posted by {n.author_name ?? 'someone who has left'} · {showDay(n.created_at)}
          {n.edited_at && (
            <span title={`Updated ${showDateTime(n.edited_at)}${n.edited_by ? ` by ${n.edited_by}` : ''}`}> · Updated {showDay(n.edited_at)}</span>
          )}
        </div>
        <div>For: {props.audienceText}</div>
        {n.show_until && <div>{expired ? 'Showed' : 'Shows'} until {showDate(n.show_until, 'MMM d, yyyy')}</div>}
      </div>

      {/* Acknowledge */}
      {needsAck && (
        <Can permission="notices.acknowledge" level="edit">
          <div className="mt-2">
            {read?.acknowledged_at ? (
              <span className="flex items-center gap-1 text-xs font-medium text-green-800">
                <Icon name="check" className="h-3.5 w-3.5" /> Acknowledged {showDateTime(read.acknowledged_at)}
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={acknowledge}
                className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 ${n.priority === 'urgent' ? 'bg-red-700 hover:bg-red-800' : 'bg-slate-900 hover:bg-slate-700'}`}
              >
                Acknowledge
              </button>
            )}
          </div>
        </Can>
      )}

      {/* Reactions, comments and actions */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Can
          permission="notices.react"
          level="edit"
          fallback={counts.map((r) => (
            <span key={r.emoji} className="rounded-full bg-white/70 px-2 py-0.5 text-xs">
              {r.emoji} {r.n}
            </span>
          ))}
        >
          {counts.map((r) => (
            <button
              key={r.emoji}
              type="button"
              disabled={busy || n.archived}
              onClick={() => react(r.emoji)}
              aria-pressed={r.mine}
              className={`rounded-full border px-2 py-0.5 text-xs ${r.mine ? 'border-blue-400 bg-blue-50' : 'border-transparent bg-white/70 hover:border-slate-300'}`}
            >
              {r.emoji} {r.n}
            </button>
          ))}
          {!n.archived && (
            <span className="relative">
              <button
                type="button"
                className="rounded-full bg-white/70 px-2 py-0.5 text-xs text-slate-700 hover:bg-white"
                onClick={() => setPicker(!picker)}
                aria-expanded={picker}
              >
                + React
              </button>
              {picker && (
                <span className="absolute left-0 top-7 z-10 flex gap-1 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                  {REACTIONS.map((e) => (
                    <button key={e} type="button" className="rounded px-1.5 py-1 text-base hover:bg-slate-100" onClick={() => react(e)} aria-label={`React with ${e}`}>
                      {e}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </Can>

        {n.comments_enabled && (
          <Can permission="notices.comments">
            <button
              type="button"
              className="flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-xs text-slate-700 hover:bg-white"
              onClick={() => setShowComments(!showComments)}
              aria-expanded={showComments}
            >
              <Icon name="comment" className="h-3 w-3" /> {comments.length ? `Comments (${comments.length})` : 'Comment'}
            </button>
          </Can>
        )}

        <span className="ml-auto flex flex-wrap items-center gap-x-2 text-xs">
          {canManage && n.priority !== 'normal' && (
            <Can permission="notices.acks">
              <button type="button" className="text-slate-700 underline" onClick={props.onAcks}>
                Who Has Acknowledged
              </button>
            </Can>
          )}
          <Can permission="notices.print">
            <Link to={`/notices/${n.id}/print`} className="text-slate-700 underline">
              {ACTION.print}
            </Link>
          </Can>
          {canManage && (
            <>
              {!n.archived && (
                <Can anyOf={['notices.post.everyone', 'notices.post.department', 'notices.manage']} level="edit">
                  <button type="button" className="text-slate-700 underline" onClick={props.onEdit}>
                    {ACTION.edit}
                  </button>
                </Can>
              )}
              {!n.archived && (
                <Can permission="notices.pin" level="edit">
                  <button type="button" disabled={busy} className="text-slate-700 underline" onClick={pin}>
                    {n.pinned ? 'Unpin' : 'Pin to Top'}
                  </button>
                </Can>
              )}
              <Can anyOf={['notices.post.everyone', 'notices.post.department', 'notices.manage']} level="edit">
                <button type="button" disabled={busy} className="text-slate-700 underline" onClick={archive}>
                  {n.archived ? ACTION.restore : ACTION.archive}
                </button>
              </Can>
            </>
          )}
        </span>
      </div>

      {showComments && n.comments_enabled && (
        <Can permission="notices.comments">
          <div className="mt-2 space-y-1.5 rounded bg-white/70 p-2 text-sm">
            {comments.length === 0 && <p className="text-xs text-slate-500">No comments yet.</p>}
            {comments.map((c) => (
              <div key={c.id} className="group">
                <div className="text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{c.author_name ?? 'Former user'}</span> · {showDateTime(c.created_at)}
                  {(c.author_email === me || canManage) && (
                    <button type="button" className="ml-2 text-red-700 underline" onClick={() => deleteComment(c.id)}>
                      {ACTION.remove}
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-line">{c.body}</p>
              </div>
            ))}
            {!n.archived && (
              <Can permission="notices.comments" level="edit">
                <form
                  className="flex gap-1.5 pt-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void postComment()
                  }}
                >
                  <input
                    aria-label="Write a comment"
                    className={`${narrowInputClass} min-w-0 flex-1 py-1`}
                    maxLength={1000}
                    placeholder="Write a comment…"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                  <button type="submit" disabled={busy || !comment.trim()} className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
                    Post
                  </button>
                </form>
              </Can>
            )}
          </div>
        </Can>
      )}
    </article>
  )
}
