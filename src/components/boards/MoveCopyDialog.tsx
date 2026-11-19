// @permission-scope boards.card.copy, boards.card.move, boards.card.move_board, boards.stage.move_all
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { loadBoardChoices, type BoardChoice, type Stage } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'

type Mode = 'move' | 'copy'

/**
 * Move or copy one card (`card`) or every card of a stage (`stage`) to a stage
 * of this or another board the person can work on. Moving keeps the card's
 * history; a copy keeps its checklists, labels, description and links.
 * Machine, leftover and service call cards stay on their own board.
 */
export default function MoveCopyDialog({
  boardId,
  card,
  stage,
  initialMode,
  onClose,
  onDone,
}: {
  boardId: string
  card?: { id: string; title: string; card_kind: string; stage_id: string }
  stage?: { id: string; name: string; count: number }
  initialMode: Mode
  onClose: () => void
  /** Called after saving with the board the card(s) went to. */
  onDone: (targetBoard: string) => void
}) {
  const { can } = usePermissions()
  const [mode, setMode] = useState<Mode>(initialMode)
  const [boards, setBoards] = useState<BoardChoice[] | null>(null)
  const [target, setTarget] = useState(boardId)
  const [stages, setStages] = useState<Stage[]>([])
  const [stageId, setStageId] = useState('')
  const [place, setPlace] = useState<'top' | 'bottom'>('bottom')
  const [busy, setBusy] = useState(false)

  const mayMove = stage ? can('boards.stage.move_all', 'edit') : can('boards.card.move', 'edit')
  const mayCopy = stage ? can('boards.stage.move_all', 'edit') && can('boards.card.copy', 'edit') : can('boards.card.copy', 'edit')
  const mayOtherBoard = mode === 'copy' || can('boards.card.move_board', 'edit')
  const staysOnBoard = mode === 'move' && card && card.card_kind !== 'task'

  useEffect(() => {
    // Boards the person can put cards on (the database checks again).
    supabase?.rpc('my_editable_boards').then(({ data, error }) => {
      if (error) loadBoardChoices().then(setBoards)
      else setBoards((data as BoardChoice[]) ?? [])
    })
  }, [])
  useEffect(() => {
    if (!supabase || !target) return
    supabase
      .from('board_stages')
      .select('*')
      .eq('board_id', target)
      .eq('archived', false)
      .order('sort_order')
      .then(({ data }) => {
        const list = (data as Stage[]) ?? []
        setStages(list)
        setStageId((cur) => (list.some((s) => s.id === cur) ? cur : (list.find((s) => s.id !== (stage?.id ?? '')) ?? list[0])?.id ?? ''))
      })
  }, [target, stage?.id])

  const choices = useMemo(() => (boards ?? []).filter((b) => b.id === boardId || (mayOtherBoard && !staysOnBoard)), [boards, boardId, mayOtherBoard, staysOnBoard])
  const what = card ? `“${card.title}”` : `the ${stage!.count} card${stage!.count === 1 ? '' : 's'} in ${stage!.name}`

  async function save() {
    if (!supabase || !stageId) return
    if (stage && stageId === stage.id) return toast.error('Choose another stage.')
    setBusy(true)
    let error: { message: string } | null = null
    let message = ''
    if (stage) {
      const r = await supabase.rpc('move_stage_cards', { p_stage: stage.id, p_board: target, p_target_stage: stageId, p_copy: mode === 'copy' })
      error = r.error
      const res = (r.data ?? { done: 0, skipped: 0 }) as { done: number; skipped: number }
      message = `${res.done} card${res.done === 1 ? '' : 's'} ${mode === 'copy' ? 'copied' : 'moved'}.${res.skipped ? ` ${res.skipped} machine or service call card${res.skipped === 1 ? '' : 's'} stayed on this board.` : ''}`
    } else if (card) {
      const index = place === 'top' ? 0 : null
      const r =
        mode === 'copy'
          ? await supabase.rpc('copy_board_card', { p_card: card.id, p_board: target, p_stage: stageId, p_index: index })
          : await supabase.rpc('move_card_to_board', { p_card: card.id, p_board: target, p_stage: stageId, p_index: index })
      error = r.error
      message = mode === 'copy' ? 'Card copied.' : 'Card moved.'
    }
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(message)
    onDone(target)
  }

  return (
    <Modal
      title={stage ? `${mode === 'copy' ? 'Copy' : 'Move'} All Cards in ${stage.name}` : `${mode === 'copy' ? 'Copy' : 'Move'} Card`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={busy || !stageId || (mode === 'move' ? !mayMove : !mayCopy)}>
            {busy ? ACTION.saving : mode === 'copy' ? (stage ? 'Copy All Cards' : 'Copy Card') : stage ? 'Move All Cards' : 'Move Card'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex gap-2" role="radiogroup" aria-label="Move or copy">
          {(['move', 'copy'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={m === 'move' ? !mayMove : !mayCopy}
              className={`flex-1 rounded-md border px-3 py-2 font-medium disabled:opacity-40 ${mode === m ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
              onClick={() => setMode(m)}
            >
              {m === 'move' ? 'Move' : 'Copy'}
            </button>
          ))}
        </div>
        <p className="text-slate-600">
          {mode === 'move'
            ? `Moves ${what}. ${card ? 'Its history, comments, checklists and timers go with it.' : 'Their history goes with them.'} Labels are matched by name on another board; people who cannot open that board are taken off.`
            : `Copies ${what} with ${card ? 'its' : 'their'} checklists (not started), labels, description and links. The original stays where it is.`}
        </p>
        {staysOnBoard && <p className="rounded bg-amber-50 p-2 text-amber-900">This card belongs to its board, so it can only move to another stage here. Use Copy to put a copy on another board.</p>}
        <Field label="Board" htmlFor="mc-board">
          <select id="mc-board" className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
            {boards === null && <option>Loading…</option>}
            {choices.map((b) => (
              <option key={b.id} value={b.id}>
                {b.id === boardId ? `${b.name} (this board)` : b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Stage" htmlFor="mc-stage">
          <select id="mc-stage" className={inputClass} value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {stages.length === 0 && <option value="">No open stages on this board</option>}
            {stages.map((s) => (
              <option key={s.id} value={s.id} disabled={!!stage && s.id === stage.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {card && (
          <fieldset>
            <legend className="mb-1 font-medium text-slate-700">Place in the stage</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="mc-place" checked={place === 'top'} onChange={() => setPlace('top')} /> At the top
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="mc-place" checked={place === 'bottom'} onChange={() => setPlace('bottom')} /> At the bottom
              </label>
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  )
}
