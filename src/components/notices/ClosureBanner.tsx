import { Link } from 'react-router-dom'
import { rangeText, showDateTime, useClosureAlerts } from '../../lib/notices'
import { usePermissions } from '../../lib/permissions'
import Can from '../Can'
import Icon from '../Icon'

/**
 * Closure and delay alerts: a full-width warning at the top of every page
 * (including the Notice Board) until the alert is ended or its last date passes.
 */
export default function ClosureBanner() {
  const { canAny } = usePermissions()
  const list = useClosureAlerts(canAny(['notices.closures', 'notices.closures.post']))
  if (!list.length) return null
  return (
    <Can anyOf={['notices.closures', 'notices.closures.post']}>
      <div role="alert" className="keep-light divide-y divide-amber-600/30 bg-amber-400 text-slate-900 print:hidden">
        {list.map((a) => (
          <div key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2.5 text-sm md:px-8">
            <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div>
                <span className="font-bold">{a.title}</span>
                <span className="font-medium"> · {rangeText(a.start_date, a.end_date)}</span>
              </div>
              {(a.last_message || a.reason) && <div className="break-words">{a.last_message || a.reason}</div>}
              <div className="text-xs text-slate-800">
                {a.next_update_at ? `Next update at ${showDateTime(a.next_update_at)}` : 'No further update planned'} · Updated {showDateTime(a.updated_at)}
              </div>
            </div>
            <Link to={`/notices?closure=${a.id}`} className="shrink-0 rounded-md border border-slate-900/40 px-3 py-1 font-medium hover:bg-amber-300">
              Details
            </Link>
          </div>
        ))}
      </div>
    </Can>
  )
}
