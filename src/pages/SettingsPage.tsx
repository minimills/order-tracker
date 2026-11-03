import { useState } from 'react'
import { Link } from 'react-router-dom'
import { secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { askNotificationPermission, notificationPermission } from '../lib/browserNotifications'
import { isSupabaseConfigured } from '../lib/supabase'

/** Personal settings. Company-wide settings are in the Admin area (admins only). */
export default function SettingsPage() {
  const { session, role, isAdmin } = useAuth()
  const [permission, setPermission] = useState(notificationPermission())

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="mb-2 font-semibold">Your account</h2>
        <p>
          Signed in as <strong>{session?.user.email ?? '—'}</strong>
          {role && <> · {role === 'admin' ? 'Admin' : 'Staff'}</>}
        </p>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h2 className="mb-2 font-semibold">Desktop notifications</h2>
        {permission === 'granted' && <p>On: this browser shows a notification when a payment becomes overdue or a ship date passes.</p>}
        {permission === 'denied' && <p>Blocked in this browser. Allow notifications for this site in your browser’s settings.</p>}
        {permission === 'unsupported' && <p>This browser can’t show desktop notifications.</p>}
        {permission === 'default' && (
          <button type="button" className={secondaryButtonClass} onClick={async () => setPermission(await askNotificationPermission())}>
            Turn on desktop notifications
          </button>
        )}
      </section>

      {isAdmin && (
        <Link to="/admin" className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400">
          <div className="font-semibold">🛠 Admin</div>
          <div className="mt-1 text-sm text-slate-600">
            Users, machine types, dropdown lists, serials, shop queue, alerts, company details, archive and activity.
          </div>
        </Link>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        Database connection:{' '}
        {isSupabaseConfigured ? (
          <span className="font-medium text-green-700">settings found</span>
        ) : (
          <span className="font-medium text-amber-700">not set up (.env.local missing)</span>
        )}
      </section>
    </div>
  )
}
