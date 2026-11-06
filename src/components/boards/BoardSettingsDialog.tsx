// @permission-scope boards.manage
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { BOARD_COLOURS, LABEL_COLOURS, textOn, type BoardData, type ChecklistPreset, type Label, type Stage } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { buttonClass, Field, inputClass, narrowInputClass, Modal, secondaryButtonClass } from '../form'
import ColourPicker from './ColourPicker'

const small = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-40'

/** Board settings: name, colour, stages, labels, ready-made checklists. */
export default function BoardSettingsDialog({ data, onClose, onChanged }: { data: BoardData; onClose: () => void; onChanged: () => void }) {
  const board = data.board!
  const [name, setName] = useState(board.name)
  const [description, setDescription] = useState(board.description ?? '')
  const [colour, setColour] = useState(board.colour)
  const [soon, setSoon] = useState(String(board.due_soon_days))
  const [newStage, setNewStage] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [labelColour, setLabelColour] = useState(LABEL_COLOURS[0])
  const [presetTitle, setPresetTitle] = useState('')
  const [presetItems, setPresetItems] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) => {
    setBusy(true)
    const { error } = await fn()
    setBusy(false)
    if (error) {
      toast.error(friendlyError(error))
      return false
    }
    if (ok) toast.success(ok)
    onChanged()
    return true
  }

  const stages = data.stages.filter((s) => showArchived || !s.archived)
  const active = data.stages.filter((s) => !s.archived)
  const labels = data.labels.filter((l) => showArchived || !l.archived)

  async function saveBoard(e: FormEvent) {
    e.preventDefault()
    const n = Number(soon)
    if (!name.trim()) return toast.error('The board needs a name.')
    if (!Number.isInteger(n) || n < 0 || n > 60) return toast.error('“Due soon” must be 0 to 60 days.')
    await run(
      () => supabase!.from('boards').update({ name: name.trim(), description: description.trim() || null, colour, due_soon_days: n }).eq('id', board.id),
      'Board saved.',
    )
  }

  const moveStage = (s: Stage, dir: -1 | 1) => {
    const ids = active.map((x) => x.id)
    const i = ids.indexOf(s.id)
    if (i + dir < 0 || i + dir >= ids.length) return
    ;[ids[i], ids[i + dir]] = [ids[i + dir], ids[i]]
    run(() => supabase!.rpc('reorder_board_stages', { p_board: board.id, p_ids: ids }))
  }
  const renameStage = (s: Stage, v: string) => v.trim() && v.trim() !== s.name && run(() => supabase!.from('board_stages').update({ name: v.trim() }).eq('id', s.id))
  const renameLabel = (l: Label, v: string) => v.trim() && v.trim() !== l.name && run(() => supabase!.from('board_labels').update({ name: v.trim() }).eq('id', l.id))
  const savePresets = (list: ChecklistPreset[]) => run(() => supabase!.from('boards').update({ checklist_presets: list }).eq('id', board.id))

  return (
    <Modal
      title="Board settings"
      onClose={onClose}
      busy={busy}
      footer={
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          Done
        </button>
      }
    >
      <form onSubmit={saveBoard} className="space-y-3" noValidate>
        <Field label="Name" htmlFor="bs-name">
          <input id="bs-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="bs-desc">
          <input id="bs-desc" className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Colour">
          <ColourPicker colours={BOARD_COLOURS} value={colour} onChange={setColour} label="Board colour" />
        </Field>
        <Field label="Due dates turn amber this many days before" htmlFor="bs-soon">
          <input id="bs-soon" type="number" min={0} max={60} className={`${narrowInputClass} w-24`} value={soon} onChange={(e) => setSoon(e.target.value)} />
        </Field>
        <button type="submit" className={buttonClass} disabled={busy}>
          Save board
        </button>
      </form>

      <label className="mt-5 flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived stages and labels
      </label>

      <h3 className="mt-3 font-semibold">Stages (columns, left to right)</h3>
      <ul className="mt-2 space-y-1.5">
        {stages.map((s) => {
          const i = active.findIndex((x) => x.id === s.id)
          return (
            <li key={s.id} className={`flex items-center gap-1.5 ${s.archived ? 'opacity-60' : ''}`}>
              <input aria-label={`Stage name ${s.name}`} className={`${inputClass} py-1`} defaultValue={s.name} disabled={s.archived} onBlur={(e) => renameStage(s, e.target.value)} />
              {!s.archived && (
                <>
                  <button type="button" className={small} aria-label={`Move ${s.name} left`} disabled={busy || i === 0} onClick={() => moveStage(s, -1)}>
                    ←
                  </button>
                  <button type="button" className={small} aria-label={`Move ${s.name} right`} disabled={busy || i === active.length - 1} onClick={() => moveStage(s, 1)}>
                    →
                  </button>
                </>
              )}
              <button
                type="button"
                className={small}
                disabled={busy}
                onClick={() => run(() => supabase!.from('board_stages').update({ archived: !s.archived }).eq('id', s.id))}
              >
                {s.archived ? 'Bring back' : 'Archive'}
              </button>
            </li>
          )
        })}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!newStage.trim()) return
          if (await run(() => supabase!.from('board_stages').insert({ board_id: board.id, name: newStage.trim(), sort_order: active.length + 1 }))) setNewStage('')
        }}
      >
        <input aria-label="New stage" className={`${inputClass} py-1`} placeholder="New stage, e.g. Waiting for parts" value={newStage} onChange={(e) => setNewStage(e.target.value)} />
        <button type="submit" className={small} disabled={busy}>
          + Stage
        </button>
      </form>

      <h3 className="mt-5 font-semibold">Labels</h3>
      <ul className="mt-2 space-y-1.5">
        {labels.map((l) => (
          <li key={l.id} className={`flex flex-wrap items-center gap-1.5 ${l.archived ? 'opacity-60' : ''}`}>
            <span className="rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: l.colour, color: textOn(l.colour) }}>
              {l.name}
            </span>
            <input aria-label={`Label name ${l.name}`} className={`${narrowInputClass} w-40 py-1`} defaultValue={l.name} disabled={l.archived} onBlur={(e) => renameLabel(l, e.target.value)} />
            <select
              aria-label={`Colour of ${l.name}`}
              className={`${narrowInputClass} w-28 py-1`}
              value={l.colour}
              disabled={l.archived || busy}
              onChange={(e) => run(() => supabase!.from('board_labels').update({ colour: e.target.value }).eq('id', l.id))}
            >
              {[...new Set([l.colour, ...LABEL_COLOURS])].map((c) => (
                <option key={c} value={c} style={{ backgroundColor: c, color: textOn(c) }}>
                  {c}
                </option>
              ))}
            </select>
            <button type="button" className={small} disabled={busy} onClick={() => run(() => supabase!.from('board_labels').update({ archived: !l.archived }).eq('id', l.id))}>
              {l.archived ? 'Bring back' : 'Archive'}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!newLabel.trim()) return
          if (await run(() => supabase!.from('board_labels').insert({ board_id: board.id, name: newLabel.trim(), colour: labelColour, sort_order: data.labels.length + 1 }))) setNewLabel('')
        }}
      >
        <div className="flex gap-2">
          <input aria-label="New label" className={`${inputClass} py-1`} placeholder="New label, e.g. Urgent" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <button type="submit" className={small} disabled={busy}>
            + Label
          </button>
        </div>
        <ColourPicker colours={LABEL_COLOURS} value={labelColour} onChange={setLabelColour} label="New label colour" />
      </form>

      <h3 className="mt-5 font-semibold">Ready-made checklists</h3>
      <p className="text-xs text-slate-500">Offered when someone adds a checklist to a card on this board.</p>
      <ul className="mt-2 space-y-1 text-sm">
        {board.checklist_presets.map((p, i) => (
          <li key={`${p.title}-${i}`} className="flex items-start gap-2">
            <span className="flex-1">
              <strong>{p.title}</strong> <span className="text-slate-500">· {p.items.join(', ') || 'no tasks'}</span>
            </span>
            <button type="button" className={small} disabled={busy} onClick={() => savePresets(board.checklist_presets.filter((_, j) => j !== i))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!presetTitle.trim()) return
          const items = presetItems.split('\n').map((x) => x.trim()).filter(Boolean)
          if (await savePresets([...board.checklist_presets, { title: presetTitle.trim(), items }])) {
            setPresetTitle('')
            setPresetItems('')
          }
        }}
      >
        <input aria-label="Checklist name" className={`${inputClass} py-1`} placeholder="Checklist name, e.g. Before shipping" value={presetTitle} onChange={(e) => setPresetTitle(e.target.value)} />
        <textarea aria-label="Checklist tasks" className={inputClass} rows={3} placeholder="One task per line" value={presetItems} onChange={(e) => setPresetItems(e.target.value)} />
        <button type="submit" className={small} disabled={busy}>
          + Ready-made checklist
        </button>
      </form>
    </Modal>
  )
}
