// @permission-scope chat.members
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { inputClass, secondaryButtonClass } from '../form'
import { StatusDot } from './ChatList'
import { askText, confirmAction } from '../../lib/confirm'
import { chatTime, KIND_LABEL, linkHref, NOTIFY_LABEL, type ChatLink, type ConversationRow, type Member, type NotifyMode, type Person, type Status } from '../../lib/chat'
import { activityTime } from '../../lib/activity'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

/** Details of a conversation: who is in it, my notifications for it, and (group chats) rename / add / leave. */
export default function ConversationInfo({
  row,
  members,
  names,
  people,
  me,
  presence,
  onClose,
  onChanged,
}: {
  row: ConversationRow
  members: Member[]
  names: Map<string, string>
  people: Person[]
  me: string
  presence: Map<string, Status>
  onClose: () => void
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const [adding, setAdding] = useState('')
  type Shared = { id: string; author_name: string | null; body_text: string; links: ChatLink[]; pinned_at: string | null; pinned_by: string | null; created_at: string }
  const [links, setLinks] = useState<Shared[]>([])
  const [pins, setPins] = useState<Shared[]>([])

  // Shared links and pinned messages of the whole conversation (that I can still see).
  useEffect(() => {
    if (!supabase) return
    const cols = 'id, author_name, body_text, links, pinned_at, pinned_by, created_at'
    supabase
      .from('chat_messages')
      .select(cols)
      .eq('conversation_id', row.id)
      .is('deleted_at', null)
      .neq('links', '[]')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => setLinks((data as Shared[]) ?? []))
    supabase
      .from('chat_messages')
      .select(cols)
      .eq('conversation_id', row.id)
      .not('pinned_at', 'is', null)
      .order('pinned_at', { ascending: false })
      .limit(100)
      .then(({ data }) => setPins((data as Shared[]) ?? []))
  }, [row.id])
  const shared = links.flatMap((m) => m.links.map((l) => ({ ...l, at: m.created_at, by: m.author_name, msg: m.id })))
  const uniqueShared = shared.filter((l, i) => shared.findIndex((x) => x.type === l.type && x.id === l.id) === i)
  const isGroup = row.kind === 'group'
  const mineOwner = members.some((m) => m.user_email === me && m.role === 'owner')
  const active = members
    .filter((m) => !m.removed)
    .sort((a, b) => (names.get(a.user_email) ?? a.user_email).localeCompare(names.get(b.user_email) ?? b.user_email))

  async function call(fn: () => PromiseLike<{ error: unknown }>, done?: string) {
    const { error } = await fn()
    if (error) return toast.error(friendlyError(error as Parameters<typeof friendlyError>[0]))
    if (done) toast.success(done)
    onChanged()
  }

  async function rename() {
    const name = await askText('Enter a new name for the group chat.', { initial: row.name ?? '', label: 'Name', confirmLabel: 'Rename' })
    if (name?.trim()) void call(() => supabase!.rpc('update_group_chat', { p_conv: row.id, p_name: name.trim(), p_add: null, p_remove: null }), 'Renamed.')
  }

  async function leave() {
    if (!(await confirmAction(`Leave “${row.name}”? You will no longer see its messages.`, { confirmLabel: 'Leave Group Chat', danger: true }))) return
    const { error } = await supabase!.rpc('leave_chat', { p_conv: row.id })
    if (error) return toast.error(friendlyError(error))
    onChanged()
    navigate('/chat')
  }

  const candidates = people.filter((p) => !active.some((m) => m.user_email === p.email))
  return (
    <div className="space-y-4 p-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Details</h3>
        <button type="button" aria-label="Close" className="px-2 text-lg" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="text-slate-600">
        <p>{KIND_LABEL[row.kind].replace(/s$/, '')}</p>
        {row.created_at && (
          <p className="text-xs">
            {row.created_by ? `Started by ${names.get(row.created_by) ?? row.created_by}` : 'Made automatically'} · {activityTime.format(new Date(row.created_at))}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="ci-notify" className="mb-1 block font-medium">
          Notifications for this conversation
        </label>
        <select
          id="ci-notify"
          className={inputClass}
          value={row.notify}
          onChange={(e) =>
            void call(() => supabase!.rpc('set_chat_notify', { p_conv: row.id, p_mode: e.target.value as NotifyMode }), 'Notifications updated.')
          }
        >
          {(Object.keys(NOTIFY_LABEL) as NotifyMode[]).map((k) => (
            <option key={k} value={k}>
              {NOTIFY_LABEL[k]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">Quiet hours (no phone notifications at night) are in Settings → Notifications.</p>
      </div>

      <div>
        <h4 className="mb-1 font-medium">Members ({active.length})</h4>
        <ul className="space-y-1">
          {active.map((m) => (
            <li key={m.user_email} className="flex items-center gap-2">
              <Can permission="chat.presence">
                <StatusDot status={presence.get(m.user_email)} />
              </Can>
              <span className="min-w-0 flex-1 truncate">
                {names.get(m.user_email) ?? m.user_email}
                {m.user_email === me ? ' (you)' : ''}
                {m.role === 'owner' ? <span className="text-xs text-slate-500"> · started the group</span> : null}
              </span>
              {isGroup && mineOwner && m.user_email !== me && (
                <Can permission="chat.groups" level="edit">
                  <button
                    type="button"
                    className="text-xs text-red-700 underline"
                    onClick={() =>
                      void call(() => supabase!.rpc('update_group_chat', { p_conv: row.id, p_name: null, p_add: null, p_remove: [m.user_email] }), 'Removed.')
                    }
                  >
                    Remove
                  </button>
                </Can>
              )}
            </li>
          ))}
        </ul>
        {!isGroup && row.kind !== 'direct' && (
          <p className="mt-1 text-xs text-slate-500">Members follow the department or group. An admin manages channels in Admin → Chat.</p>
        )}
      </div>

      <div>
        <h4 className="mb-1 font-medium">Pinned Messages ({pins.length})</h4>
        {pins.length === 0 ? (
          <p className="text-xs text-slate-500">No pinned messages.</p>
        ) : (
          <ul className="space-y-1.5">
            {pins.map((m) => (
              <li key={m.id}>
                <Link to={`/chat/${row.id}?m=${m.id}`} className="block rounded border border-slate-200 p-2 hover:bg-slate-50">
                  <span className="block text-xs text-slate-500">
                    {m.author_name} · {chatTime(m.created_at)}
                    {m.pinned_by && ` · pinned by ${m.pinned_by}`}
                  </span>
                  <span className="line-clamp-2">{m.body_text}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-1 font-medium">Shared Links ({uniqueShared.length})</h4>
        {uniqueShared.length === 0 ? (
          <p className="text-xs text-slate-500">No orders, machines, boards or cards have been mentioned yet.</p>
        ) : (
          <ul className="space-y-1">
            {uniqueShared.map((l) => (
              <li key={`${l.type}-${l.id}`} className="flex items-baseline justify-between gap-2">
                <a href={linkHref(l)} className="min-w-0 truncate text-blue-700 underline">
                  {l.text}
                </a>
                <Link to={`/chat/${row.id}?m=${l.msg}`} className="shrink-0 text-xs text-slate-500 underline">
                  {chatTime(l.at)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isGroup && (
        <Can permission="chat.groups" level="edit">
          <div className="space-y-2 border-t border-slate-200 pt-3">
            <div className="flex gap-2">
              <select aria-label="Add a person" className={inputClass} value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Add a person…</option>
                {candidates.map((p) => (
                  <option key={p.email} value={p.email}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={!adding}
                onClick={() => {
                  void call(() => supabase!.rpc('update_group_chat', { p_conv: row.id, p_name: null, p_add: [adding], p_remove: null }), 'Added.')
                  setAdding('')
                }}
              >
                Add
              </button>
            </div>
            <div className="flex gap-3">
              <button type="button" className="underline" onClick={rename}>
                Rename
              </button>
              <button type="button" className="text-red-700 underline" onClick={leave}>
                Leave Group Chat
              </button>
            </div>
          </div>
        </Can>
      )}
    </div>
  )
}
