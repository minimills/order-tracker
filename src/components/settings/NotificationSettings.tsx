// @permission-scope settings.notification_channels
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '../../lib/auth'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import { narrowInputClass, secondaryButtonClass } from '../form'

type Kind = { kind: string; label: string; description: string | null; sort_order: number; default_modes: Record<string, string> }
type Channel = { channel: string; label: string; sort_order: number; enabled: boolean }
type Setting = { kind: string; channel: string; mode: string }

/** Choices offered per channel (email can also be a daily digest). */
const CHOICES: Record<string, { value: string; label: string }[]> = {
  email: [
    { value: 'instant', label: 'Each time' },
    { value: 'digest', label: 'Daily summary' },
    { value: 'off', label: 'Disabled' },
  ],
  default: [
    { value: 'on', label: 'Enabled' },
    { value: 'off', label: 'Disabled' },
  ],
}

/**
 * Settings → Notifications: for each type of notification, whether it shows
 * in the app, by email (each time or in a daily summary) and as a phone push.
 * Who receives what is set per board (Notifications on the board); this
 * decides how each person receives it.
 */
export default function NotificationSettings() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [kinds, setKinds] = useState<Kind[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [settings, setSettings] = useState<Setting[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const [k, c, s] = await Promise.all([
      supabase.from('notification_kinds').select('*').order('sort_order'),
      supabase.from('notification_channels').select('*').eq('enabled', true).order('sort_order'),
      supabase.from('notification_settings').select('kind, channel, mode'),
    ])
    setKinds((k.data as Kind[]) ?? [])
    setChannels((c.data as Channel[]) ?? [])
    setSettings((s.data as Setting[]) ?? [])
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const modeOf = (k: Kind, channel: string) =>
    settings.find((s) => s.kind === k.kind && s.channel === channel)?.mode ?? k.default_modes[channel] ?? (channel === 'app' ? 'on' : 'off')

  async function change(kind: string, channel: string, mode: string) {
    if (!supabase) return
    const { error } = await supabase.from('notification_settings').upsert({ user_email: me, kind, channel, mode })
    if (error) return toast.error(friendlyError(error))
    setSettings((all) => [...all.filter((s) => !(s.kind === kind && s.channel === channel)), { kind, channel, mode }])
  }

  async function sendTest() {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('send_me_test_notification')
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Test notification created. It appears in Notifications now; an email or phone message follows within a few minutes if those are enabled.')
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h2 className="font-semibold">Notifications</h2>
      <p className="mt-1 text-slate-600">
        Choose how you receive each type of notification. Board owners decide who is notified about their boards; these
        settings decide how you receive them. Emails about the same card are combined and sent at most once every 10
        minutes. The daily summary arrives once each morning.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-normal">Notification</th>
              {channels.map((c) => (
                <th key={c.channel} className="px-2 py-1 font-normal">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {kinds.map((k) => (
              <tr key={k.kind}>
                <td className="py-2 pr-3">
                  <div className="font-medium">{k.label}</div>
                  {k.description && <div className="text-xs text-slate-500">{k.description}</div>}
                </td>
                {channels.map((c) => (
                  <td key={c.channel} className="px-2 py-2">
                    <Can permission="settings.notification_channels" level="edit" fallback={<span>{(CHOICES[c.channel] ?? CHOICES.default).find((x) => x.value === modeOf(k, c.channel))?.label}</span>}>
                      <select
                        aria-label={`${k.label}: ${c.label}`}
                        className={`${narrowInputClass} py-1`}
                        value={modeOf(k, c.channel)}
                        onChange={(e) => change(k.kind, c.channel, e.target.value)}
                      >
                        {(CHOICES[c.channel] ?? CHOICES.default).map((x) => (
                          <option key={x.value} value={x.value}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                    </Can>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className={`${secondaryButtonClass} mt-3`} disabled={busy} onClick={sendTest}>
        Send Me a Test Notification
      </button>
    </section>
  )
}
