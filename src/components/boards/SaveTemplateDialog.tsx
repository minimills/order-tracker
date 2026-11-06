// @permission-scope admin.board_templates
import { useState } from 'react'
import { toast } from 'sonner'
import type { Board } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'

/** Admin → Board templates: save this board's stages, labels and checklists. */
export default function SaveTemplateDialog({ board, onClose }: { board: Board; onClose: () => void }) {
  const [name, setName] = useState(board.name)
  const [description, setDescription] = useState(board.description ?? '')
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!supabase || !name.trim()) return toast.error('Enter a name for the template.')
    setBusy(true)
    const { error } = await supabase.rpc('save_board_as_template', { p_board: board.id, p_name: name.trim(), p_description: description.trim() || null })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`Template “${name.trim()}” saved. It is offered when people create a new board.`)
    onClose()
  }
  return (
    <Modal
      title="Save as Template"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={busy}>
            Save Template
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Saves this board’s stages, labels and the checklists used on its cards (as ready-made checklists). Cards are not
        copied. Edit templates in Admin → Board Templates.
      </p>
      <div className="space-y-3">
        <Field label="Template name" htmlFor="st-name">
          <input id="st-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description (optional)" htmlFor="st-desc">
          <input id="st-desc" className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
