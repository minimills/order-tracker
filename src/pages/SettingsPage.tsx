import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Can from '../components/Can'
import UnitsSwitch from '../components/crating/UnitsSwitch'
import NotificationSettings from '../components/settings/NotificationSettings'
import PhoneNotifications from '../components/settings/PhoneNotifications'
import CalendarImportSettings from '../components/settings/CalendarImportSettings'
import ChatSettings from '../components/settings/ChatSettings'
import { secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { usePermissions } from '../lib/permissions'
import { ADMIN_KEYS } from '../lib/permissions/catalog'
import { startPageChoices } from '../lib/permissions/nav'
import { usePreferences } from '../lib/preferences'
import { askNotificationPermission, notificationPermission } from '../lib/browserNotifications'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

/** Personal settings. Company-wide settings are in the Admin area (admins only). */
export default function SettingsPage() {
  const { session, role } = useAuth()
  const { can, canAny } = usePermissions()
  const { startPage, setStartPage } = usePreferences()
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
            <h2 className="mb-2 font-semibold">Your Account</h2>
            <p>
              Signed in as <strong>{session?.user.email ?? '—'}</strong>
              {role && <> · {role === 'admin' ? 'Admin (full access)' : 'User (sees what an administrator has allowed)'}</>}
            </p>
            {departments !== null && (
              <p className="mt-1 text-slate-600">
                Department{departments.length === 1 ? '' : 's'}:{' '}
                {departments.length ? departments.join(', ') : 'none yet (an administrator can add you)'}
              </p>
            )}
          </section>
        </Can>

        <Can permission="settings.start_page" level="edit">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Start Page</h2>
            <p className="mb-2 text-slate-600">The page that opens after you sign in.</p>
            <select
              aria-label="Start page"
              className="w-full max-w-xs rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={startPage ?? ''}
              onChange={(e) => setStartPage(e.target.value || null)}
            >
              <option value="">Automatic (the first page I can open)</option>
              {startPageChoices((p) => (!p.permission || can(p.permission, p.level)) && (!p.anyOf || canAny(p.anyOf, p.level))).map(
                (p) => (
                  <option key={p.to} value={p.to}>
                    {p.label}
                  </option>
                ),
              )}
            </select>
          </section>
        </Can>

        <Can permission="settings.units">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Units for Crate Sizes and Weights</h2>
            <UnitsSwitch />
            <p className="mt-2 text-slate-600">
              This only changes what you see. Everything is stored in metric, so each person can choose their own units.
            </p>
          </section>
        </Can>

        <Can permission="settings.notifications">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Desktop Notifications</h2>
            {permission === 'granted' && (
              <p>Enabled: this browser shows a notification when a payment becomes overdue or a ship date passes.</p>
            )}
            {permission === 'denied' && <p>Blocked in this browser. Allow notifications for this site in your browser settings.</p>}
            {permission === 'unsupported' && <p>This browser can’t show desktop notifications.</p>}
            {permission === 'default' && (
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={async () => setPermission(await askNotificationPermission())}
              >
                Enable Desktop Notifications
              </button>
            )}
          </section>
        </Can>

        <Can permission="settings.notification_channels">
          <NotificationSettings />
        </Can>

        <Can anyOf={['settings.quiet_hours', 'settings.chat_status']} level="edit">
          <ChatSettings />
        </Can>

        <Can permission="settings.push" level="edit">
          <PhoneNotifications />
        </Can>

        <Can permission="service.calendar.import" level="edit">
          <CalendarImportSettings />
        </Can>

        <Can anyOf={ADMIN_KEYS}>
          <Link to="/admin" className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400">
            <div className="font-semibold">Admin</div>
            <div className="mt-1 text-sm text-slate-600">The admin pages you can open.</div>
          </Link>
        </Can>

        <Can permission="settings.connection">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            Database connection:{' '}
            {isSupabaseConfigured ? (
              <span className="font-medium text-green-700">settings found</span>
            ) : (
              <span className="font-medium text-amber-700">not configured (.env.local is missing)</span>
            )}
          </section>
        </Can>
      </div>
    </Can>
  )
}
