// @permission-scope automations
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { secondaryButtonClass } from '../form'
import { ACTION_STATUS, RUN_STATUS, loadRuns, when, type Run } from '../../lib/automations'
import { friendlyError } from '../../lib/format'
import { tr } from '../../i18n'

const TONE: Record<string, string> = { ok: 'text-green-800', skipped: 'text-amber-800', failed: 'text-red-700' }

/** When it ran, what started it, what it did, and any problems (newest first). */
export default function RunLog({ automationId }: { automationId: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [withTests, setWithTests] = useState(true)
  const load = useCallback(() => {
    loadRuns(automationId)
      .then(setRuns)
      .catch((e) => {
        toast.error(friendlyError(e))
        setRuns([])
      })
  }, [automationId])
  useEffect(() => {
    load()
  }, [load])
  const shown = (runs ?? []).filter((r) => withTests || !r.is_test)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-slate-600">
          <input type="checkbox" checked={withTests} onChange={(e) => setWithTests(e.target.checked)} /> {tr("Show tests")}
        </label>
        <button type="button" className={`${secondaryButtonClass} ml-auto py-1`} onClick={load}>
          {tr("Refresh")}
        </button>
      </div>
      {runs === null ? (
        <p className="text-sm text-slate-500">{tr("Loading…")}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-500">{tr("This automation has not run yet.")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {shown.map((r) => {
            const st = RUN_STATUS[r.status] ?? { text: r.status, tone: 'bg-slate-200 text-slate-700' }
            return (
              <li key={r.id} className="space-y-1 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${st.tone}`}>{st.text}</span>
                  <span className="text-slate-500">{when(r.started_at)}</span>
                  {r.depth > 0 && <span className="text-xs text-slate-500">{tr("(started by another automation)")}</span>}
                </div>
                <p className="min-w-0 break-words text-slate-800">
                  {r.trigger_text}
                  {r.subject_title && (
                    <>
                      {' · '}
                      {r.link ? (
                        <Link to={r.link} className="text-blue-700 underline">
                          {r.subject_title}
                        </Link>
                      ) : (
                        r.subject_title
                      )}
                    </>
                  )}
                  {r.actor_name && <span className="text-slate-500"> {tr("· by")} {r.actor_name}</span>}
                </p>
                {r.message && <p className="text-slate-600">{r.message}</p>}
                {r.actions.length > 0 && (
                  <ul className="space-y-0.5 pl-4">
                    {r.actions.map((a, i) => (
                      <li key={i} className={TONE[a.status]}>
                        {r.is_test ? 'Would be ' + (a.status === 'ok' ? 'done' : ACTION_STATUS[a.status].toLowerCase()) : ACTION_STATUS[a.status]}: {a.message ?? a.label}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
