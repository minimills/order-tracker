// @permission-scope notices.my_notes
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { colourOf, NOTE_COLOURS, showDateTime, tiltOf, toLocalInput, type ChecklistItem, type PersonalNote } from '../../lib/notices'
import { supabase } from '../../lib/supabase'
import { ACTION, confirmText } from '../../lib/wording'
import Can from '../Can'
import Icon from '../Icon'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'

const NOTE_WIDTH = 240 // px
const COLUMNS = 'id, title, body, colour, checklist, pos_x, pos_y, z, remind_at, reminded_at, updated_at, archived, archived_at'
const newId = () => Math.random().toString(36).slice(2, 10)

/** Wide screens get the board you can arrange; phones get a simple list. */
function useWide() {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const m = window.matchMedia('(min-width: 768px)')
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * My notes: private sticky notes (nobody else can see them, admins included).
 * Drag a note by its top strip to arrange it; the place is saved.
 */
export default function MyNotes({ highlightId }: { highlightId: string | null }) {
  const [all, setAll] = useState<PersonalNote[] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  // The board shows notes that are not archived; "Archived Notes" shows the rest.
  const notes = all?.filter((n) => !n.archived) ?? null
  const archived = (all ?? []).filter((n) => n.archived).sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''))
  const setNotes = (fn: (list: PersonalNote[] | null) => PersonalNote[] | null) => setAll((list) => {
    const active = list?.filter((n) => !n.archived) ?? null
    const next = fn(active)
    return next ? [...next, ...(list ?? []).filter((n) => n.archived)] : list
  })
  const [editing, setEditing] = useState<PersonalNote | 'new' | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null)
  const wide = useWide()

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('personal_notes').select(COLUMNS).order('pos_y').order('pos_x')
    if (error) return toast.error(friendlyError(error))
    setAll((data as PersonalNote[]) ?? [])
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  useEffect(() => {
    if (highlightId && notes) document.getElementById(`note-${highlightId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightId, notes])

  async function update(id: string, patch: Partial<PersonalNote>) {
    setNotes((all) => all?.map((n) => (n.id === id ? { ...n, ...patch } : n)) ?? null)
    const { error } = await supabase!.from('personal_notes').update(patch).eq('id', id)
    if (error) {
      toast.error(friendlyError(error))
      void load()
    }
  }

  async function archive(n: PersonalNote, value: boolean) {
    const { error } = await supabase!.from('personal_notes').update({ archived: value }).eq('id', n.id)
    if (error) return toast.error(friendlyError(error))
    toast.success(value ? 'Note archived. Find it under Archived Notes.' : 'Note restored to your board.')
    void load()
  }

  async function remove(n: PersonalNote) {
    if (!(await confirmAction(confirmText.permanentlyDelete('this note'), { confirmLabel: ACTION.permanentlyDelete, danger: true }))) return
    const { error } = await supabase!.from('personal_notes').delete().eq('id', n.id)
    if (error) return toast.error(friendlyError(error))
    setAll((list) => list?.filter((x) => x.id !== n.id) ?? null)
  }

  // Dragging (pointer events work for mouse, pen and touch).
  function onPointerDown(e: ReactPointerEvent, n: PersonalNote) {
    if (!wide || !boardRef.current) return
    const box = boardRef.current.getBoundingClientRect()
    const left = (n.pos_x / 100) * box.width
    drag.current = { id: n.id, dx: e.clientX - box.left - left, dy: e.clientY - box.top - n.pos_y, moved: false }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    // Bring the note to the front.
    const top = Math.max(0, ...(notes ?? []).map((x) => x.z)) + 1
    setNotes((all) => all?.map((x) => (x.id === n.id ? { ...x, z: top } : x)) ?? null)
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current
    if (!d || !boardRef.current) return
    const box = boardRef.current.getBoundingClientRect()
    const maxX = Math.max(0, 100 - (NOTE_WIDTH / box.width) * 100)
    const x = Math.min(maxX, Math.max(0, ((e.clientX - box.left - d.dx) / box.width) * 100))
    const y = Math.min(20000, Math.max(0, Math.round(e.clientY - box.top - d.dy)))
    d.moved = true
    setNotes((all) => all?.map((n) => (n.id === d.id ? { ...n, pos_x: Math.round(x * 100) / 100, pos_y: y } : n)) ?? null)
  }
  function onPointerUp() {
    const d = drag.current
    drag.current = null
    if (!d) return
    const n = notes?.find((x) => x.id === d.id)
    if (n) void update(n.id, { pos_x: n.pos_x, pos_y: n.pos_y, z: n.z })
  }

  const height = Math.max(560, ...(notes ?? []).map((n) => n.pos_y + 340))
  const ordered = [...(notes ?? [])].sort((a, b) => a.pos_y - b.pos_y || a.pos_x - b.pos_x)

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm text-slate-600">
          <Icon name="lock" /> Only you can see these notes.{wide ? ' Drag a note by its top strip to arrange the board.' : ''}
        </p>
        <Can permission="notices.my_notes" level="edit">
          <div className="flex gap-2">
            <button type="button" className={secondaryButtonClass} aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Back to My Board' : `Archived Notes${archived.length ? ` (${archived.length})` : ''}`}
            </button>
            {!showArchived && (
              <button type="button" className={buttonClass} onClick={() => setEditing('new')}>
                New Note
              </button>
            )}
          </div>
        </Can>
      </div>

      {showArchived ? (
        archived.length === 0 ? (
          <div className="rounded-xl border-4 border-slate-200 bg-white p-10 text-center text-sm text-slate-500">You have no archived notes.</div>
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
            {archived.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                highlight={n.id === highlightId}
                onRestore={() => archive(n, false)}
                onDelete={() => remove(n)}
                onToggle={() => undefined}
              />
            ))}
          </div>
        )
      ) : null}

      {showArchived ? null : notes === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : notes.length === 0 ? (
        <div className="rounded-xl border-4 border-slate-200 bg-white p-10 text-center text-sm text-slate-500">You have no notes yet. Select New Note to add one.</div>
      ) : wide ? (
        <div
          ref={boardRef}
          className="relative rounded-xl border-[10px] border-slate-300 bg-[#fbfcfd] shadow-inner dark:bg-[#172235]"
          style={{ height, backgroundImage: 'radial-gradient(#e2e8f0 1px, transparent 1px)', backgroundSize: '22px 22px' }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              highlight={n.id === highlightId}
              style={{ position: 'absolute', left: `${n.pos_x}%`, top: n.pos_y, width: NOTE_WIDTH, zIndex: n.z, '--tilt': tiltOf(n.id) } as CSSProperties}
              onGrab={(e) => onPointerDown(e, n)}
              onEdit={() => setEditing(n)}
              onArchive={() => archive(n, true)}
              onToggle={(item) => update(n.id, { checklist: n.checklist.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)) })}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {ordered.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              highlight={n.id === highlightId}
              onEdit={() => setEditing(n)}
              onArchive={() => archive(n, true)}
              onToggle={(item) => update(n.id, { checklist: n.checklist.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)) })}
            />
          ))}
        </div>
      )}

      {editing && (
        <NoteDialog
          note={editing === 'new' ? null : editing}
          nextSpot={() => {
            const count = notes?.length ?? 0
            return { pos_x: (count % 4) * 24 + 1, pos_y: Math.floor(count / 4) * 300 + 24, z: Math.max(0, ...(notes ?? []).map((x) => x.z)) + 1 }
          }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

function NoteCard({
  note: n,
  style,
  highlight,
  onGrab,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  onToggle,
}: {
  note: PersonalNote
  style?: CSSProperties
  highlight: boolean
  onGrab?: (e: ReactPointerEvent) => void
  onEdit?: () => void
  /** Board: Archive. Archived Notes view: Restore and Permanently Delete. */
  onArchive?: () => void
  onRestore?: () => void
  onDelete?: () => void
  onToggle: (item: ChecklistItem) => void
}) {
  const c = colourOf(n.colour)
  const done = n.checklist.filter((i) => i.done).length
  return (
    <article
      id={`note-${n.id}`}
      style={{ ...style, backgroundColor: c.paper, borderColor: c.edge }}
      className={`keep-light rounded-sm border text-sm text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.08),0_6px_14px_-6px_rgba(15,23,42,0.25)] md:[rotate:var(--tilt)] ${
        highlight ? 'outline outline-3 outline-offset-4 outline-blue-500' : ''
      }`}
    >
      <div
        onPointerDown={onGrab}
        className={`flex items-center justify-between gap-2 border-b border-black/5 px-3 py-1.5 ${onGrab ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''}`}
        title={onGrab ? 'Drag to move' : undefined}
      >
        <span className="truncate font-semibold text-slate-900">{n.title || 'Note'}</span>
        <span className="flex shrink-0 gap-2 text-xs" onPointerDown={(e) => e.stopPropagation()}>
          <Can permission="notices.my_notes" level="edit">
            {onEdit && (
              <button type="button" className="underline" onClick={onEdit}>
                {ACTION.edit}
              </button>
            )}
            {onArchive && (
              <button type="button" className="underline" onClick={onArchive}>
                {ACTION.archive}
              </button>
            )}
            {onRestore && (
              <button type="button" className="underline" onClick={onRestore}>
                {ACTION.restore}
              </button>
            )}
            {onDelete && (
              <button type="button" className="text-red-700 underline" onClick={onDelete}>
                {ACTION.permanentlyDelete}
              </button>
            )}
          </Can>
        </span>
      </div>
      <div className="space-y-2 px-3 py-2">
        {n.body && <p className="whitespace-pre-line">{n.body}</p>}
        {n.checklist.length > 0 && (
          <div>
            <div className="text-xs text-slate-500">
              {done} of {n.checklist.length} completed
            </div>
            <ul className="mt-1 space-y-1">
              {n.checklist.map((i) => (
                <li key={i.id} className="flex items-start gap-2">
                  <Can permission="notices.my_notes" level="edit">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0"
                      checked={i.done}
                      onChange={() => onToggle(i)}
                      aria-label={i.done ? `${ACTION.markIncomplete}: ${i.text}` : `${ACTION.markComplete}: ${i.text}`}
                    />
                  </Can>
                  <span className={i.done ? 'text-slate-500 line-through' : ''}>{i.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {n.remind_at && (
          <div className="flex items-center gap-1 text-xs text-slate-600">
            <Icon name="bell" className="h-3.5 w-3.5" /> {n.reminded_at ? 'Reminder sent' : 'Reminder'} {showDateTime(n.remind_at)}
          </div>
        )}
      </div>
    </article>
  )
}

function NoteDialog({
  note,
  nextSpot,
  onClose,
  onSaved,
}: {
  note: PersonalNote | null
  nextSpot: () => Pick<PersonalNote, 'pos_x' | 'pos_y' | 'z'>
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(note?.title ?? '')
  const [body, setBody] = useState(note?.body ?? '')
  const [colour, setColour] = useState(note?.colour ?? 'yellow')
  const [items, setItems] = useState<ChecklistItem[]>(note?.checklist ?? [])
  const [newItem, setNewItem] = useState('')
  const [remind, setRemind] = useState(toLocalInput(note?.remind_at ?? null))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addItem() {
    if (!newItem.trim()) return
    if (items.length >= 50) return setError('A note can have up to 50 checklist items.')
    setItems([...items, { id: newId(), text: newItem.trim().slice(0, 200), done: false }])
    setNewItem('')
  }

  async function save() {
    if (!supabase) return
    if (!title.trim() && !body.trim() && items.length === 0) return setError('Write something on the note first.')
    const remindAt = remind ? new Date(remind) : null
    if (remindAt && Number.isNaN(remindAt.getTime())) return setError('Enter the reminder date and time.')
    setBusy(true)
    setError(null)
    const row = { title: title.trim(), body: body.trim(), colour, checklist: newItem.trim() ? [...items, { id: newId(), text: newItem.trim(), done: false }] : items, remind_at: remindAt?.toISOString() ?? null }
    const { error: e } = note ? await supabase.from('personal_notes').update(row).eq('id', note.id) : await supabase.from('personal_notes').insert({ ...row, ...nextSpot() })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    if (remindAt && remindAt.getTime() > Date.now() && remind !== toLocalInput(note?.remind_at ?? null)) toast.success(`Reminder set for ${showDateTime(remindAt.toISOString())}`)
    onSaved()
  }

  return (
    <Modal
      title={note ? 'Edit Note' : 'New Note'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <Can permission="notices.my_notes" level="edit">
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              {busy ? ACTION.saving : note ? ACTION.save : 'Create Note'}
            </button>
          </Can>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title (optional)" htmlFor="pn-title">
          <input id="pn-title" className={inputClass} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="pn-body">
          <textarea id="pn-body" rows={4} className={inputClass} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">Colour</legend>
          <div className="flex flex-wrap gap-2">
            {NOTE_COLOURS.map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.label}
                aria-label={c.label}
                aria-pressed={colour === c.value}
                onClick={() => setColour(c.value)}
                style={{ backgroundColor: c.paper, borderColor: c.edge }}
                className={`h-8 w-8 rounded border-2 ${colour === c.value ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">Checklist</legend>
          {items.length > 0 && (
            <ul className="mb-2 space-y-1">
              {items.map((i) => (
                <li key={i.id} className="flex items-center gap-2">
                  <input
                    aria-label="Checklist item"
                    className={`${narrowInputClass} min-w-0 flex-1 py-1`}
                    value={i.text}
                    maxLength={200}
                    onChange={(e) => setItems(items.map((x) => (x.id === i.id ? { ...x, text: e.target.value } : x)))}
                  />
                  <button type="button" className="px-1 text-red-700" aria-label={`${ACTION.remove} ${i.text}`} onClick={() => setItems(items.filter((x) => x.id !== i.id))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              aria-label="New checklist item"
              className={`${narrowInputClass} min-w-0 flex-1`}
              placeholder="Add an item…"
              value={newItem}
              maxLength={200}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addItem()
                }
              }}
            />
            <button type="button" className={secondaryButtonClass} onClick={addItem}>
              {ACTION.add}
            </button>
          </div>
        </fieldset>
        <Field label="Reminder (optional)" htmlFor="pn-remind" hint="You get a notification in the app and on your phone at this time.">
          <div className="flex gap-2">
            <input id="pn-remind" type="datetime-local" className={inputClass} value={remind} onChange={(e) => setRemind(e.target.value)} />
            {remind && (
              <button type="button" className={secondaryButtonClass} onClick={() => setRemind('')}>
                {ACTION.remove}
              </button>
            )}
          </div>
        </Field>
        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
