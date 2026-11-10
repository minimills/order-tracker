// @permission-scope admin.chat
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, inputClass, secondaryButtonClass } from '../../components/form'
import { chatTime, type Person } from '../../lib/chat'
import { askText, confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Channel = {
  id: string
  kind: 'department' | 'user_group' | 'channel'
  name: string
  archived: boolean
  members: number
  removed: number
  last_message_at: string | null
}
type ChannelMember = { email: string; name: string; removed: boolean }
const KIND = { department: 'Department', user_group: 'Group', channel: 'Channel' }

/** Admin → Chat: channels only (department, group and other channels). Direct messages and group chats are private. */
export default function ChatChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [members, setMembers] = useState<ChannelMember[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [adding, setAdding] = useState('')
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.rpc('admin_chat_channels')
    if (error) return toast.error(friendlyError(error))
    setChannels((data as Channel[] | null) ?? [])
  }, [])

  const loadMembers = useCallback(async (id: string) => {
    if (!supabase) return
    const { data } = await supabase.rpc('admin_chat_channel_members', { p_conv: id })
    setMembers((data as ChannelMember[] | null) ?? [])
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
    supabase?.rpc('chat_people').then(({ data }) => setPeople((data as Person[] | null) ?? []))
  }, [load])

  async function update(id: string, p: { name?: string; archived?: boolean; add?: string[]; remove?: string[]; restore?: string[] }, done: string) {
    if (!supabase) return
    const { error } = await supabase.rpc('admin_update_chat_channel', {
      p_conv: id,
      p_name: p.name ?? null,
      p_archived: p.archived ?? null,
      p_add: p.add ?? null,
      p_remove: p.remove ?? null,
      p_restore: p.restore ?? null,
    })
    if (error) return toast.error(friendlyError(error))
    toast.success(done)
    load()
    if (open) loadMembers(open)
  }

  async function create() {
    if (!supabase) return
    if (!newName.trim()) return toast.error('Give the channel a name.')
    const { error } = await supabase.rpc('admin_create_chat_channel', { p_name: newName.trim(), p_emails: [] })
    if (error) return toast.error(friendlyError(error))
    setNewName('')
    toast.success('Channel created. Add its members below.')
    load()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <AdminPageHeader title="Chat Channels">
        Every department and group has a channel; its members follow the department or group automatically. You can also make other channels. Direct messages
        and group chats are private to the people in them and are not listed here.
      </AdminPageHeader>

      <section className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-4">
        <input
          aria-label="New channel name"
          className={`${inputClass} flex-1`}
          placeholder="New channel, for example Everyone"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="button" className={buttonClass} onClick={create}>
          Create Channel
        </button>
      </section>

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {channels.length === 0 && <li className="p-4 text-sm text-slate-500">No channels yet.</li>}
        {channels.map((c) => (
          <li key={c.id} className={`p-3 text-sm ${c.archived ? 'bg-slate-50 text-slate-500' : ''}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-slate-500">
                  {' '}
                  · {KIND[c.kind]} · {c.members} member{c.members === 1 ? '' : 's'}
                  {c.removed ? ` · ${c.removed} removed` : ''}
                  {c.last_message_at ? ` · last message ${chatTime(c.last_message_at)}` : ''}
                  {c.archived ? ' · archived' : ''}
                </span>
              </span>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  const next = open === c.id ? null : c.id
                  setOpen(next)
                  if (next) loadMembers(next)
                }}
              >
                Members
              </button>
              <button
                type="button"
                className="underline"
                onClick={async () => {
                  const name = await askText('Enter a new name for the channel.', { initial: c.name, label: 'Channel name', confirmLabel: 'Rename' })
                  if (name?.trim()) update(c.id, { name: name.trim() }, 'Renamed.')
                }}
              >
                Rename
              </button>
              {c.archived ? (
                <button type="button" className="underline" onClick={() => update(c.id, { archived: false }, 'Restored.')}>
                  Restore
                </button>
              ) : (
                <button
                  type="button"
                  className="text-red-700 underline"
                  onClick={async () => {
                    if (
                      await confirmAction(`Archive “${c.name}”? Its members can still read it, but nobody can write in it.`, {
                        confirmLabel: 'Archive',
                        danger: true,
                      })
                    )
                      update(c.id, { archived: true }, 'Archived.')
                  }}
                >
                  Archive
                </button>
              )}
            </div>
            {open === c.id && (
              <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-3">
                <ul className="space-y-1">
                  {members.map((m) => (
                    <li key={m.email} className="flex items-center gap-2">
                      <span className={`min-w-0 flex-1 ${m.removed ? 'text-slate-400 line-through' : ''}`}>
                        {m.name} <span className="text-xs text-slate-500">{m.email}</span>
                      </span>
                      {m.removed ? (
                        <button type="button" className="text-xs underline" onClick={() => update(c.id, { restore: [m.email] }, 'Restored.')}>
                          Restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-xs text-red-700 underline"
                          onClick={() => update(c.id, { remove: [m.email] }, 'Removed from the channel.')}
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {c.kind !== 'channel' && (
                  <p className="text-xs text-slate-500">
                    Removing someone keeps them out of this channel even while they stay in the {c.kind === 'department' ? 'department' : 'group'}.
                  </p>
                )}
                <div className="flex gap-2">
                  <select aria-label="Add a member" className={inputClass} value={adding} onChange={(e) => setAdding(e.target.value)}>
                    <option value="">Add a person…</option>
                    {people
                      .filter((p) => !members.some((m) => m.email === p.email && !m.removed))
                      .map((p) => (
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
                      update(c.id, { add: [adding] }, 'Added.')
                      setAdding('')
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
