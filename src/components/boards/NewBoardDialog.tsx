// @permission-scope boards.create
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { BOARD_COLOURS, type BoardTemplate } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import ColourPicker from './ColourPicker'
import { tr } from '../../i18n'

/** Make a board: from scratch or from a template. The maker owns it. */
export default function NewBoardDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [templates, setTemplates] = useState<BoardTemplate[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [colour, setColour] = useState(BOARD_COLOURS[0])
  const [template, setTemplate] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase
      ?.from('board_templates')
      .select('*')
      .eq('archived', false)
      .order('name')
      .then(({ data }) => {
        const list = (data as BoardTemplate[]) ?? []
        setTemplates(list)
        if (list[0]) {
          setTemplate(list[0].id)
          setColour(list[0].colour)
        }
      })
  }, [])

  const chosen = templates.find((t) => t.id === template)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    if (!name.trim()) return toast.error(tr("Enter a name for the board."))
    setBusy(true)
    const { data, error } = await supabase.rpc('create_board', {
      p_name: name.trim(),
      p_description: description.trim() || null,
      p_colour: colour,
      p_template: template || null,
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Board “{{value}}” created.", { value: name.trim() }))
    navigate(`/boards/${data}`)
  }

  return (
    <Modal
      title={tr("New Board")}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {tr("Cancel")}
          </button>
          <button type="submit" form="new-board" className={buttonClass} disabled={busy}>
            {busy ? tr("Creating…") : tr("Create Board")}
          </button>
        </>
      }
    >
      <form id="new-board" onSubmit={save} className="space-y-4" noValidate>
        <Field label={tr("Name")} htmlFor="nb-name">
          <input id="nb-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("For example: My jobs")} autoFocus />
        </Field>
        <Field label={tr("Description (optional)")} htmlFor="nb-desc">
          <input id="nb-desc" className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={tr("Start from")} htmlFor="nb-tpl">
          <select
            id="nb-tpl"
            className={inputClass}
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value)
              const t = templates.find((x) => x.id === e.target.value)
              if (t) setColour(t.colour)
            }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {tr("Template:")} {t.name}
              </option>
            ))}
            <option value="">{tr("Blank board (add your own stages)")}</option>
          </select>
        </Field>
        {chosen && (
          <p className="text-xs text-slate-600">
            {tr("Stages:")} {chosen.stages.join(' → ') || tr("none")}
            {chosen.labels.length > 0 && <> {tr("· Labels:")} {chosen.labels.map((l) => l.name).join(', ')}</>}
            {chosen.checklists.length > 0 && <> {tr("· Ready-made checklists:")} {chosen.checklists.map((c) => c.title).join(', ')}</>}
          </p>
        )}
        <Field label={tr("Colour")}>
          <ColourPicker colours={BOARD_COLOURS} value={colour} onChange={setColour} label={tr("Board colour")} />
        </Field>
        <p className="text-xs text-slate-500">{tr("A new board is visible only to you until you share it.")}</p>
      </form>
    </Modal>
  )
}
