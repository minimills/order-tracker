import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Can from '../components/Can'
import UnitsSwitch from '../components/crating/UnitsSwitch'
import { secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { ADMIN_KEYS } from '../lib/permissions/catalog'
import { askNotificationPermission, notificationPermission } from '../lib/browserNotifications'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

/** Personal settings. Company-wide settings are in the Admin area (admins only). */
export default function SettingsPage() {
  const { session, role } = useAuth()
  const [permission, setPermission] = useState(notificationPermission())
  const [departments, setDepartments] = useState<string[] | null>(null)
  useEffect(() => {
    supabase?.rpc('my_departments').then(({ data }) => setDepartments((data as string[] | null) ?? []))
  }, [])

  return (
    <Can permission="settings">
      <div className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Settings</h1>

        <Can permission="settings.account">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Your account</h2>
            <p>
              Signed in as <strong>{session?.user.email ?? '—'}</strong>
              {role && <> · {role === 'admin' ? 'Admin (can see and do everything)' : 'User (sees what an admin has ticked)'}</>}
            </p>
            {departments !== null && (
              <p className="mt-1 text-slate-600">
                Department{departments.length === 1 ? '' : 's'}:{' '}
                {departments.length ? departments.join(', ') : 'none yet (an admin can add you)'}
              </p>
            )}
          </section>
        </Can>

        <Can permission="settings.units">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Units for crate sizes and weights</h2>
            <UnitsSwitch />
            <p className="mt-2 text-slate-600">
              Only changes what you see. Everything is saved in metric, so others can pick their own.
            </p>
          </section>
        </Can>

        <Can permission="settings.notifications">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Desktop notifications</h2>
            {permission === 'granted' && (
              <p>On: this browser shows a notification when a payment becomes overdue or a ship date passes.</p>
            )}
            {permission === 'denied' && <p>Blocked in this browser. Allow notifications for this site in your browser’s settings.</p>}
            {permission === 'unsupported' && <p>This browser can’t show desktop notifications.</p>}
            {permission === 'default' && (
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={async () => setPermission(await askNotificationPermission())}
              >
                Turn on desktop notifications
              </button>
            )}
          </section>
        </Can>

        <Can anyOf={ADMIN_KEYS}>
          <Link to="/admin" className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400">
            <div className="font-semibold">🛠 Admin</div>
            <div className="mt-1 text-sm text-slate-600">The admin pages you have access to.</div>
          </Link>
        </Can>

        <Can permission="settings.connection">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            Database connection:{' '}
            {isSupabaseConfigured ? (
              <span className="font-medium text-green-700">settings found</span>
            ) : (
              <span className="font-medium text-amber-700">not set up (.env.local missing)</span>
            )}
          </section>
        </Can>
      </div>
    </Can>
  )
}
