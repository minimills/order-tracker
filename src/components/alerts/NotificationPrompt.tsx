import { useState } from 'react'
import {
  askNotificationPermission,
  notificationPermission,
  readStorage,
  writeStorage,
} from '../../lib/browserNotifications'

const DISMISSED_KEY = 'notify-prompt-dismissed'

/** A one-time banner asking to allow desktop notifications. */
export default function NotificationPrompt() {
  const [show, setShow] = useState(() => notificationPermission() === 'default' && !readStorage(DISMISSED_KEY))
  if (!show) return null

  const close = () => {
    writeStorage(DISMISSED_KEY, '1')
    setShow(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900">
      <span className="flex-1">🔔 Get a desktop notification when a payment becomes overdue or a ship date passes?</span>
      <button
        type="button"
        className="rounded-md bg-blue-700 px-3 py-1 text-white hover:bg-blue-800"
        onClick={async () => {
          await askNotificationPermission()
          close()
        }}
      >
        Turn on
      </button>
      <button type="button" className="underline" onClick={close}>
        Not now
      </button>
    </div>
  )
}
