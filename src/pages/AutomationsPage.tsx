// @permission-scope automations
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import Icon from '../components/Icon'
import NewAutomationDialog from '../components/automations/NewAutomationDialog'
import RunLogDialog from '../components/automations/RunLogDialog'
import ShareAutomationDialog from '../components/automations/ShareAutomationDialog'
import TestDialog from '../components/automations/TestDialog'
import { Switch, buttonClass, narrowInputClass, secondaryButtonClass } from '../components/form'
import {
  RUN_STATUS,
  archiveAutomation,
  copyAutomation,
  describeRule,
  listAutomations,
  loadCatalog,
  loadChoices,
  setAutomationEnabled,
  when,
  type AutomationRow,
  type Catalog,
  type Choices,
} from '../lib/automations'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { confirmAction } from '../lib/confirm'
import { friendlyError } from '../lib/format'
import { useStageLabels } from '../lib/stages'
import { ACTION } from '../lib/wording'
import { tr } from '../i18n'

type Tab = 'mine' | 'shared' | 'board'

/** /automations: My Automations, Shared with Me, Board Automations. */
export default function AutomationsPage() {
  useStageLabels()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const boardFilter = params.get('board')
  const tab: Tab = (params.get('tab') as Tab) ?? (boardFilter ? 'board' : 'mine')
  const [rows, setRows] = useState<AutomationRow[] | null>(null)
  const [cat, setCat] = useState<Catalog | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [dialog, setDialog] = useState<null | { kind: 'new' | 'test' | 'log' | 'share'; row?: AutomationRow }>(null)
  useBreadcrumbs([{ get label() {
    return tr("Automations")
  } }])

  const load = useCallback(async () => {
    try {
      const [r, c, ch] = await Promise.all([listAutomations(), loadCatalog(), loadChoices()])
      setRows(r)
      setCat(c)
      setChoices(ch)
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
      setRows([])
    }
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const shown = useMemo(() => {
    const list = (rows ?? []).filter((r) => showArchived || !r.archived)
    if (tab === 'mine') return list.filter((r) => r.mine && r.scope === 'personal')
    if (tab === 'shared') return list.filter((r) => !r.mine && r.scope === 'personal')
    return list.filter((r) => r.scope === 'board' && (!boardFilter || r.board_id === boardFilter))
  }, [rows, tab, showArchived, boardFilter])

  const count = (t: Tab) =>
    (rows ?? []).filter((r) => !r.archived && (t === 'mine' ? r.mine && r.scope === 'personal' : t === 'shared' ? !r.mine && r.scope === 'personal' : r.scope === 'board')).length
  const boardName = boardFilter ? (choices?.boards.find((b) => b.id === boardFilter)?.name ?? rows?.find((r) => r.board_id === boardFilter)?.board_name) : null

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params)
    next.set('tab', t)
    if (t !== 'board') next.delete('board')
    setParams(next, { replace: true })
  }

  async function toggle(r: AutomationRow, on: boolean) {
    try {
      await setAutomationEnabled(r.id, on)
      toast.success(on ? tr("“{{name}}” is on.", { name: r.name }) : tr("“{{name}}” is paused.", { name: r.name }))
      load()
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
  }
  async function archive(r: AutomationRow) {
    if (!r.archived && !(await confirmAction(tr("Archive the automation “{{name}}”? It stops running. It can be restored later.", { name: r.name }), { confirmLabel: ACTION.archive }))) return
    try {
      await archiveAutomation(r.id, !r.archived)
      toast.success(r.archived ? tr("Automation restored.") : tr("Automation archived."))
      load()
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
  }
  async function copy(r: AutomationRow) {
    try {
      const id = await copyAutomation(r.id)
      toast.success(tr("A copy was added to My Automations (turned off until you check it)."))
      navigate(`/automations/${id}`)
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'mine', get label() {
    return tr("My Automations")
  } },
    { key: 'shared', get label() {
    return tr("Shared with Me")
  } },
    { key: 'board', get label() {
    return tr("Board Automations")
  } },
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{tr("Automations")}</h1>
          <p className="max-w-3xl text-sm text-slate-600">
            {tr("Rules that work for you:")} <strong>{tr("When")}</strong> {tr("something happens,")} <strong>{tr("If")}</strong> {tr("optional conditions are true,")} <strong>{tr("Then")}</strong> {tr("do one or more actions. An automation always runs with its owner’s permissions, so it can only do what the owner could do.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Can permission="admin.automations" level="edit">
            <Link to="/admin/automations" className={secondaryButtonClass}>
              {tr("Manage All Automations")}
            </Link>
          </Can>
          <Can permission="automations" level="edit">
            <button type="button" className={buttonClass} onClick={() => setDialog({ kind: 'new' })}>
              <Icon name="plus" /> {tr("New Automation")}
            </button>
          </Can>
        </div>
      </div>

      <Can permission="automations">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
            >
              {t.label} <span className="text-slate-400">({count(t.key)})</span>
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 pb-2 text-sm text-slate-600">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {ACTION.showArchived}
          </label>
        </div>

        {tab === 'board' && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="au-board" className="text-slate-600">
              {tr("Board")}
            </label>
            <select
              id="au-board"
              className={`${narrowInputClass} min-w-48`}
              value={boardFilter ?? ''}
              onChange={(e) => {
                const next = new URLSearchParams(params)
                if (e.target.value) next.set('board', e.target.value)
                else next.delete('board')
                next.set('tab', 'board')
                setParams(next, { replace: true })
              }}
            >
              <option value="">{tr("All boards")}</option>
              {(choices?.boards ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {boardFilter && (
              <Link to={`/boards/${boardFilter}`} className="text-blue-700 underline">
                {tr("Open")} {boardName ?? tr("the board")}
              </Link>
            )}
          </div>
        )}

        {rows === null ? (
          <p className="text-sm text-slate-500">{tr("Loading…")}</p>
        ) : shown.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
            {tab === 'mine'
              ? tr("You have no automations yet. Choose New Automation to start from an example or from scratch.")
              : tab === 'shared'
                ? tr("No automations are shared with you.")
                : boardFilter
                  ? tr("No automations on {{value}} yet.", { value: boardName ?? tr("this board") })
                  : tr("No board automations on the boards you can open.")}
          </div>
        ) : (
          <ul className="space-y-3">
            {shown.map((r) => (
              <li key={r.id} className={`rounded-lg border border-slate-200 bg-white p-4 ${r.archived ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <Can permission="automations" level="edit" fallback={<StatusDot on={r.enabled} />}>
                    {r.level >= 2 && !r.archived ? (
                      <Switch checked={r.enabled} onChange={(on) => toggle(r, on)} label={tr("{{name}}: on or off", { name: r.name })} />
                    ) : (
                      <StatusDot on={r.enabled} />
                    )}
                  </Can>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/automations/${r.id}`} className="font-semibold text-slate-900 hover:underline">
                        {r.name}
                      </Link>
                      <Badges row={r} />
                    </div>
                    <p className="mt-1 text-sm text-slate-700">{describeRule(r, cat, choices)}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {r.mine ? tr("Yours") : tr("Owner: {{value}}", { value: r.owner_name ?? r.removed_owner_email ?? 'nobody' })}
                      {r.last_run_at ? tr(" · Last run {{when}} ({{value}})", { when: when(r.last_run_at), value: RUN_STATUS[r.last_status ?? '']?.text ?? r.last_status }) : tr(" · Not run yet")}
                      {` · ${r.run_count} ${r.run_count === 1 ? tr("run") : tr("runs")}`}
                      {r.runs_today ? tr(", {{runs_today}} today", { runs_today: r.runs_today }) : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link to={`/automations/${r.id}`} className={secondaryButtonClass}>
                      {r.level >= 2 ? ACTION.edit : tr("View")}
                    </Link>
                    <button type="button" className={secondaryButtonClass} onClick={() => setDialog({ kind: 'test', row: r })} disabled={r.archived}>
                      {tr("Test")}
                    </button>
                    <button type="button" className={secondaryButtonClass} onClick={() => setDialog({ kind: 'log', row: r })}>
                      <Icon name="history" /> {tr("Run Log")}
                    </button>
                    {r.level >= 3 && r.scope === 'personal' && (
                      <Can permission="automations.share" level="edit">
                        <button type="button" className={secondaryButtonClass} onClick={() => setDialog({ kind: 'share', row: r })}>
                          <Icon name="share" /> {tr("Share")}
                        </button>
                      </Can>
                    )}
                    {!r.mine && (
                      <Can permission="automations" level="edit">
                        <button type="button" className={secondaryButtonClass} onClick={() => copy(r)}>
                          {tr("Copy to Mine")}
                        </button>
                      </Can>
                    )}
                    {r.can_archive && (
                      <Can permission="automations" level="edit">
                        <button type="button" className={secondaryButtonClass} onClick={() => archive(r)}>
                          {r.archived ? ACTION.restore : ACTION.archive}
                        </button>
                      </Can>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Can>

      {dialog?.kind === 'new' && cat && choices && (
        <NewAutomationDialog catalog={cat} choices={choices} boardId={boardFilter} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'test' && dialog.row && <TestDialog automation={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'log' && dialog.row && <RunLogDialog automation={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'share' && dialog.row && choices && (
        <ShareAutomationDialog automation={dialog.row} choices={choices} onClose={() => setDialog(null)} onSaved={load} />
      )}
    </div>
  )
}

/* @layout-helper */
function StatusDot({ on }: { on: boolean }) {
  return (
    <span className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${on ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-700'}`}>
      {on ? tr("On") : tr("Off")}
    </span>
  )
}

/* @layout-helper */
export function Badges({ row }: { row: AutomationRow }) {
  return (
    <>
      {row.scope === 'board' && <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-800">{tr("Board:")} {row.board_name ?? tr("archived board")}</span>}
      {row.shared_with_me && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{tr("Shared with you")}{row.level >= 2 ? tr(" (can edit)") : ''}</span>}
      {row.mine && row.shares.length > 0 && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{tr("Shared with")} {row.shares.length}</span>}
      {row.paused_reason === 'admin' && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{tr("Paused by an administrator")}</span>}
      {row.paused_reason === 'owner_removed' && <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">{tr("Owner removed")}</span>}
      {row.archived && <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700">{tr("Archived")}</span>}
    </>
  )
}
