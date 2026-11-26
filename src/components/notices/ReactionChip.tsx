// @permission-scope notices.react, notices.reactions.who
import { useEffect, useRef, useState } from 'react'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import Can from '../Can'

type Person = { emoji: string; user_email: string; name: string }

/**
 * One reaction on a notice ("👍 3"). With "See who reacted", selecting it
 * opens a small list of the people who used that emoji (and a button to add
 * or remove one's own); without it, selecting it adds or removes one's own.
 */
export default function ReactionChip({
  noticeId,
  emoji,
  count,
  mine,
  me,
  disabled,
  onToggle,
}: {
  noticeId: string
  emoji: string
  count: number
  mine: boolean
  me: string
  disabled: boolean
  onToggle: (emoji: string) => void
}) {
  const { can } = usePermissions()
  const canWho = can('notices.reactions.who')
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open || !supabase) return
    let gone = false
    supabase.rpc('notice_reaction_people', { p_notice: noticeId }).then(({ data, error: e }) => {
      if (gone) return
      if (e) setError(friendlyError(e))
      else setPeople(((data as Person[]) ?? []).filter((p) => p.emoji === emoji))
    })
    const away = (ev: PointerEvent) => box.current && !box.current.contains(ev.target as Node) && setOpen(false)
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      gone = true
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open, noticeId, emoji, count])

  const chipClass = `rounded-full border px-2 py-0.5 text-xs ${mine ? 'border-blue-400 bg-blue-50' : 'border-transparent bg-white/70 hover:border-slate-300'}`

  if (!canWho) {
    const plain = (
      <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs">
        {emoji} {count}
      </span>
    )
    return (
      <Can permission="notices.react" level="edit" fallback={plain}>
        <button type="button" disabled={disabled} onClick={() => onToggle(emoji)} aria-pressed={mine} className={chipClass}>
          {emoji} {count}
        </button>
      </Can>
    )
  }

  return (
    <span ref={box} className="relative">
      <Can permission="notices.reactions.who">
        <button
          type="button"
          onClick={() => {
            setPeople(null)
            setError(null)
            setOpen(!open)
          }}
          aria-expanded={open}
          aria-label={`${emoji} ${count}: see who reacted`}
          className={chipClass}
        >
          {emoji} {count}
        </button>
      </Can>
      {open && (
        <span role="dialog" aria-label={`Who reacted with ${emoji}`} className="absolute left-0 top-7 z-20 block w-56 max-w-[calc(100vw-2rem)] rounded-md border border-slate-200 bg-white p-2 text-left text-xs shadow-lg">
          <span className="mb-1 block font-medium text-slate-800">
            {emoji} {count === 1 ? '1 person' : `${count} people`}
          </span>
          {error ? (
            <span className="block text-red-700">{error}</span>
          ) : people === null ? (
            <span className="block text-slate-500">Loading…</span>
          ) : people.length === 0 ? (
            <span className="block text-slate-500">No one has reacted with this yet.</span>
          ) : (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {people.map((p) => (
                <li key={p.user_email} className="truncate text-slate-700">
                  {p.user_email === me ? `${p.name} (you)` : p.name}
                </li>
              ))}
            </ul>
          )}
          <Can permission="notices.react" level="edit">
            <button
              type="button"
              disabled={disabled}
              className="mt-2 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
              onClick={() => {
                setOpen(false)
                onToggle(emoji)
              }}
            >
              {mine ? 'Remove My Reaction' : `React with ${emoji}`}
            </button>
          </Can>
        </span>
      )}
    </span>
  )
}
