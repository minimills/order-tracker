// @permission-scope boards.share
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SHARE_LEVEL_TEXT, type Board, type Share, type ShareLevel } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { useTargets } from '../../lib/useTargets'
import { buttonClass, narrowInputClass, Modal, secondaryButtonClass } from '../form'
import TargetPicker, { type Target } from './TargetPicker'

/** Share a board with people, groups, departments or everyone. */
export default function ShareDialog({ board, onClose, onChanged }: { board: Board; onClose: () => void; onChanged: () => void }) {
  const { nameOf } = useTargets()
  const [shares, setShares] = useState<Share[]>([])
  const [target, setTarget] = useState<Target>({ type: 'user', target: null })
  const [level, setLevel] = useState<ShareLevel>('edit')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase!.from('board_shares').select('*').eq('board_id', board.id).order('created_at')
    setShares((data as Share[]) ?? [])
  }, [board.id])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function add() {
    if (!supabase) return
    if (target.type !== 'everyone' && !target.target) return toast.error('Select who to share the board with.')
    setBusy(true)
    const { error } = await supabase
      .from('board_shares')
      .insert({ board_id: board.id, share_type: target.type, target: target.type === 'everyone' ? null : target.target, level })
    setBusy(false)
    if (error) return toast.error(error.code === '23505' ? 'The board is already shared with them. Change their access level in the list.' : friendlyError(error))
    setTarget({ type: target.type, target: null })
    load()
    onChanged()
  }

  async function change(s: Share, lvl: ShareLevel) {
    const { error } = await supabase!.from('board_shares').update({ level: lvl }).eq('id', s.id)
    if (error) return toast.error(friendlyError(error))
    load()
  }
  async function remove(s: Share) {
    const { error } = await supabase!.from('board_shares').delete().eq('id', s.id)
    if (error) return toast.error(friendlyError(error))
    load()
    onChanged()
  }

  return (
    <Modal
      title={`Share “${board.name}”`}
      onClose={onClose}
      footer={
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="text-sm text-slate-600">
        Sharing lets people open this board. What they see and can do on it still depends on their permissions (Admin →
        Users).
      </p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200">
        <li className="flex items-center justify-between px-3 py-2 text-sm">
          <span>{nameOf('user', board.owner_email)} (owner)</span>
          <span className="text-xs text-slate-500">Can manage the board</span>
        </li>
        {shares.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1">{nameOf(s.share_type, s.target)}</span>
            <select aria-label={`Access for ${nameOf(s.share_type, s.target)}`} className={`${narrowInputClass} w-48 py-1`} value={s.level} onChange={(e) => change(s, e.target.value as ShareLevel)}>
              {(Object.keys(SHARE_LEVEL_TEXT) as ShareLevel[]).map((l) => (
                <option key={l} value={l}>
                  {SHARE_LEVEL_TEXT[l]}
                </option>
              ))}
            </select>
            <button type="button" className="text-xs text-red-700 underline" onClick={() => remove(s)}>
              Stop Sharing
            </button>
          </li>
        ))}
        {shares.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">This board has not been shared with anyone yet.</li>}
      </ul>
      <div className="mt-4 space-y-2 rounded-md bg-slate-50 p-3">
        <div className="text-sm font-medium">Share with</div>
        <TargetPicker value={target} onChange={setTarget} />
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Access" className={`${narrowInputClass} w-56`} value={level} onChange={(e) => setLevel(e.target.value as ShareLevel)}>
            {(Object.keys(SHARE_LEVEL_TEXT) as ShareLevel[]).map((l) => (
              <option key={l} value={l}>
                {SHARE_LEVEL_TEXT[l]}
              </option>
            ))}
          </select>
          <button type="button" className={buttonClass} onClick={add} disabled={busy}>
            Share
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Can see = look only. Can work on cards = add, move and change cards. Can manage = also stages, labels, sharing and
          notifications.
        </p>
      </div>
    </Modal>
  )
}
