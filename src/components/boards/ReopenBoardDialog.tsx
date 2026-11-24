// @permission-scope boards.reopen
import { useState } from 'react'
import { toast } from 'sonner'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import { buttonClass, Modal, secondaryButtonClass } from '../form'
import { tr } from '../../i18n'

/** Reopen a closed board with its own board number or the next new number. */
export default function ReopenBoardDialog({ board, onClose, onDone }: { board: { id: string; name: string; board_number?: number }; onClose: () => void; onDone: () => void }) {
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  async function reopen() {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('reopen_board', { p_board: board.id, p_new_number: fresh })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Board reopened as Board {{data}}.", { data: data }))
    onDone()
  }
  return (
    <Modal
      title={tr("Reopen {{name}}", { name: board.name })}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={reopen} disabled={busy}>
            {busy ? ACTION.saving : tr("Reopen Board")}
          </button>
        </>
      }
    >
      <fieldset className="space-y-2 text-sm">
        <legend className="mb-1 text-slate-600">{tr("The board comes back on the Boards page and can be changed again.")}</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="reopen-number" className="mt-1" checked={!fresh} onChange={() => setFresh(false)} />
          <span>{tr("Keep its board number")}{board.board_number ? tr(" (Board {{board_number}})", { board_number: board.board_number }) : ''}</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="reopen-number" className="mt-1" checked={fresh} onChange={() => setFresh(true)} />
          <span>{tr("Give it a new board number (the next free one)")}</span>
        </label>
      </fieldset>
    </Modal>
  )
}
