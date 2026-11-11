import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../components/Can'
import Icon, { type IconName } from '../components/Icon'
import SettingsSearch from '../components/SettingsSearch'
import { secondaryButtonClass, Switch } from '../components/form'
import ChatSettings from '../components/settings/ChatSettings'
import PhoneNotifications from '../components/settings/PhoneNotifications'
import { useAuth } from '../lib/auth'
import { askNotificationPermission, notificationPermission } from '../lib/browserNotifications'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { usePreferences } from '../lib/preferences'
import { supabase } from '../lib/supabase'

type Kind = {
  kind: string
  label: string
  description: string | null
  sort_order: number
  default_modes: Record<string, string>
  required_channels?: string[] | null
}
type Setting = { kind: string; channel: string; mode: string }
type Channel = 'app' | 'push' | 'email' | 'desktop'

const COLUMNS: { channel: Channel; label: string; icon: IconName }[] = [
  { channel: 'app', label: 'In-app', icon: 'bell' },
  { channel: 'push', label: 'Phone push', icon: 'phone' },
  { channel: 'email', label: 'Email', icon: 'inbox' },
  { channel: 'desktop', label: 'Desktop', icon: 'monitor' },
]
/** Groups of events on the page, by the start of their type name. */
const GROUPS: { title: string; match: (k: string) => boolean }[] = [
  { title: 'Notice Board and Events', match: (k) => k.startsWith('notice_') || k.startsWith('note_') || k.startsWith('event_') },
  { title: 'Chat', match: (k) => k.startsWith('chat_') },
  { title: 'Boards', match: (k) => k.startsWith('board_') },
  { title: 'Other', match: () => true },
]
const card = 'rounded-lg border border-slate-200 bg-white p-4 text-sm'

/**
 * Settings → Notifications: one row per kind of event, with a switch for each
 * way of hearing about it, plus desktop, email timing and quiet hours.
 * Who is notified is decided by each feature (board rules, notice audience…);
 * this page decides how each person receives it.
 */
export default function NotificationSettingsPage() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const { can } = usePermissions()
  const { desktopNotifications, setLook } = usePreferences()
  const [kinds, setKinds] = useState<Kind[]>([])
  const [channels, setChannels] = useState<string[]>([])
  const [settings, setSettings] = useState<Setting[]>([])
  const [permission, setPermission] = useState(notificationPermission())
  const [busy, setBusy] = useState(false)
  const editable = can('settings.notification_channels', 'edit')

  const load = useCallback(async () => {
    if (!supabase) return
    const [k, c, s] = await Promise.all([
      supabase.from('notification_kinds').select('*').order('sort_order'),
      supabase.from('notification_channels').select('channel').eq('enabled', true),
      supabase.from('notification_settings').select('kind, channel, mode'),
    ])
    setKinds((k.data as Kind[]) ?? [])
    setChannels(((c.data as { channel: string }[]) ?? []).map((x) => x.channel))
    setSettings((s.data as Setting[]) ?? [])
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const modeOf = (k: Kind, channel: string) =>
    settings.find((s) => s.kind === k.kind && s.channel === channel)?.mode ?? k.default_modes[channel] ?? (channel === 'app' ? 'on' : 'off')
  const required = (k: Kind, channel: string) => !!k.required_channels?.includes(channel)
  // Email timing for the whole page (types with email on; "mixed" when some differ).
  const emailModes = new Set(kinds.filter((k) => !required(k, 'email')).map((k) => modeOf(k, 'email')).filter((m) => m !== 'off'))
  const emailMode: 'instant' | 'digest' | 'mixed' = emailModes.size === 1 && emailModes.has('digest') ? 'digest' : emailModes.has('digest') ? 'mixed' : 'instant'

  async function save(rows: Setting[]) {
    if (!supabase || !rows.length) return
    const { error } = await supabase.from('notification_settings').upsert(rows.map((r) => ({ user_email: me, ...r })))
    if (error) return toast.error(friendlyError(error))
    setSettings((all) => [...all.filter((s) => !rows.some((r) => r.kind === s.kind && r.channel === s.channel)), ...rows])
  }
  const flip = (k: Kind, channel: Channel, on: boolean) =>
    save([{ kind: k.kind, channel, mode: channel === 'email' ? (on ? (emailMode === 'digest' ? 'digest' : 'instant') : 'off') : on ? 'on' : 'off' }])
  const setEmailMode = (mode: 'instant' | 'digest') =>
    save(kinds.filter((k) => !required(k, 'email') && modeOf(k, 'email') !== 'off').map((k) => ({ kind: k.kind, channel: 'email', mode })))

  async function sendTest() {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('send_me_test_notification')
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Test notification sent. It appears in the bell now; email and phone messages follow within a few minutes if they are on.')
  }

  const shown = COLUMNS.filter((c) => channels.includes(c.channel) || c.channel === 'app')
  const grouped = GROUPS.map((g, i) => ({
    title: g.title,
    rows: kinds.filter((k) => g.match(k.kind) && !GROUPS.slice(0, i).some((x) => x.match(k.kind))),
  })).filter((g) => g.rows.length)

  return (
    <Can permission="settings.notification_channels">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Notifications</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              How you hear about each kind of event. Who is told about something is decided where it happens (for example a board’s notification rules or a
              notice’s audience).
            </p>
          </div>
          <SettingsSearch />
        </div>

        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,21rem),1fr))]">
          <Can permission="settings.notifications">
            <section className={card} data-setting="desktop">
              <h2 className="mb-1 flex items-center gap-2 font-semibold">
                <Icon name="monitor" /> Desktop Notifications
              </h2>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-600">Show notifications on this computer while the app is open in a browser tab.</span>
                <Switch checked={desktopNotifications} onChange={(on) => setLook({ desktopNotifications: on })} label="Desktop notifications" />
              </div>
              {desktopNotifications && (
                <p className="mt-2 text-xs text-slate-500">
                  {permission === 'granted' && 'Allowed in this browser.'}
                  {permission === 'denied' && 'Blocked in this browser. Allow notifications for this site in the browser settings.'}
                  {permission === 'unsupported' && 'This browser cannot show desktop notifications.'}
                  {permission === 'default' && (
                    <button type="button" className={`${secondaryButtonClass} mt-1`} onClick={async () => setPermission(await askNotificationPermission())}>
                      Allow in This Browser
                    </button>
                  )}
                </p>
              )}
            </section>
          </Can>

          <Can permission="settings.notification_channels" level="edit">
            <section className={card} data-setting="email-mode">
              <h2 className="mb-1 flex items-center gap-2 font-semibold">
                <Icon name="inbox" /> Email Timing
              </h2>
              <p className="mb-3 text-slate-600">For every event with Email on.</p>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Email timing">
                {(
                  [
                    ['instant', 'Each time', 'Within a few minutes; quick changes are combined.'],
                    ['digest', 'Once a day', 'One summary email each morning.'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={emailMode === value}
                    title={hint}
                    onClick={() => setEmailMode(value)}
                    className={`rounded-md border px-3 py-2 text-left ${emailMode === value ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white hover:bg-slate-50'}`}
                  >
                    <span className="block font-medium">{label}</span>
                    <span className={`block text-xs ${emailMode === value ? 'opacity-80' : 'text-slate-500'}`}>{hint}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {emailMode === 'mixed' && 'Some events are emailed each time and some once a day. Choose one to use it for all. '}
                Urgent notices are always emailed straight away.
              </p>
            </section>
          </Can>

          <Can permission="settings.quiet_hours" level="edit">
            <ChatSettings part="quiet" className={card} />
          </Can>
        </div>

        <section className={`${card} p-0`} aria-label="Events">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <h2 className="font-semibold">Events</h2>
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={sendTest}>
              Send Me a Test Notification
            </button>
          </div>
          {/* Column headings (wide screens); on phones each switch has its own label. */}
          <div className="hidden grid-cols-[minmax(0,1fr)_repeat(4,6rem)] gap-2 border-b border-slate-100 px-4 py-2 text-xs font-medium text-slate-500 md:grid">
            <span>Event</span>
            {shown.map((c) => (
              <span key={c.channel} className="flex items-center justify-center gap-1">
                <Icon name={c.icon} className="h-3.5 w-3.5" /> {c.label}
              </span>
            ))}
          </div>
          {grouped.map((g) => (
            <div key={g.title}>
              <h3 className="bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.title}</h3>
              <ul className="divide-y divide-slate-100">
                {g.rows.map((k) => (
                  <li key={k.kind} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_repeat(4,6rem)] md:items-center">
                    <div className="min-w-0">
                      <div className="font-medium">{k.label}</div>
                      {k.description && <div className="text-xs text-slate-500">{k.description}</div>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 md:contents">
                      {shown.map((c) => {
                        const locked = required(k, c.channel)
                        const on = locked || modeOf(k, c.channel) !== 'off'
                        return (
                          <div key={c.channel} className="flex items-center gap-2 md:justify-center">
                            <Switch
                              checked={on}
                              disabled={locked || !editable || (c.channel === 'desktop' && !desktopNotifications)}
                              onChange={(v) => flip(k, c.channel, v)}
                              label={`${k.label}: ${c.label}${locked ? ' (always on)' : ''}`}
                            />
                            <span className="text-xs text-slate-600 md:hidden">{c.label}</span>
                            {locked && <span className="text-[11px] text-slate-500">Always</span>}
                          </div>
                        )
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {kinds.length === 0 && <p className="px-4 py-6 text-center text-slate-500">Loading…</p>}
        </section>

        <Can permission="settings.push" level="edit">
          <div data-setting="phone">
            <PhoneNotifications />
          </div>
        </Can>
      </div>
    </Can>
  )
}
