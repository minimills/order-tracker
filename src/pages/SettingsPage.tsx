import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Can from '../components/Can'
import Icon, { type IconName } from '../components/Icon'
import SettingsSearch from '../components/SettingsSearch'
import UnitsSwitch from '../components/crating/UnitsSwitch'
import ChangeEmail from '../components/settings/ChangeEmail'
import ChatSettings from '../components/settings/ChatSettings'
import DailySummary from '../components/settings/DailySummary'
import MySignature from '../components/settings/MySignature'
import MyMailbox from '../components/settings/MyMailbox'
import { useAuth } from '../lib/auth'
import { usePermissions } from '../lib/permissions'
import { ADMIN_KEYS } from '../lib/permissions/catalog'
import { startPageChoices } from '../lib/permissions/nav'
import { usePreferences } from '../lib/preferences'
import { supabase } from '../lib/supabase'
import { THEMES, type Theme } from '../lib/theme'
import LanguagePicker from '../components/LanguagePicker'
import { tr } from '../i18n'

const THEME_ICON: Record<Theme, IconName> = { light: 'sun', dark: 'moon', system: 'monitor', glass: 'glass' }
/** A settings card. The grid places as many side by side as fit, so there are no gaps. */
const card = 'rounded-lg border border-slate-200 bg-white p-4 text-sm'

/** Personal settings. Company-wide settings are in the Admin area. */
export default function SettingsPage() {
  const { session, role } = useAuth()
  const { can, canAny } = usePermissions()
  const { startPage, setStartPage, theme, glassBase, setLook, setMyLanguage } = usePreferences()
  const [departments, setDepartments] = useState<string[] | null>(null)
  useEffect(() => {
    supabase?.rpc('my_departments').then(({ data }) => setDepartments((data as string[] | null) ?? []))
  }, [])

  return (
    <Can permission="settings">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{tr("Settings")}</h1>
            <p className="mt-1 text-sm text-slate-600">{tr("Your own settings. Company-wide settings are in Admin.")}</p>
          </div>
          <SettingsSearch />
        </div>

        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,21rem),1fr))]">
          <Can permission="settings.account">
            <section className={card} data-setting="account">
              <h2 className="mb-2 font-semibold">{tr("Your Account")}</h2>
              <p className="break-words">
                {tr("Signed in as")} <strong>{session?.user.email ?? '—'}</strong>
              </p>
              {role && <p className="mt-1 text-slate-600">{role === 'admin' ? tr("Admin (full access)") : tr("User (sees what an administrator has allowed)")}</p>}
              {departments !== null && (
                <p className="mt-1 text-slate-600">
                  {tr("Departments:")} {departments.length ? departments.join(', ') : tr("none yet (an administrator can add you)")}
                </p>
              )}
            </section>
          </Can>

          <Can permission="settings.change_email" level="edit">
            <section className={card} data-setting="change-email">
              <h2 className="mb-2 font-semibold">{tr("Change Sign-in Email")}</h2>
              <ChangeEmail />
            </section>
          </Can>

          <Can permission="settings.mailbox">
            <section className={`${card} [grid-column:1/-1] lg:[grid-column:auto]`} data-setting="my-email">
              <h2 className="mb-2 flex items-center gap-2 font-semibold">
                <Icon name="mail" /> {tr("Email")}
              </h2>
              <MyMailbox />
            </section>
          </Can>

          <Can permission="settings.daily_summary" level="edit">
            <section className={`${card} [grid-column:1/-1] lg:[grid-column:auto]`} data-setting="daily-summary">
              <h2 className="mb-2 flex items-center gap-2 font-semibold">
                <Icon name="inbox" /> {tr("Daily Summary")}
              </h2>
              <DailySummary />
            </section>
          </Can>

          <Can permission="settings.language" level="edit">
            <section className={card} data-setting="language">
              <h2 className="mb-1 font-semibold">{tr('Language')}</h2>
              <p className="mb-3 text-slate-600">{tr('The language of the app on all your devices. Text people typed (notes, chat, notices) is not translated.')}</p>
              <LanguagePicker id="language" onChange={(l) => setMyLanguage(l)} />
            </section>
          </Can>

          <Can permission="settings.theme" level="edit">
            <section className={card} data-setting="theme">
              <h2 className="mb-1 font-semibold">{tr("Appearance")}</h2>
              <p className="mb-3 text-slate-600">{tr("How the app looks on your devices.")}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={tr("Appearance")}>
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
              {theme === 'glass' && (
                <div className="mt-3">
                  <p className="mb-1 text-sm font-medium">{tr("Glass colours")}</p>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tr("Glass colours")}>
                    {(
                      [
                        ['light', 'Light'],
                        ['dark', 'Dark'],
                        ['system', 'As this device'],
                      ] as const
                    ).map(([v, l]) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={glassBase === v}
                        onClick={() => setLook({ glassBase: v })}
                        className={`rounded-full border px-3 py-1 text-sm ${glassBase === v ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white hover:bg-slate-50'}`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </Can>

          <Can permission="settings.start_page" level="edit">
            <section className={card} data-setting="start-page">
              <h2 className="mb-2 font-semibold">{tr("Start Page")}</h2>
              <p className="mb-2 text-slate-600">{tr("The page that opens after you sign in.")}</p>
              <select
                aria-label={tr("Start page")}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                value={startPage ?? ''}
                onChange={(e) => setStartPage(e.target.value || null)}
              >
                <option value="">{tr("Automatic (the first page I can open)")}</option>
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
              <h2 className="mb-2 font-semibold">{tr("Units for Crate Sizes and Weights")}</h2>
              <UnitsSwitch />
              <p className="mt-2 text-slate-600">{tr("This only changes what you see. Everything is stored in metric, so each person can choose their own units.")}</p>
            </section>
          </Can>

          <Can anyOf={['settings.notification_channels', 'settings.push', 'settings.notifications', 'settings.quiet_hours']}>
            <section className={card} data-setting="notifications">
              <h2 className="mb-1 font-semibold">{tr("Notifications")}</h2>
              <p className="text-slate-600">{tr("Choose how you hear about each kind of event: in the app, by phone push, by email or on this computer. Quiet hours too.")}</p>
              <Link to="/settings/notifications" className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50">
                <Icon name="bell" /> {tr("Open Notification Settings")}
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
              <h2 className="mb-2 font-semibold">{tr("My Signature")}</h2>
              <MySignature />
            </section>
          </Can>

          <Can anyOf={['service.calendar.sync', 'service.calendar.import']} level="edit">
            <Link to="/calendar?connection=1" className={`${card} block hover:border-slate-400`} data-setting="calendar-connection">
              <div className="flex items-center gap-2 font-semibold">
                <Icon name="calendar" /> {tr("Calendar Connection")}
              </div>
              <p className="mt-1 text-sm text-slate-600">{tr("Your phone calendar links are on the Calendar page, under Calendar Connection.")}</p>
            </Link>
          </Can>

          <Can anyOf={ADMIN_KEYS}>
            <Link to="/admin" className={`${card} block hover:border-slate-400`}>
              <div className="flex items-center gap-2 font-semibold">
                <Icon name="wrench" /> {tr("Admin")}
              </div>
              <div className="mt-1 text-slate-600">{tr("The admin pages you can open.")}</div>
            </Link>
          </Can>
        </div>
      </div>
    </Can>
  )
}
