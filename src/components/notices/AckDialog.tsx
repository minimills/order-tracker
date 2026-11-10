// @permission-scope notices.acks
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { friendlyError } from '../../lib/format'
import { showDateTime, type AckRow, type Notice } from '../../lib/notices'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import Can from '../Can'
import { buttonClass, Modal, secondaryButtonClass } from '../form'

/** Who has and hasn't acknowledged a notice, with "Remind the Rest". */
export default function AckDialog({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const [rows, setRows] = useState<AckRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase?.rpc('notice_ack_status', { p_notice: notice.id }).then(({ data, error: e }) => {
      if (e) setError(friendlyError(e))
      else setRows((data as AckRow[]) ?? [])
    })
  }, [notice.id])

  const done = rows?.filter((r) => r.acknowledged_at) ?? []
  const waiting = rows?.filter((r) => !r.acknowledged_at) ?? []

  async function remind() {
    if (!supabase) return
    setBusy(true)
    const { data, error: e } = await supabase.rpc('remind_notice', { p_notice: notice.id })
    setBusy(false)
    if (e) return toast.error(friendlyError(e))
    const n = Number(data ?? 0)
    toast.success(n === 0 ? 'Nobody needed a reminder.' : `Reminder sent to ${n} ${n === 1 ? 'person' : 'people'}.`)
    onClose()
  }

  return (
    <Modal
      title="Who Has Acknowledged"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.close}
          </button>
          {waiting.length > 0 && (
            <Can permission="notices.acks" level="edit">
              <button type="button" className={buttonClass} onClick={remind} disabled={busy}>
                {busy ? 'Sending…' : 'Remind the Rest'}
              </button>
            </Can>
          )}
        </>
      }
    >
      <p className="text-sm text-slate-600">{notice.title}</p>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
      {!rows && !error && <p className="mt-3 text-sm text-slate-500">Loading…</p>}
      {rows && (
        <div className="mt-3 space-y-4 text-sm">
          <p className="font-medium">
            {done.length} of {rows.length} acknowledged
          </p>
          <div>
            <h3 className="font-medium text-red-800">Not yet acknowledged ({waiting.length})</h3>
            {waiting.length === 0 ? (
              <p className="mt-1 text-slate-500">Everyone has acknowledged this notice.</p>
            ) : (
              <ul className="mt-1 divide-y divide-slate-100">
                {waiting.map((r) => (
                  <li key={r.email} className="flex justify-between gap-3 py-1">
                    <span>{r.name}</span>
                    <span className="text-xs text-slate-500">{r.read_at ? `Seen ${showDateTime(r.read_at)}` : 'Not seen yet'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="font-medium text-green-800">Acknowledged ({done.length})</h3>
            {done.length === 0 ? (
              <p className="mt-1 text-slate-500">Nobody has acknowledged it yet.</p>
            ) : (
              <ul className="mt-1 divide-y divide-slate-100">
                {done.map((r) => (
                  <li key={r.email} className="flex justify-between gap-3 py-1">
                    <span>{r.name}</span>
                    <span className="text-xs text-slate-500">{showDateTime(r.acknowledged_at!)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
