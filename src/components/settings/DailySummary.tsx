// @permission-scope settings.daily_summary
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '../../lib/auth'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import { inputClass, narrowInputClass, secondaryButtonClass, Switch } from '../form'

type Settings = {
  morning_enabled: boolean
  morning_time: string
  morning_items: string[]
  evening_enabled: boolean
  evening_time: string
  evening_items: string[]
  business: boolean
}
const DEFAULTS: Settings = {
  morning_enabled: false, morning_time: '07:30', morning_items: ['tasks_due', 'overdue', 'ship_dates', 'payments_due', 'new_orders', 'notices', 'events', 'holidays'],
  evening_enabled: false, evening_time: '16:30', evening_items: ['board_activity', 'time_logged', 'tasks_due', 'overdue', 'new_orders'], business: false,
}

/** What a summary can hold, and the permission each part needs (parts a person may not see are left out by the database too). */
const ITEMS: { key: string; label: string; needs?: string[] }[] = [
  { key: 'tasks_due', label: 'My tasks due today', needs: ['boards'] },
  { key: 'overdue', label: 'My overdue items', needs: ['boards'] },
  { key: 'ship_dates', label: 'Ship dates in the next 7 days', needs: ['orders.list', 'orders.board'] },
  { key: 'payments_due', label: 'Payments due', needs: ['payments'] },
  { key: 'new_orders', label: 'New orders', needs: ['orders.list', 'orders.board'] },
  { key: 'notices', label: 'Notices not read yet', needs: ['notices'] },
  { key: 'events', label: 'Events', needs: ['notices.events'] },
  { key: 'holidays', label: 'Holidays' },
  { key: 'board_activity', label: 'My board activity', needs: ['boards'] },
  { key: 'time_logged', label: 'Time logged', needs: ['boards'] },
]
const PRESETS: { key: string; label: string; items: string[] | null }[] = [
  { key: 'agenda', label: 'What is ahead (tasks, dates, notices)', items: DEFAULTS.morning_items },
  { key: 'recap', label: 'What I did (activity, time, open tasks)', items: DEFAULTS.evening_items },
  { key: 'all', label: 'Everything', items: ITEMS.map((i) => i.key) },
  { key: 'custom', label: 'Choose items', items: null },
]
const CHANNELS = [
  { key: 'email', label: 'Email', on: 'instant' },
  { key: 'app', label: 'In the app', on: 'on' },
  { key: 'push', label: 'Phone push', on: 'on' },
]
const KIND = { morning: 'daily_agenda', evening: 'daily_recap' } as const
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** Settings → Daily Summary: a morning "Today's Agenda" and an end-of-day "What I Did Today". */
export default function DailySummary() {
  const { can, canAny } = usePermissions()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [s, setS] = useState<Settings | null>(null)
  const [modes, setModes] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState<Record<string, boolean>>({})
  const [sending, setSending] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !me) return
    const [a, k, m] = await Promise.all([
      supabase.from('summary_settings').select('*').eq('user_email', me).maybeSingle(),
      supabase.from('notification_kinds').select('kind, default_modes').in('kind', Object.values(KIND)),
      supabase.from('notification_settings').select('kind, channel, mode').in('kind', Object.values(KIND)),
    ])
    const row = a.data as (Settings & { morning_time: string; evening_time: string }) | null
    setS(row ? { ...DEFAULTS, ...row, morning_time: row.morning_time.slice(0, 5), evening_time: row.evening_time.slice(0, 5) } : DEFAULTS)
    const out: Record<string, string> = {}
    for (const kind of (k.data as { kind: string; default_modes: Record<string, string> }[] | null) ?? []) for (const c of CHANNELS) out[`${kind.kind}:${c.key}`] = kind.default_modes?.[c.key] ?? 'off'
    for (const r of (m.data as { kind: string; channel: string; mode: string }[] | null) ?? []) out[`${r.kind}:${r.channel}`] = r.mode
    setModes(out)
  }, [me])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function save(patch: Partial<Settings>) {
    if (!supabase || !s) return
    setS({ ...s, ...patch })
    const { error } = await supabase.rpc('set_my_summary', { p: patch })
    if (error) {
      toast.error(friendlyError(error))
      load()
    }
  }
  async function setChannel(kind: string, channel: (typeof CHANNELS)[number], on: boolean) {
    if (!supabase) return
    const mode = on ? channel.on : 'off'
    setModes({ ...modes, [`${kind}:${channel.key}`]: mode })
    const { error } = await supabase.from('notification_settings').upsert({ user_email: me, kind, channel: channel.key, mode })
    if (error) toast.error(friendlyError(error))
  }
  async function sample(which: 'agenda' | 'recap') {
    if (!supabase) return
    setSending(which)
    const { error } = await supabase.rpc('send_my_summary', { p_kind: which })
    setSending(null)
    if (error) return toast.error(friendlyError(error))
    toast.success('A sample is on its way by the ways you chose. In the app it is under Notifications.')
  }

  if (!s) return <p className="text-sm text-slate-500">Loading…</p>
  const allowed = ITEMS.filter((i) => !i.needs || canAny(i.needs))

  const part = (which: 'morning' | 'evening', title: string, text: string, sampleKind: 'agenda' | 'recap') => {
    const enabled = s[`${which}_enabled`]
    const items = s[`${which}_items`]
    const preset = custom[which] ? 'custom' : (PRESETS.find((p) => p.items && same(p.items, items))?.key ?? 'custom')
    return (
      <div className="space-y-3 rounded-md border border-slate-200 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold">{title}</h3>
            <p className="text-slate-600">{text}</p>
          </div>
          <Switch checked={enabled} label={title} onChange={(on) => save({ [`${which}_enabled`]: on })} />
        </div>
        {enabled && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label>
                <span className="mb-1 block text-slate-600">Time (Halifax)</span>
                <input type="time" step={300} className={`${narrowInputClass} w-32`} value={s[`${which}_time`]} onChange={(e) => e.target.value && save({ [`${which}_time`]: e.target.value })} />
              </label>
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-slate-600">What is included</span>
                <select
                  className={inputClass}
                  value={preset}
                  onChange={(e) => {
                    const p = PRESETS.find((x) => x.key === e.target.value)
                    setCustom({ ...custom, [which]: !p?.items })
                    if (p?.items) save({ [`${which}_items`]: p.items })
                  }}
                >
                  {PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {preset === 'custom' && (
              <div className="grid gap-1 sm:grid-cols-2">
                {allowed.map((i) => (
                  <label key={i.key} className="flex items-center gap-2">
                    <input type="checkbox" checked={items.includes(i.key)} onChange={(e) => save({ [`${which}_items`]: e.target.checked ? [...items, i.key] : items.filter((x) => x !== i.key) })} />
                    {i.label}
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="text-slate-600">Send it by</span>
              {CHANNELS.map((c) => (
                <label key={c.key} className="flex items-center gap-2">
                  <input type="checkbox" checked={(modes[`${KIND[which]}:${c.key}`] ?? 'off') !== 'off'} onChange={(e) => setChannel(KIND[which], c, e.target.checked)} />
                  {c.label}
                </label>
              ))}
              <button type="button" className={`${secondaryButtonClass} ml-auto`} disabled={sending !== null} onClick={() => sample(sampleKind)}>
                {sending === sampleKind ? 'Sending…' : 'Send Me a Sample Now'}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">Sent on working days at the time you choose. Each summary only holds what you are allowed to see.</p>
      {part('morning', 'Today’s Agenda', 'A morning summary of what is ahead.', 'agenda')}
      {part('evening', 'What I Did Today', 'An end-of-day summary of your work.', 'recap')}
      {can('summary.business') && (
        <Can permission="summary.business">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={s.business} onChange={(e) => save({ business: e.target.checked })} />
            <span>
              <span className="font-medium">Add the business summary</span>
              <span className="block text-slate-600">New orders, money received and outstanding, shipments and orders past their ship date, at the end of each summary.</span>
            </span>
          </label>
        </Can>
      )}
    </div>
  )
}
