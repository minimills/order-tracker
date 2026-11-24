import { dtf, currentLang, tr } from '../../i18n'
// @permission-scope admin.status
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import Icon, { type IconName } from '../../components/Icon'
import { buttonClass, Field, narrowInputClass, secondaryButtonClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { Link } from 'react-router-dom'
import Can from '../../components/Can'
import { EU_REGULATION_DATE, loadCeSettings } from '../../lib/ce'
import { showDate, todayISO } from '../../lib/dates'

type Health = 'operational' | 'degraded' | 'down' | 'not_set_up'
type Job = { name: string; schedule: string; active: boolean; last_run: string | null; last_status: string | null; last_message: string | null; failed_24h: number }
type Status = {
  checked_at: string
  database: { version: string; size: number }
  extensions: { pg_cron: boolean; pg_net: boolean }
  email: { sent_24h: number; failed_24h: number; waiting: number; last_sent_at: string | null; ever_sent: boolean }
  push: { sent_24h: number; failed_24h: number; waiting: number; devices: number; last_sent_at: string | null }
  jobs: Job[]
  calendar: { links: number; ok: number; errors: number; last_synced_at: string | null }
  storage: { files_size: number }
  limits: { db_limit_mb?: number; storage_limit_mb?: number }
  users: { total: number; signed_in_today: number; active_today: number }
  tables: { name: string; rows: number; size: number }[]
  errors: { at: string | null; source: string; message: string }[]
}
type Row = { key: string; label: string; icon: IconName; health: Health; detail: string; checkedAt: Date }

const BADGE: Record<Health, { label: string; cls: string }> = {
  operational: { get label() {
    return tr("Operational")
  }, cls: 'bg-green-100 text-green-800 ring-green-300' },
  degraded: { get label() {
    return tr("Degraded")
  }, cls: 'bg-amber-100 text-amber-900 ring-amber-300' },
  down: { get label() {
    return tr("Down")
  }, cls: 'bg-red-100 text-red-800 ring-red-300' },
  not_set_up: { get label() {
    return tr("Not set up")
  }, cls: 'bg-slate-100 text-slate-700 ring-slate-300' },
}
const timeFmt = dtf({ timeZone: 'America/Halifax', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (iso: string | null | undefined) => (iso ? timeFmt.format(new Date(iso)) : 'never')
function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Health of each part from the numbers the database reports (thresholds in plain words in each detail). */
function rows(s: Status | null, db: { ok: boolean; ms: number; error?: string }, auth: { ok: boolean | null; error?: string }, at: Date): Row[] {
  const r: Row[] = []
  r.push({
    key: 'database',
    get label() {
    return tr("Database")
  },
    icon: 'records',
    health: !db.ok ? 'down' : db.ms > 2500 ? 'degraded' : 'operational',
    detail: !db.ok ? `Not answering: ${db.error ?? 'no reply'}` : `Answered in ${db.ms} ms${s ? ` · PostgreSQL ${s.database.version.split(' ')[0]}` : ''}${db.ms > 2500 ? ' (slow)' : ''}`,
    checkedAt: at,
  })
  r.push({
    key: 'login',
    get label() {
    return tr("Login")
  },
    icon: 'lock',
    health: auth.ok === null ? 'degraded' : auth.ok ? 'operational' : 'down',
    detail: auth.ok ? 'Sign-in service is answering.' : auth.ok === null ? 'Checking…' : `Sign-in service is not answering${auth.error ? `: ${auth.error}` : '.'}`,
    checkedAt: at,
  })
  if (!s) return r
  const e = s.email
  r.push({
    key: 'email',
    get label() {
    return tr("Email sending")
  },
    icon: 'inbox',
    health:
      !e.ever_sent && !e.failed_24h ? 'not_set_up' : e.failed_24h && !e.sent_24h ? 'down' : e.failed_24h || e.waiting ? 'degraded' : 'operational',
    detail: !e.ever_sent && !e.failed_24h
      ? 'No email has been sent yet. Set it up in Admin → Email.'
      : `Last 24 hours: ${e.sent_24h} sent, ${e.failed_24h} failed${e.waiting ? `, ${e.waiting} waiting longer than 15 minutes` : ''}. Last sent ${when(e.last_sent_at)}.`,
    checkedAt: at,
  })
  const p = s.push
  r.push({
    key: 'push',
    get label() {
    return tr("Push notifications")
  },
    icon: 'phone',
    health: !p.devices && !p.sent_24h && !p.failed_24h ? 'not_set_up' : p.failed_24h && !p.sent_24h ? 'down' : p.failed_24h || p.waiting ? 'degraded' : 'operational',
    detail: `${plural(p.devices, 'phone or browser', 'phones or browsers')} signed up. Last 24 hours: ${p.sent_24h} sent, ${p.failed_24h} failed${p.waiting ? `, ${p.waiting} waiting` : ''}. Last sent ${when(p.last_sent_at)}.`,
    checkedAt: at,
  })
  const failing = s.jobs.filter((j) => j.last_status === 'failed' || j.failed_24h > 0)
  r.push({
    key: 'jobs',
    get label() {
    return tr("Scheduled jobs")
  },
    icon: 'clock',
    health: !s.extensions.pg_cron ? 'down' : s.jobs.length === 0 ? 'not_set_up' : failing.length ? 'degraded' : 'operational',
    detail: !s.extensions.pg_cron
      ? 'The pg_cron extension is off (Supabase → Database → Extensions).'
      : s.jobs.length === 0
        ? 'No jobs yet. Turn on automatic sending in Admin → Email.'
        : `${plural(s.jobs.length, 'job')}${failing.length ? `, ${failing.length} with failed runs in the last 24 hours` : ', all running'}. Last run ${when(
            s.jobs.map((j) => j.last_run).filter(Boolean).sort().at(-1),
          )}.`,
    checkedAt: at,
  })
  const c = s.calendar
  r.push({
    key: 'calendar',
    get label() {
    return tr("Calendar sync")
  },
    icon: 'calendar',
    health: !c.links ? 'not_set_up' : c.errors >= c.links ? 'down' : c.errors ? 'degraded' : 'operational',
    detail: !c.links ? 'Nobody has linked a phone calendar yet.' : `${plural(c.links, 'linked calendar')}, ${c.errors} with errors. Last read ${when(c.last_synced_at)}.`,
    checkedAt: at,
  })
  return r
}

function Bar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100)
  return (
    <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-slate-200" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={tr("{{value}}% used", { value: pct.toFixed(0) })}>
      <div className={`h-full rounded-full ${pct > 90 ? 'bg-red-600' : pct > 70 ? 'bg-amber-500' : 'bg-green-600'}`} style={{ width: `${Math.max(pct, 1)}%` }} />
    </div>
  )
}

/** Admin → System Status. */
export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [db, setDb] = useState<{ ok: boolean; ms: number; error?: string }>({ ok: true, ms: 0 })
  const [auth, setAuth] = useState<{ ok: boolean | null; error?: string }>({ ok: null })
  const [at, setAt] = useState(() => new Date())
  const [busy, setBusy] = useState(false)
  const [allTables, setAllTables] = useState(false)
  const [limits, setLimits] = useState({ db: '500', storage: '1024' })

  const check = useCallback(async () => {
    if (!supabase) return
    setBusy(true)
    const t0 = performance.now()
    const [res, health] = await Promise.all([
      supabase.rpc('system_status'),
      fetch(`${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/auth/v1/health`, {
        headers: { apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '') },
      })
        .then((r) => ({ ok: r.ok, error: r.ok ? undefined : `code ${r.status}` }))
        .catch((e: Error) => ({ ok: false, error: e.message })),
    ])
    const ms = Math.round(performance.now() - t0)
    setDb(res.error ? { ok: false, ms, error: friendlyError(res.error) } : { ok: true, ms })
    if (!res.error) {
      const s = res.data as Status
      setStatus(s)
      setLimits({ db: String(s.limits.db_limit_mb ?? 500), storage: String(s.limits.storage_limit_mb ?? 1024) })
    }
    setAuth(health)
    setAt(new Date())
    setBusy(false)
  }, [])
  useEffect(() => {
    // check() only sets state after the answers arrive.
    // oxlint-disable-next-line react/set-state-in-effect
    void check()
    const t = window.setInterval(() => void check(), 60_000)
    return () => window.clearInterval(t)
  }, [check])

  // From December 2026: remind to switch declarations to the EU Machinery Regulation.
  const [ceType, setCeType] = useState<string | null>(null)
  useEffect(() => {
    loadCeSettings().then((c) => setCeType(c.declaration_type))
  }, [])
  const euReminder = todayISO() >= '2026-12-01' && ceType !== null && ceType !== 'eu_2023'

  async function saveLimits() {
    if (!supabase) return
    const { error } = await supabase.rpc('set_system_limits', { p_db_mb: Number(limits.db), p_storage_mb: Number(limits.storage) })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Plan limits saved."))
    void check()
  }

  const list = rows(status, db, auth, at)
  const worst = list.some((r) => r.health === 'down') ? 'down' : list.some((r) => r.health === 'degraded') ? 'degraded' : 'operational'
  const dbLimit = (status?.limits.db_limit_mb ?? 500) * 1024 * 1024
  const fileLimit = (status?.limits.storage_limit_mb ?? 1024) * 1024 * 1024
  const tables = status ? (allTables ? status.tables : status.tables.slice(0, 12)) : []

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title={tr("System Status")}
        aside={
          <button type="button" className={secondaryButtonClass} onClick={() => void check()} disabled={busy}>
            {busy ? tr("Checking…") : tr("Check Again")}
          </button>
        }
      >
        {tr("Checked")} {timeFmt.format(at)}{tr("; checks again every minute while this page is open.")}
      </AdminPageHeader>

      {euReminder && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{tr("Declarations of conformity:")}</strong> {tr("the EU Machinery Regulation (EU) 2023/1230 applies from")} {showDate(EU_REGULATION_DATE)}{tr(". New declarations still use the EC Machinery Directive 2006/42/EC.")}{' '}
          <Can permission="admin.ce" level="edit" fallback={<>{tr("Ask an admin to switch the declaration type.")}</>}>
            <Link to="/admin/ce?find=ce-settings" className="underline">
              {tr("Check the EU template and switch the declaration type")}
            </Link>
            .
          </Can>
        </div>
      )}

      <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium ring-1 ${BADGE[worst].cls}`}>
        <Icon name={worst === 'operational' ? 'check' : 'alert'} className="h-4 w-4" />
        {worst === 'operational' ? tr("Everything set up is working.") : worst === 'degraded' ? tr("Something needs attention (see the amber items below).") : tr("Something is not working (see the red items below).")}
      </div>

      <section className="rounded-lg border border-slate-200 bg-white" aria-label={tr("Services")}>
        <ul className="divide-y divide-slate-100">
          {list.map((r) => (
            <li key={r.key} className="flex flex-col gap-1.5 px-4 py-3 lg:flex-row lg:items-center lg:gap-4">
              <span className="flex w-48 shrink-0 items-center gap-2 font-medium">
                <Icon name={r.icon} className="h-4 w-4 text-slate-500" />
                {r.label}
              </span>
              <span className={`w-fit shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${BADGE[r.health].cls}`}>{BADGE[r.health].label}</span>
              <span className="min-w-0 flex-1 text-sm text-slate-600">{r.detail}</span>
              <span className="shrink-0 text-xs text-slate-500">{tr("Checked")} {timeFmt.format(r.checkedAt)}</span>
            </li>
          ))}
        </ul>
      </section>

      {status && (
        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))]">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-3 font-semibold">{tr("Storage Used")}</h2>
            <div>
              <div className="flex justify-between">
                <span>{tr("Database")}</span>
                <span className="text-slate-600">
                  {size(status.database.size)} {tr("of")} {size(dbLimit)}
                </span>
              </div>
              <Bar used={status.database.size} limit={dbLimit} />
            </div>
            <div className="mt-4">
              <div className="flex justify-between">
                <span>{tr("Files (signatures)")}</span>
                <span className="text-slate-600">
                  {size(status.storage.files_size)} {tr("of")} {size(fileLimit)}
                </span>
              </div>
              <Bar used={status.storage.files_size} limit={fileLimit} />
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
            <h2 className="mb-3 font-semibold">{tr("People")}</h2>
            <dl className="grid grid-cols-3 gap-2 text-center">
              {(
                [
                  ['Users', status.users.total],
                  ['Signed in today', status.users.signed_in_today],
                  ['Made changes today', status.users.active_today],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="rounded-md bg-slate-50 px-2 py-3">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="text-2xl font-semibold">{n}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm" data-setting="limits">
            <h2 className="mb-1 font-semibold">{tr("Plan Limits")}</h2>
            <p className="mb-3 text-slate-600">{tr("The Supabase free plan allows 500 MB of database and 1 GB of files. Change these if the plan changes.")}</p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label={tr("Database (MB)")} htmlFor="lim-db">
                <input id="lim-db" inputMode="numeric" className={`${narrowInputClass} w-28`} value={limits.db} onChange={(e) => setLimits({ ...limits, db: e.target.value })} />
              </Field>
              <Field label={tr("Files (MB)")} htmlFor="lim-files">
                <input id="lim-files" inputMode="numeric" className={`${narrowInputClass} w-28`} value={limits.storage} onChange={(e) => setLimits({ ...limits, storage: e.target.value })} />
              </Field>
              <button type="button" className={buttonClass} onClick={saveLimits}>
                {tr("Save Changes")}
              </button>
            </div>
          </section>
        </div>
      )}

      {status && status.jobs.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-white text-sm" aria-label={tr("Scheduled jobs")}>
          <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">{tr("Scheduled Jobs")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">{tr("Job")}</th>
                  <th className="px-4 py-2 font-medium">{tr("Runs")}</th>
                  <th className="px-4 py-2 font-medium">{tr("Last run")}</th>
                  <th className="px-4 py-2 font-medium">{tr("Result")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {status.jobs.map((j) => (
                  <tr key={j.name}>
                    <td className="px-4 py-2 font-medium">{j.name}</td>
                    <td className="px-4 py-2 font-mono text-xs">{j.schedule}</td>
                    <td className="px-4 py-2">{when(j.last_run)}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${BADGE[j.last_status === 'failed' ? 'down' : j.failed_24h ? 'degraded' : 'operational'].cls}`}>
                        {j.last_status === 'failed' ? tr("Failed") : j.last_status ? tr("Succeeded") : tr("Not run yet")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {status && (
        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))]">
          <section className="rounded-lg border border-slate-200 bg-white text-sm" aria-label={tr("Recent errors")}>
            <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">{tr("Recent Errors")}</h2>
            {status.errors.length === 0 ? (
              <p className="px-4 py-6 text-center text-slate-500">{tr("No recent errors.")}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {status.errors.map((e, i) => (
                  <li key={i} className="px-4 py-2">
                    <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500">
                      <span className="font-semibold text-red-700">{e.source}</span>
                      <span>{when(e.at)}</span>
                    </div>
                    <p className="break-words">{e.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 bg-white text-sm" aria-label={tr("Tables")}>
            <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">{tr("Tables")}</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">{tr("Table")}</th>
                    <th className="px-4 py-2 text-right font-medium">{tr("Rows")}</th>
                    <th className="px-4 py-2 text-right font-medium">{tr("Size")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tables.map((t) => (
                    <tr key={t.name}>
                      <td className="px-4 py-1.5 font-mono text-xs">{t.name}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{t.rows.toLocaleString(currentLang())}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{size(t.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {status.tables.length > 12 && (
              <button type="button" className="w-full border-t border-slate-100 px-4 py-2 text-left text-xs text-slate-600 underline" onClick={() => setAllTables(!allTables)}>
                {allTables ? tr("Show the 12 largest") : tr("Show all {{length}} tables", { length: status.tables.length })}
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
