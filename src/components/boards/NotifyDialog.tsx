// @permission-scope boards.notifications
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { NOTIFY_EVENTS, type Board, type NotifyEvent, type NotifyRule, type Stage } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useTargets } from '../../lib/useTargets'
import Can from '../Can'
import { buttonClass, narrowInputClass, Modal, secondaryButtonClass } from '../form'
import TargetPicker, { type Target } from './TargetPicker'

/** Which events on this board notify whom (shown in the bell; email later). */
export default function NotifyDialog({ board, stages, onClose }: { board: Board; stages: Stage[]; onClose: () => void }) {
  const { nameOf } = useTargets()
  const [rules, setRules] = useState<NotifyRule[]>([])
  const [event, setEvent] = useState<NotifyEvent>('card_moved')
  const [stage, setStage] = useState('')
  const [target, setTarget] = useState<Target>({ type: 'assignees', target: null })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase!.from('board_notify_rules').select('*').eq('board_id', board.id).order('created_at')
    setRules((data as NotifyRule[]) ?? [])
  }, [board.id])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const eventText = (r: NotifyRule) => {
    if (r.event === 'card_moved') return r.stage_id ? `A card is moved to ${stages.find((s) => s.id === r.stage_id)?.name ?? 'a removed stage'}` : 'A card is moved (any stage)'
    return NOTIFY_EVENTS.find((e) => e.value === r.event)?.label ?? r.event
  }

  async function add() {
    if (!supabase) return
    if (['user', 'group', 'department'].includes(target.type) && !target.target) return toast.error('Select who should be notified.')
    setBusy(true)
    const { error } = await supabase.from('board_notify_rules').insert({
      board_id: board.id,
      event,
      stage_id: event === 'card_moved' && stage ? stage : null,
      target_type: target.type,
      target: ['everyone', 'assignees'].includes(target.type) ? null : target.target,
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    load()
  }
  async function remove(r: NotifyRule) {
    const { error } = await supabase!.from('board_notify_rules').delete().eq('id', r.id)
    if (error) return toast.error(friendlyError(error))
    load()
  }

  return (
    <Modal
      title={`Notifications · ${board.name}`}
      onClose={onClose}
      footer={
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="text-sm text-slate-600">
        Notifications appear under Notifications for the people selected (only people who can open this board, and never the person who
        made the change). Email notifications will be added in a future update.
      </p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
        {rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="flex-1">
              {eventText(r)} → <strong>{nameOf(r.target_type, r.target)}</strong>
            </span>
            <Can permission="boards.notifications" level="edit">
              <button type="button" className="text-xs text-red-700 underline" onClick={() => remove(r)}>
                Remove
              </button>
            </Can>
          </li>
        ))}
        {rules.length === 0 && <li className="px-3 py-2 text-slate-500">No one is notified about this board.</li>}
      </ul>
      <Can permission="boards.notifications" level="edit">
        <div className="mt-4 space-y-2 rounded-md bg-slate-50 p-3">
          <div className="text-sm font-medium">Add a Notification</div>
          <div className="flex flex-wrap gap-2">
            <select aria-label="When" className={`${narrowInputClass} w-56`} value={event} onChange={(e) => setEvent(e.target.value as NotifyEvent)}>
              {NOTIFY_EVENTS.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
            {event === 'card_moved' && (
              <select aria-label="Stage" className={`${narrowInputClass} w-44`} value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="">Any stage</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="text-xs text-slate-600">Notify</div>
          <TargetPicker value={target} onChange={setTarget} withAssignees />
          <button type="button" className={buttonClass} onClick={add} disabled={busy}>
            Add Notification
          </button>
        </div>
      </Can>
    </Modal>
  )
}
