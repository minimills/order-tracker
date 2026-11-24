// @permission-scope admin.automations
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { Section, Switch, buttonClass, inputClass, narrowInputClass, secondaryButtonClass } from '../../components/form'
import {
  RUN_STATUS,
  describeRule,
  listAutomations,
  loadCatalog,
  loadChoices,
  loadTemplates,
  ruleBody,
  setAutomationEnabled,
  when,
  type AutomationRow,
  type Catalog,
  type Choices,
  type Template,
} from '../../lib/automations'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { Person } from '../../lib/boards'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

type Settings = { enabled: boolean; max_rules_per_user: number; max_actions_per_rule: number; runs_per_minute_rule: number; runs_per_minute_user: number; max_chain: number; keep_days: number }
type Status = { cron: boolean; running: boolean; last_run?: string | null; settings: Settings; owner_removed: number }

const LIMITS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'max_rules_per_user', get label() {
    return tr("Automations per person")
  }, get hint() {
    return tr("Archived automations do not count.")
  } },
  { key: 'max_actions_per_rule', get label() {
    return tr("Actions per automation")
  }, get hint() {
    return tr("The most “Then” steps in one automation.")
  } },
  { key: 'runs_per_minute_rule', get label() {
    return tr("Runs per minute, per automation")
  }, get hint() {
    return tr("More runs are refused and logged; the owner is told.")
  } },
  { key: 'runs_per_minute_user', get label() {
    return tr("Runs per minute, per person")
  }, get hint() {
    return tr("All automations of one owner together.")
  } },
  { key: 'max_chain', get label() {
    return tr("Automations that may follow one another")
  }, get hint() {
    return tr("A change made by an automation may start other automations, up to this many in a row. An automation never starts itself again.")
  } },
  { key: 'keep_days', get label() {
    return tr("Keep the run log for (days)")
  }, get hint() {
    return tr("Older lines are removed automatically.")
  } },
]

/** Admin → Automations: everyone's automations, limits, removed owners, templates, the minute job. */
export default function AutomationsAdminPage() {
  const [rows, setRows] = useState<AutomationRow[]>([])
  const [cat, setCat] = useState<Catalog | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [form, setForm] = useState<Settings | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [reassign, setReassign] = useState<Record<string, string>>({})
  const [tplFrom, setTplFrom] = useState('')

  const load = useCallback(async () => {
    if (!supabase) return
    try {
      const [r, c, ch, st, t, p] = await Promise.all([
        listAutomations(true),
        loadCatalog(),
        loadChoices(),
        supabase.rpc('automation_schedule_status'),
        loadTemplates(true),
        supabase.rpc('people_choices'),
      ])
      setRows(r)
      setCat(c)
      setChoices(ch)
      if (st.error) throw st.error
      setStatus(st.data as Status)
      setForm((st.data as Status).settings)
      setTemplates(t)
      setPeople((p.data as Person[]) ?? [])
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const call = async (fn: string, args: Record<string, unknown>, ok: string) => {
    if (!supabase) return false
    setBusy(true)
    const { error } = await supabase.rpc(fn, args)
    setBusy(false)
    if (error) {
      toast.error(friendlyError(error))
      return false
    }
    toast.success(ok)
    load()
    return true
  }

  const removed = rows.filter((r) => r.paused_reason === 'owner_removed' && !r.archived)
  const shown = useMemo(
    () => rows.filter((r) => `${r.name} ${r.owner_name ?? ''} ${r.owner_email ?? ''} ${r.board_name ?? ''}`.toLowerCase().includes(q.toLowerCase())),
    [rows, q],
  )

  async function toggle(r: AutomationRow, on: boolean) {
    try {
      await setAutomationEnabled(r.id, on)
      toast.success(on ? tr("“{{name}}” is on.", { name: r.name }) : tr("“{{name}}” is paused. Only an administrator can turn it on again.", { name: r.name }))
      load()
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHeader title={tr("Automations")}>
        {tr("Everyone’s automations. Each automation runs with its owner’s permissions, checked every time it runs. Pausing someone else’s automation here means only an administrator can turn it on again.")}
      </AdminPageHeader>

      <Section title={tr("Limits")} aside={status && <span className="text-sm text-slate-500">{tr("Every minute:")} {status.running ? tr("running") : tr("not running")}</span>}>
        {form && (
          <div className="space-y-4" data-setting="au-limits">
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={form.enabled} onChange={(on) => setForm({ ...form, enabled: on })} label={tr("All automations on or off")} />
              {form.enabled ? tr("Automations are running") : tr("All automations are stopped (nothing runs until this is turned on again)")}
            </label>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr))]">
              {LIMITS.map((l) => (
                <div key={l.key}>
                  <label htmlFor={`au-${l.key}`} className="mb-1 block text-sm font-medium text-slate-700">
                    {l.label}
                  </label>
                  <input
                    id={`au-${l.key}`}
                    type="number"
                    min={1}
                    max={1000}
                    className={`${narrowInputClass} w-28`}
                    value={form[l.key] as number}
                    onChange={(e) => setForm({ ...form, [l.key]: Number(e.target.value) })}
                  />
                  <p className="mt-1 text-xs text-slate-500">{l.hint}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass} disabled={busy} onClick={() => call('set_automation_settings', { p: form }, tr("Automation settings saved."))}>
                {ACTION.save}
              </button>
              {status?.cron &&
                (status.running ? (
                  <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => call('stop_automation_schedule', {}, tr("Scheduled automations turned off."))}>
                    {tr("Turn Off Scheduled Automations")}
                  </button>
                ) : (
                  <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => call('start_automation_schedule', {}, tr("Scheduled automations turned on."))}>
                    {tr("Turn On Scheduled Automations")}
                  </button>
                ))}
            </div>
            <p className="text-xs text-slate-500">
              {tr("Schedules, approaching or passed due dates and payment reminders are checked every minute")}{status?.last_run ? tr(" (last checked {{when}})", { when: when(status.last_run) }) : ''}.
              {!status?.cron && tr(" Turn on the pg_cron extension in Supabase → Database → Extensions first.")}
            </p>
          </div>
        )}
      </Section>

      <Section title={tr("Automations of People Who Were Removed")}>
        <div data-setting="au-removed">
          {removed.length === 0 ? (
            <p className="text-sm text-slate-500">{tr("None. When a person is removed, their automations are paused and listed here.")}</p>
          ) : (
            <ul className="space-y-2">
              {removed.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <Link to={`/automations/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>{' '}
                    <span className="text-slate-500">{tr("(was")} {r.owner_name ?? r.removed_owner_email})</span>
                  </span>
                  <select aria-label={tr("New owner of {{name}}", { name: r.name })} className={`${narrowInputClass} w-56`} value={reassign[r.id] ?? ''} onChange={(e) => setReassign({ ...reassign, [r.id]: e.target.value })}>
                    <option value="">{tr("Give to…")}</option>
                    {people.map((p) => (
                      <option key={p.email} value={p.email}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={busy || !reassign[r.id]}
                    onClick={() => call('admin_reassign_automation', { p_id: r.id, p_email: reassign[r.id] }, tr("Automation given to the new owner (turned off until they check it)."))}
                  >
                    {tr("Give to Another Person")}
                  </button>
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={busy}
                    onClick={async () => (await confirmAction(tr("Archive “{{name}}”?", { name: r.name }), { confirmLabel: ACTION.archive })) && call('archive_automation', { p_id: r.id, p_archived: true }, tr("Automation archived."))}
                  >
                    {ACTION.archive}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title={tr("All Automations")} aside={<input aria-label={tr("Search automations")} className={`${inputClass} max-w-xs`} placeholder={tr("Search name, owner or board")} value={q} onChange={(e) => setQ(e.target.value)} />}>
        {shown.length === 0 ? (
          <p className="text-sm text-slate-500">{tr("No automations yet.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-3">{tr("On")}</th>
                  <th className="py-2 pr-3">{tr("Automation")}</th>
                  <th className="py-2 pr-3">{tr("Owner")}</th>
                  <th className="py-2 pr-3">{tr("Last run")}</th>
                  <th className="py-2 pr-3">{tr("Runs")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((r) => (
                  <tr key={r.id} className={r.archived ? 'opacity-60' : ''}>
                    <td className="py-2 pr-3 align-top">
                      {!r.archived && r.owner_email && <Switch checked={r.enabled} onChange={(on) => toggle(r, on)} label={tr("{{name}}: on or off", { name: r.name })} />}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <Link to={`/automations/${r.id}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      {r.scope === 'board' && <span className="ml-2 text-xs text-blue-800">{tr("Board:")} {r.board_name}</span>}
                      {r.paused_reason === 'admin' && <span className="ml-2 text-xs text-amber-800">{tr("Paused by an administrator")}</span>}
                      {r.archived && <span className="ml-2 text-xs text-slate-500">{tr("Archived")}</span>}
                      <p className="max-w-xl text-xs text-slate-600">{describeRule(r, cat, choices)}</p>
                    </td>
                    <td className="py-2 pr-3 align-top">{r.owner_name ?? r.removed_owner_email ?? '—'}</td>
                    <td className="py-2 pr-3 align-top">{r.last_run_at ? `${when(r.last_run_at)} · ${RUN_STATUS[r.last_status ?? '']?.text ?? r.last_status}` : tr("Not run yet")}</td>
                    <td className="py-2 pr-3 align-top">{r.run_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={tr("Templates")}>
        <div data-setting="au-templates" className="space-y-3">
          <p className="text-sm text-slate-600">{tr("The examples people can start from (each person only sees the ones they have access to).")}</p>
          <ul className="space-y-2">
            {templates.map((t) => (
              <li key={t.id} className={`flex flex-wrap items-start gap-2 rounded-md border border-slate-200 p-3 text-sm ${t.archived ? 'opacity-60' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t.name}</p>
                  {t.description && <p className="text-xs text-slate-600">{t.description}</p>}
                </div>
                <button
                  type="button"
                  className={secondaryButtonClass}
                  disabled={busy}
                  onClick={() => call('archive_automation_template', { p_id: t.id, p_archived: !t.archived }, t.archived ? tr("Template restored.") : tr("Template archived."))}
                >
                  {t.archived ? ACTION.restore : ACTION.archive}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <select aria-label={tr("Automation to save as a template")} className={`${narrowInputClass} min-w-64`} value={tplFrom} onChange={(e) => setTplFrom(e.target.value)}>
              <option value="">{tr("Choose an automation…")}</option>
              {rows
                .filter((r) => !r.archived)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.owner_name ?? tr("no owner")})
                  </option>
                ))}
            </select>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy || !tplFrom}
              onClick={async () => {
                const r = rows.find((x) => x.id === tplFrom)
                if (!r) return
                const body = { ...ruleBody(r), id: undefined }
                if (await call('save_automation_template', { p: body }, tr("“{{name}}” saved as a template.", { name: r.name }))) setTplFrom('')
              }}
            >
              {tr("Save as Template")}
            </button>
          </div>
          <p className="text-xs text-slate-500">{tr("People, groups and boards chosen in that automation are kept in the template.")}</p>
        </div>
      </Section>
    </div>
  )
}
