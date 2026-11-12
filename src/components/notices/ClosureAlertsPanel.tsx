// @permission-scope notices.closures, notices.closures.post
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { askText } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { rangeText, refreshClosureAlerts, showDateTime, useClosureAlerts, type ClosureAlert, type ClosureUpdate } from '../../lib/notices'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import Icon from '../Icon'
import ClosureAlertDialog from './ClosureAlertDialog'

const KIND_WORD: Record<ClosureUpdate['kind'], string> = { posted: 'Posted', update: 'Update', ended: 'Ended' }

/** On the Notice Board: the active closure / delay alerts with their history, Post Update and End Alert. */
export default function ClosureAlertsPanel({ highlightId, newAlert, onNewDone }: { highlightId: string | null; newAlert: boolean; onNewDone: () => void }) {
  const { canAny } = usePermissions()
  const alerts = useClosureAlerts(canAny(['notices.closures', 'notices.closures.post']))
  const [updates, setUpdates] = useState<ClosureUpdate[]>([])
  const [editing, setEditing] = useState<ClosureAlert | null>(null)

  useEffect(() => {
    if (!supabase || !alerts.length) return
    supabase
      .from('closure_alert_updates')
      .select('*')
      .in('alert_id', alerts.map((a) => a.id))
      .order('created_at', { ascending: false })
      .then(({ data }) => setUpdates((data as ClosureUpdate[]) ?? []))
  }, [alerts])

  useEffect(() => {
    if (highlightId) window.setTimeout(() => document.getElementById(`closure-${highlightId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150)
  }, [highlightId, alerts])

  async function end(a: ClosureAlert) {
    if (!supabase) return
    const msg = await askText(`End “${a.title}”? The banner disappears for everyone. Write a message to send everyone (for example “The office is open again”), or leave it empty to end it quietly.`, {
      label: 'Message (optional)',
      confirmLabel: 'End Alert',
    })
    if (msg === null) return
    const { error } = await supabase.rpc('end_closure_alert', { p_alert: a.id, p_message: msg.trim() || null })
    if (error) return toast.error(friendlyError(error))
    toast.success(msg.trim() ? 'Alert ended. Everyone has been notified.' : 'Alert ended.')
    void refreshClosureAlerts()
  }

  return (
    <>
      {alerts.length > 0 && (
        <section aria-label="Closure and delay alerts" className="space-y-3">
          {alerts.map((a) => (
            <article
              key={a.id}
              id={`closure-${a.id}`}
              className={`rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-sm ${a.id === highlightId ? 'outline outline-3 outline-offset-2 outline-blue-500' : ''}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                    <Icon name="alert" className="h-5 w-5 text-amber-700" /> {a.title}
                  </h2>
                  <p className="text-slate-700">
                    {rangeText(a.start_date, a.end_date)}
                    {a.reason && ` · ${a.reason}`}
                  </p>
                  <p className="text-xs text-slate-600">{a.next_update_at ? `Next update at ${showDateTime(a.next_update_at)}` : 'No further update planned'}</p>
                </div>
                <Can permission="notices.closures.post" level="edit">
                  <div className="flex gap-2">
                    <button type="button" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white" onClick={() => setEditing(a)}>
                      Post Update
                    </button>
                    <button type="button" className="rounded-md border border-slate-400 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => end(a)}>
                      End Alert
                    </button>
                  </div>
                </Can>
              </div>
              <ol className="mt-3 space-y-1.5 border-t border-amber-200 pt-2">
                {updates
                  .filter((u) => u.alert_id === a.id)
                  .map((u) => (
                    <li key={u.id} className="text-xs text-slate-700">
                      <span className="font-medium">{KIND_WORD[u.kind]}</span> · {showDateTime(u.created_at)}
                      {u.created_by_name && ` · ${u.created_by_name}`}
                      {u.message && <div className="text-sm whitespace-pre-line text-slate-900">{u.message}</div>}
                    </li>
                  ))}
              </ol>
            </article>
          ))}
        </section>
      )}
      {(editing || newAlert) && (
        <Can permission="notices.closures.post" level="edit">
          <ClosureAlertDialog
            alert={editing}
            onClose={() => {
              setEditing(null)
              onNewDone()
            }}
            onSaved={() => {
              setEditing(null)
              onNewDone()
            }}
          />
        </Can>
      )}
    </>
  )
}
