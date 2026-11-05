import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { AlertsContext, alertText, type AlertRow } from '../../lib/alerts'
import { usePermissions } from '../../lib/permissions'
import { notificationPermission, readStorage, writeStorage } from '../../lib/browserNotifications'
import { fetchAll } from '../../lib/fetchAll'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

const RECHECK_MS = 10 * 60 * 1000 // every 10 minutes
const MIN_GAP_MS = 20 * 1000 // don't re-check more often than this on page changes
const TOASTED_KEY = 'alerts-toasted' // sessionStorage: opening toasts already shown
const NOTIFIED_KEY = 'alerts-notified' // localStorage: red alerts already notified/seen
const MAX_OPENING_TOASTS = 4

function sortAlerts(list: AlertRow[]) {
  return [...list].sort(
    (a, b) =>
      (a.severity === 'red' ? 0 : 1) - (b.severity === 'red' ? 0 : 1) ||
      (a.days ?? 9999) - (b.days ?? 9999) ||
      a.order_code.localeCompare(b.order_code, undefined, { numeric: true }),
  )
}

/**
 * Loads the signed-in user's alerts, re-checks every 10 minutes, shows
 * pop-ups for overdue / due-today items when the app opens, and a browser
 * notification when a new one appears while the app is open.
 */
export default function AlertsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { can } = usePermissions()
  const seesAlerts = can('alerts.bell')
  const popups = can('alerts.popups')
  const opensOrders = can('order.page')
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [loading, setLoading] = useState(true)
  const lastLoad = useRef(0)
  const firstLoadDone = useRef(false)

  const handleNew = useCallback(
    (list: AlertRow[]) => {
      // Pop-ups and desktop notifications only for people with "alerts.popups".
      if (!popups) return
      const red = list.filter((a) => !a.hidden && a.severity === 'red')

      // 1. Pop-ups once per browser session (i.e. when the app is opened).
      if (!readStorage(TOASTED_KEY, true)) {
        writeStorage(TOASTED_KEY, '1', true)
        red.slice(0, MAX_OPENING_TOASTS).forEach((a, i) => {
          const t = alertText(a)
          setTimeout(
            () =>
              toast.error(t.title, {
                description: t.detail,
                duration: 10000,
                action: opensOrders ? { label: 'Open', onClick: () => navigate(`/orders/${a.order_id}`) } : undefined,
              }),
            i * 300,
          )
        })
        if (red.length > MAX_OPENING_TOASTS) {
          toast.error(`…and ${red.length - MAX_OPENING_TOASTS} more overdue or due today`, {
            description: 'Click the bell at the top to see them all.',
            duration: 10000,
          })
        }
      }

      // 2. Browser notifications for red alerts we haven't seen before.
      let seen: string[] = []
      try {
        seen = JSON.parse(readStorage(NOTIFIED_KEY) ?? '[]')
      } catch {
        seen = []
      }
      const seenSet = new Set(seen)
      const fresh = red.filter((a) => !seenSet.has(a.alert_key))
      // On the first check after opening, the pop-ups above cover everything,
      // so only later checks send desktop notifications.
      if (firstLoadDone.current && notificationPermission() === 'granted') {
        for (const a of fresh) {
          const t = alertText(a)
          try {
            const n = new Notification(t.title, { body: t.detail, tag: a.alert_key })
            n.onclick = () => {
              window.focus()
              if (opensOrders) navigate(`/orders/${a.order_id}`)
              n.close()
            }
          } catch {
            // Some browsers (e.g. on phones) only allow notifications from a service worker.
          }
        }
      }
      // Remember the current red alerts (keeps the list short).
      const current = new Set(red.map((a) => a.alert_key))
      const keep = [...seen.filter((k) => current.has(k)), ...fresh.map((a) => a.alert_key)]
      writeStorage(NOTIFIED_KEY, JSON.stringify(keep.slice(-500)))
      firstLoadDone.current = true
    },
    [navigate, popups, opensOrders],
  )

  const load = useCallback(async () => {
    if (!supabase) return
    if (!seesAlerts) {
      setAlerts([])
      setLoading(false)
      return
    }
    lastLoad.current = Date.now()
    const { data, error } = await fetchAll<AlertRow>(() =>
      supabase!.from('my_alerts').select('*').order('alert_key'),
    )
    if (error) {
      // Before migration 0011 is run the view does not exist; stay quiet then.
      if (!error.message?.includes('my_alerts')) toast.error(friendlyError(error))
      setLoading(false)
      return
    }
    setAlerts(sortAlerts(data))
    setLoading(false)
    handleNew(data)
  }, [handleNew, seesAlerts])

  // First load, then every 10 minutes, and when the window gets focus again.
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
    const timer = setInterval(load, RECHECK_MS)
    const onFocus = () => Date.now() - lastLoad.current > MIN_GAP_MS && load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  // Re-check after moving to another page (e.g. after marking a payment received).
  useEffect(() => {
    if (Date.now() - lastLoad.current > MIN_GAP_MS) load()
  }, [location.pathname, load])

  const act = useCallback(
    async (fn: string, args: Record<string, unknown>, message: string) => {
      if (!supabase) return
      const { error } = await supabase.rpc(fn, args)
      if (error) {
        toast.error(friendlyError(error))
        return
      }
      toast.success(message)
      load()
    },
    [load],
  )

  const value = useMemo(
    () => ({
      visible: alerts.filter((a) => !a.hidden),
      hidden: alerts.filter((a) => a.hidden),
      loading,
      refresh: () => {
        load()
      },
      snooze: (a: AlertRow, days: number) =>
        act('snooze_alert', { p_alert_key: a.alert_key, p_days: days }, `Snoozed for ${days === 1 ? '1 day' : `${days} days`}.`),
      dismiss: (a: AlertRow) => act('dismiss_alert', { p_alert_key: a.alert_key }, 'Alert dismissed.'),
      restore: (a: AlertRow) => act('restore_alert', { p_alert_key: a.alert_key }, 'Alert is back.'),
    }),
    [alerts, loading, load, act],
  )

  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>
}
