// @permission-scope alerts.bell
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { alertText, useAlerts, type AlertRow } from '../../lib/alerts'
import { askNotificationPermission, notificationPermission } from '../../lib/browserNotifications'
import { showDate } from '../../lib/dates'
import Can from '../Can'

const smallButton = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50'

function AlertItem({ alert, onOpen }: { alert: AlertRow; onOpen: () => void }) {
  const { snooze, dismiss, restore } = useAlerts()
  const t = alertText(alert)
  return (
    <li className={`border-l-4 px-3 py-2.5 ${alert.severity === 'red' ? 'border-red-500' : 'border-amber-400'}`}>
      <Can
        permission="order.page"
        fallback={
          <div>
            <div className={`text-sm font-medium ${alert.severity === 'red' ? 'text-red-800' : 'text-slate-900'}`}>{t.title}</div>
            <div className="text-xs text-slate-600">{t.detail}</div>
          </div>
        }
      >
        <Link to={`/orders/${alert.order_id}`} onClick={onOpen} className="block hover:underline">
          <div className={`text-sm font-medium ${alert.severity === 'red' ? 'text-red-800' : 'text-slate-900'}`}>{t.title}</div>
          <div className="text-xs text-slate-600">{t.detail}</div>
        </Link>
      </Can>
      <Can permission="alerts.snooze" level="edit">
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {alert.hidden ? (
          <>
            <span className="text-xs text-slate-500">
              {alert.dismissed_at ? 'Dismissed' : `Snoozed until ${showDate(alert.snoozed_until?.slice(0, 10))}`}
            </span>
            <button type="button" className={smallButton} onClick={() => restore(alert)}>
              Bring back
            </button>
          </>
        ) : (
          <>
            <button type="button" className={smallButton} onClick={() => snooze(alert, 1)}>
              Snooze 1 day
            </button>
            <button type="button" className={smallButton} onClick={() => snooze(alert, 7)}>
              Snooze 1 week
            </button>
            <button type="button" className={smallButton} onClick={() => dismiss(alert)}>
              Dismiss
            </button>
          </>
        )}
      </div>
      </Can>
    </li>
  )
}

/** The bell in the top bar: shows how many alerts there are and lists them. */
export default function AlertsBell() {
  const { visible, hidden, loading } = useAlerts()
  const [open, setOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [permission, setPermission] = useState(notificationPermission())
  const box = useRef<HTMLDivElement>(null)
  const red = visible.filter((a) => a.severity === 'red').length

  // Close when clicking outside or pressing Escape.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-lg leading-none hover:bg-slate-50"
        aria-label={`Alerts: ${visible.length}`}
        aria-expanded={open}
      >
        <span aria-hidden="true">🔔</span>
        {visible.length > 0 && (
          <span
            className={`absolute -top-2 -right-2 min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-bold text-white ${
              red > 0 ? 'bg-red-600' : 'bg-amber-500'
            }`}
          >
            {visible.length > 99 ? '99+' : visible.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[min(26rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <span className="font-semibold">Alerts</span>
            <Can permission="admin.alerts" level="edit">
              <Link to="/admin/alerts" onClick={() => setOpen(false)} className="text-xs text-slate-600 underline">
                Alert settings
              </Link>
            </Can>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {loading && <p className="px-3 py-4 text-sm text-slate-500">Loading…</p>}
            {!loading && visible.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-slate-500">Nothing needs attention. ✅</p>
            )}
            <ul className="divide-y divide-slate-100">
              {visible.map((a) => (
                <AlertItem key={a.alert_key} alert={a} onOpen={() => setOpen(false)} />
              ))}
            </ul>
            {hidden.length > 0 && (
              <div className="border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowHidden((s) => !s)}
                  className="w-full px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
                >
                  {showHidden ? '▾' : '▸'} Snoozed and dismissed ({hidden.length})
                </button>
                {showHidden && (
                  <ul className="divide-y divide-slate-100 bg-slate-50">
                    {hidden.map((a) => (
                      <AlertItem key={a.alert_key} alert={a} onOpen={() => setOpen(false)} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <Can permission="alerts.popups">
          <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {permission === 'granted' && 'Desktop notifications are on for new overdue items.'}
            {permission === 'denied' && 'Desktop notifications are blocked. Allow them in your browser’s site settings.'}
            {permission === 'unsupported' && 'This browser can’t show desktop notifications.'}
            {permission === 'default' && (
              <button
                type="button"
                className="underline"
                onClick={async () => setPermission(await askNotificationPermission())}
              >
                Turn on desktop notifications for new overdue items
              </button>
            )}
          </div>
          </Can>
        </div>
      )}
    </div>
  )
}
