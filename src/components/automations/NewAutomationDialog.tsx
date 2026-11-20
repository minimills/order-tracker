// @permission-scope automations
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Modal, buttonClass, secondaryButtonClass } from '../form'
import { loadTemplates, templateAllowed, type Catalog, type Choices, type Template } from '../../lib/automations'
import { friendlyError } from '../../lib/format'
import { ACTION } from '../../lib/wording'

/** New Automation: start from an example (only those the person may use) or from scratch. */
export default function NewAutomationDialog({ catalog, choices, boardId, onClose }: { catalog: Catalog; choices: Choices; boardId: string | null; onClose: () => void }) {
  const navigate = useNavigate()
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [board, setBoard] = useState(boardId ?? '')
  const editableBoards = choices.boards.filter((b) => b.level >= 2)
  useEffect(() => {
    loadTemplates()
      .then((t) => setTemplates(t.filter((x) => templateAllowed(x, catalog))))
      .catch((e) => {
        toast.error(friendlyError(e))
        setTemplates([])
      })
  }, [catalog])

  const open = (template?: string) => {
    const p = new URLSearchParams()
    if (template) p.set('template', template)
    if (board) p.set('board', board)
    navigate(`/automations/new${p.toString() ? `?${p}` : ''}`)
  }

  return (
    <Modal
      title="New Automation"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={() => open()}>
            Start from Scratch
          </button>
        </>
      }
    >
      {choices.can_board_rules && editableBoards.length > 0 && (
        <div className="mb-4 rounded-md bg-slate-50 p-3 text-sm">
          <label htmlFor="new-au-board" className="mb-1 block font-medium text-slate-700">
            Who sees it
          </label>
          <select id="new-au-board" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={board} onChange={(e) => setBoard(e.target.value)}>
            <option value="">Only me (My Automations; I can share it later)</option>
            {editableBoards.map((b) => (
              <option key={b.id} value={b.id}>
                Board automation: everyone on {b.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-700">Start from an example</h3>
      {templates === null ? (
        <p className="mt-2 text-sm text-slate-500">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No examples match what you have access to. Start from scratch instead.</p>
      ) : (
        <ul className="mt-2 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))]">
          {templates.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => open(t.id)} className="h-full w-full rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-slate-400 hover:bg-slate-50">
                <span className="block text-sm font-semibold text-slate-900">{t.name}</span>
                {t.description && <span className="mt-1 block text-xs text-slate-600">{t.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
