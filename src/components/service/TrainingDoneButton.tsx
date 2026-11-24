// @permission-scope service.training.done
/* Drawn only inside <Can permission="service.training.done" level="edit">; mark_training_done checks it again. */
import { useState } from 'react'
import { toast } from 'sonner'
import { buttonClass, Modal, secondaryButtonClass } from '../form'
import { activityTime } from '../../lib/activity'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import type { ServiceInfo } from '../../lib/service'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

type Candidate = { id: string; title: string; board_name: string; stage_name: string; suggested: boolean; can_complete: boolean }
type Result = { cards_done: number; entries_done: number; cards_skipped: { title: string; reason: string }[] }

/** Training orders: "Mark Training as Done" (who and when), with the board cards and calendar entries it completes; once done, the state and "Mark as Not Done". */
export default function TrainingDoneButton({ info, onChanged }: { info: Pick<ServiceInfo, 'order_id' | 'training_done_at' | 'training_done_by_name'>; onChanged: () => void }) {
  const [open, setOpen] = useState<{ cards: Candidate[]; entries: number } | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  async function start() {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('training_done_candidates', { p_order: info.order_id })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    const d = data as { cards: Candidate[]; entries: number }
    setChosen(d.cards.filter((c) => c.suggested && c.can_complete).map((c) => c.id))
    setOpen(d)
  }

  async function confirm() {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('mark_training_done', { p_order: info.order_id, p_done: true, p_cards: chosen })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    const r = data as Result
    const parts = [
      'Training marked as done.',
      r.cards_done ? `${r.cards_done} card${r.cards_done === 1 ? '' : 's'} completed.` : '',
      r.entries_done ? `${r.entries_done} calendar entr${r.entries_done === 1 ? 'y' : 'ies'} marked done.` : '',
    ]
    toast.success(parts.filter(Boolean).join(' '))
    for (const s of r.cards_skipped) toast.warning(tr("“{{title}}” was not completed: {{reason}}.", { title: s.title, reason: s.reason }))
    setOpen(null)
    onChanged()
  }

  async function undo() {
    if (!supabase) return
    if (!(await confirmAction(tr("Mark the training of this order as not done? Completed board cards and calendar entries stay complete; reopen cards on their board if needed."), { get confirmLabel() {
    return tr("Mark as Not Done")
  } }))) return
    const { error } = await supabase.rpc('mark_training_done', { p_order: info.order_id, p_done: false })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Training marked as not done."))
    onChanged()
  }

  if (info.training_done_at)
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-900">
          {tr("Training done")} {activityTime.format(new Date(info.training_done_at))}
          {info.training_done_by_name ? tr(" by {{training_done_by_name}}", { training_done_by_name: info.training_done_by_name }) : ''}
        </span>
        <button type="button" className="text-xs text-slate-600 underline" onClick={undo}>
          {tr("Mark as Not Done")}
        </button>
      </span>
    )

  return (
    <>
      <button type="button" className={buttonClass} disabled={busy} onClick={start}>
        {tr("Mark Training as Done")}
      </button>
      {open && (
        <Modal
          title={tr("Mark Training as Done")}
          onClose={() => setOpen(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setOpen(null)} disabled={busy}>
                {ACTION.cancel}
              </button>
              <button type="button" className={buttonClass} onClick={confirm} disabled={busy}>
                {busy ? ACTION.saving : tr("Mark Training as Done")}
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>{tr("Your name and today’s date are recorded on the order. The order moves to Completed on the Service / Training page.")}</p>
            <p>
              {open.entries
                ? tr("{{entries}} calendar entr{{value}} linked to this order will be marked done.", { entries: open.entries, value: open.entries === 1 ? 'y' : 'ies' })
                : tr("No calendar entries are linked to this order.")}
            </p>
            <fieldset>
              <legend className="font-medium">{tr("Board cards to complete")}</legend>
              {open.cards.length === 0 ? (
                <p className="text-slate-500">{tr("No open cards on boards you can open are linked to this order.")}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {open.cards.map((c) => (
                    <li key={c.id}>
                      <label className={`flex items-start gap-2 ${c.can_complete ? '' : 'text-slate-400'}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          disabled={!c.can_complete}
                          checked={chosen.includes(c.id)}
                          onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
                        />
                        <span>
                          {c.title}
                          <span className="block text-xs text-slate-500">
                            {c.board_name} · {c.stage_name}
                            {!c.can_complete && tr(" · you cannot complete cards on this board")}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-slate-500">{tr("Cards with “training” in the title or a label are selected for you.")}</p>
            </fieldset>
          </div>
        </Modal>
      )}
    </>
  )
}
