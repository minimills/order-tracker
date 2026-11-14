import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Can from '../components/Can'
import Icon, { type IconName } from '../components/Icon'
import SettingsSearch from '../components/SettingsSearch'
import UnitsSwitch from '../components/crating/UnitsSwitch'
import ChatSettings from '../components/settings/ChatSettings'
import MySignature from '../components/settings/MySignature'
import { useAuth } from '../lib/auth'
import { usePermissions } from '../lib/permissions'
import { ADMIN_KEYS } from '../lib/permissions/catalog'
import { startPageChoices } from '../lib/permissions/nav'
import { usePreferences } from '../lib/preferences'
import { supabase } from '../lib/supabase'
import { THEMES, type Theme } from '../lib/theme'

const THEME_ICON: Record<Theme, IconName> = { light: 'sun', dark: 'moon', system: 'monitor' }
/** A settings card. The grid places as many side by side as fit, so there are no gaps. */
const card = 'rounded-lg border border-slate-200 bg-white p-4 text-sm'

/** Personal settings. Company-wide settings are in the Admin area. */
export default function SettingsPage() {
  const { session, role } = useAuth()
  const { can, canAny } = usePermissions()
  const { startPage, setStartPage, theme, setLook } = usePreferences()
  const [departments, setDepartments] = useState<string[] | null>(null)
  useEffect(() => {
    supabase?.rpc('my_departments').then(({ data }) => setDepartments((data as string[] | null) ?? []))
  }, [])

  return (
    <Can permission="settings">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Settings</h1>
            <p className="mt-1 text-sm text-slate-600">Your own settings. Company-wide settings are in Admin.</p>
          </div>
          <SettingsSearch />
        </div>

        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,21rem),1fr))]">
          <Can permission="settings.account">
            <section className={card} data-setting="account">
              <h2 className="mb-2 font-semibold">Your Account</h2>
              <p className="break-words">
                Signed in as <strong>{session?.user.email ?? '—'}</strong>
              </p>
              {role && <p className="mt-1 text-slate-600">{role === 'admin' ? 'Admin (full access)' : 'User (sees what an administrator has allowed)'}</p>}
              {departments !== null && (
                <p className="mt-1 text-slate-600">
                  Department{departments.length === 1 ? '' : 's'}: {departments.length ? departments.join(', ') : 'none yet (an administrator can add you)'}
                </p>
              )}
            </section>
          </Can>

          <Can permission="settings.theme" level="edit">
            <section className={card} data-setting="theme">
              <h2 className="mb-1 font-semibold">Theme</h2>
              <p className="mb-3 text-slate-600">How the app looks on your devices.</p>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={theme === t.value}
                    title={t.hint}
                    onClick={() => setLook({ theme: t.value })}
                    className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-sm font-medium ${
                      theme === t.value ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <Icon name={THEME_ICON[t.value]} className="h-5 w-5" />
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">{THEMES.find((t) => t.value === theme)?.hint}</p>
            </section>
          </Can>

          <Can permission="settings.start_page" level="edit">
            <section className={card} data-setting="start-page">
              <h2 className="mb-2 font-semibold">Start Page</h2>
              <p className="mb-2 text-slate-600">The page that opens after you sign in.</p>
              <select
                aria-label="Start page"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                value={startPage ?? ''}
                onChange={(e) => setStartPage(e.target.value || null)}
              >
                <option value="">Automatic (the first page I can open)</option>
                {startPageChoices((p) => (!p.permission || can(p.permission, p.level)) && (!p.anyOf || canAny(p.anyOf, p.level))).map((p) => (
                  <option key={p.to} value={p.to}>
                    {p.label}
                  </option>
                ))}
              </select>
            </section>
          </Can>

          <Can permission="settings.units">
            <section className={card} data-setting="units">
              <h2 className="mb-2 font-semibold">Units for Crate Sizes and Weights</h2>
              <UnitsSwitch />
              <p className="mt-2 text-slate-600">This only changes what you see. Everything is stored in metric, so each person can choose their own units.</p>
            </section>
          </Can>

          <Can anyOf={['settings.notification_channels', 'settings.push', 'settings.notifications', 'settings.quiet_hours']}>
            <section className={card} data-setting="notifications">
              <h2 className="mb-1 font-semibold">Notifications</h2>
              <p className="text-slate-600">Choose how you hear about each kind of event: in the app, by phone push, by email or on this computer. Quiet hours too.</p>
              <Link to="/settings/notifications" className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50">
                <Icon name="bell" /> Open Notification Settings
              </Link>
            </section>
          </Can>

          <Can permission="settings.chat_status" level="edit">
            <ChatSettings part="status" className={card} />
          </Can>

          <Can permission="settings.chat_swipe" level="edit">
            <ChatSettings part="swipe" className={card} />
          </Can>

          <Can permission="settings.signature">
            <section className={`${card} [grid-column:1/-1] lg:[grid-column:auto]`} data-setting="my-signature">
              <h2 className="mb-2 font-semibold">My Signature</h2>
              <MySignature />
            </section>
          </Can>

          <Can anyOf={['service.calendar.sync', 'service.calendar.import']} level="edit">
            <Link to="/service/calendar?connection=1" className={`${card} block hover:border-slate-400`} data-setting="calendar-connection">
              <div className="flex items-center gap-2 font-semibold">
                <Icon name="calendar" /> Calendar Connection
              </div>
              <p className="mt-1 text-sm text-slate-600">Your phone calendar links are now on the Technician Calendar page, under Calendar Connection.</p>
            </Link>
          </Can>

          <Can anyOf={ADMIN_KEYS}>
            <Link to="/admin" className={`${card} block hover:border-slate-400`}>
              <div className="flex items-center gap-2 font-semibold">
                <Icon name="wrench" /> Admin
              </div>
              <div className="mt-1 text-slate-600">The admin pages you can open.</div>
            </Link>
          </Can>
        </div>
      </div>
    </Can>
  )
}
