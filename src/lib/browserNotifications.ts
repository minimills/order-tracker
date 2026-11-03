/** Small helpers around the browser's Notification feature. */

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

/** 'granted', 'denied', 'default' (not asked yet) or 'unsupported'. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

export async function askNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported' as const
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

/** Safe wrappers: storage can be blocked (private windows), so never crash. */
export function readStorage(key: string, session = false) {
  try {
    return (session ? sessionStorage : localStorage).getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string, session = false) {
  try {
    ;(session ? sessionStorage : localStorage).setItem(key, value)
  } catch {
    // ignore
  }
}
