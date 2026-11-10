// @permission-scope chat
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import { useAuth } from '../../lib/auth'
import type { Person } from '../../lib/chat'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'

/** Start a direct message (one person) or a group chat (a name and several people). */
export default function NewChatDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { can } = usePermissions()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const navigate = useNavigate()
  const [mode, setMode] = useState<'direct' | 'group'>(can('chat.direct', 'edit') ? 'direct' : 'group')
  const [people, setPeople] = useState<Person[]>([])
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase?.rpc('chat_people').then(({ data }) => setPeople(((data as Person[] | null) ?? []).filter((p) => p.email !== me)))
  }, [me])

  const shown = people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q.trim().toLowerCase()))

  async function startDirect(email: string) {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('start_direct_chat', { p_email: email })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    onCreated()
    navigate(`/chat/${data as string}`)
  }

  async function createGroup() {
    if (!supabase) return
    if (!name.trim()) return toast.error('Give the group chat a name.')
    if (!picked.size) return toast.error('Pick at least one person.')
    setBusy(true)
    const { data, error } = await supabase.rpc('create_group_chat', { p_name: name.trim(), p_emails: [...picked] })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    onCreated()
    navigate(`/chat/${data as string}`)
  }

  return (
    <Modal
      title="New Chat"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {mode === 'group' && (
            <Can permission="chat.groups" level="edit">
              <button type="button" className={buttonClass} onClick={createGroup} disabled={busy}>
                Create Group Chat
              </button>
            </Can>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2" role="tablist">
          <Can permission="chat.direct" level="edit">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'direct'}
              className={mode === 'direct' ? buttonClass : secondaryButtonClass}
              onClick={() => setMode('direct')}
            >
              Direct Message
            </button>
          </Can>
          <Can permission="chat.groups" level="edit">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'group'}
              className={mode === 'group' ? buttonClass : secondaryButtonClass}
              onClick={() => setMode('group')}
            >
              Group Chat
            </button>
          </Can>
        </div>
        {mode === 'group' && (
          <Field label="Group chat name" htmlFor="nc-name">
            <input id="nc-name" className={inputClass} value={name} placeholder="For example Calgary install" onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <input type="search" aria-label="Find a person" className={inputClass} placeholder="Find a person" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200 text-sm">
          {shown.length === 0 && <li className="p-3 text-slate-500">No one matches.</li>}
          {shown.map((p) => (
            <li key={p.email}>
              {mode === 'direct' ? (
                <button type="button" className="w-full px-3 py-2 text-left hover:bg-slate-50" disabled={busy} onClick={() => startDirect(p.email)}>
                  {p.name} <span className="text-xs text-slate-500">{p.email}</span>
                </button>
              ) : (
                <label className="flex items-center gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={picked.has(p.email)}
                    onChange={() =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (n.has(p.email)) n.delete(p.email)
                        else n.add(p.email)
                        return n
                      })
                    }
                  />
                  {p.name} <span className="text-xs text-slate-500">{p.email}</span>
                </label>
              )}
            </li>
          ))}
        </ul>
        {mode === 'group' && <p className="text-xs text-slate-500">{picked.size} selected. Only the people in a group chat can read it.</p>}
      </div>
    </Modal>
  )
}
