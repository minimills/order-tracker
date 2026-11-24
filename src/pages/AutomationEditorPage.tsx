// @permission-scope automations
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import Icon from '../components/Icon'
import RunLog from '../components/automations/RunLog'
import { ActionRow, ConditionRow, TriggerSettings } from '../components/automations/RuleParts'
import ShareAutomationDialog from '../components/automations/ShareAutomationDialog'
import TestDialog from '../components/automations/TestDialog'
import { Section, Switch, buttonClass, inputClass, narrowInputClass, secondaryButtonClass } from '../components/form'
import {
  blankRule,
  copyAutomation,
  describeRule,
  listAutomations,
  loadCatalog,
  loadChoices,
  loadTemplates,
  ruleFromTemplate,
  saveAutomation,
  type Action,
  type AutomationRow,
  type Catalog,
  type Choices,
  type Condition,
  type Rule,
} from '../lib/automations'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { friendlyError } from '../lib/format'
import { useStageLabels } from '../lib/stages'
import { ACTION } from '../lib/wording'
import { Badges } from './AutomationsPage'
import { tr } from '../i18n'

/** /automations/new (optionally ?template=&board=) and /automations/:id (?tab=log). */
export default function AutomationEditorPage() {
  useStageLabels()
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [cat, setCat] = useState<Catalog | null>(null)
  const [choices, setChoices] = useState<Choices | null>(null)
  const [row, setRow] = useState<AutomationRow | null>(null)
  const [rule, setRule] = useState<Rule | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [dialog, setDialog] = useState<null | { kind: 'test'; snapshot: Rule | undefined } | { kind: 'share' }>(null)
  const tab = params.get('tab') === 'log' && !isNew ? 'log' : 'rule'
  useBreadcrumbs([{ get label() {
    return tr("Automations")
  }, to: '/automations' }, { label: isNew ? 'New Automation' : (row?.name ?? 'Automation') }])

  const load = useCallback(async () => {
    try {
      const [c, ch] = await Promise.all([loadCatalog(), loadChoices()])
      setCat(c)
      setChoices(ch)
      if (isNew) {
        const board = params.get('board')
        const tpl = params.get('template')
        const t = tpl ? (await loadTemplates()).find((x) => x.id === tpl) : undefined
        setRule(t ? ruleFromTemplate(t, board) : blankRule(board))
      } else {
        const found = (await listAutomations()).find((r) => r.id === id)
        if (!found) setMissing(true)
        setRow(found ?? null)
        setRule(found ?? null)
      }
      setDirty(false)
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
    // the template and board are read once when the page opens
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const readOnly = !isNew && (row?.level ?? 0) < 2
  const trigger = useMemo(() => cat?.triggers.find((t) => t.key === rule?.trigger_key), [cat, rule?.trigger_key])
  const subject = trigger?.subject ?? 'none'
  const groups = useMemo(() => [...new Set((cat?.triggers ?? []).map((t) => t.group))], [cat])

  if (missing) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{tr("This automation could not be found. It may have been archived, or it is not shared with you.")}</p>
        <Link to="/automations" className="text-blue-700 underline">
          {tr("← Automations")}
        </Link>
      </div>
    )
  }
  if (!cat || !choices || !rule) return <p className="text-sm text-slate-500">{tr("Loading…")}</p>

  const change = (patch: Partial<Rule>) => {
    setRule({ ...rule, ...patch })
    setDirty(true)
  }
  const setCondition = (i: number, c: Condition) => change({ conditions: rule.conditions.map((x, j) => (j === i ? c : x)) })
  const setAction = (i: number, a: Action) => change({ actions: rule.actions.map((x, j) => (j === i ? a : x)) })
  const moveAction = (i: number, d: -1 | 1) => {
    const list = [...rule.actions]
    const j = i + d
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    change({ actions: list })
  }
  const conditionChoices = cat.conditions.filter((c) => c.subjects.includes(subject))
  const actionChoices = cat.actions.filter((a) => a.subjects.includes(subject))
  const actionGroups = [...new Set(actionChoices.map((a) => a.group))]
  const editableBoards = choices.boards.filter((b) => b.level >= 2)
  const ownerText = isNew ? 'You' : row?.mine ? 'You' : (row?.owner_name ?? row?.removed_owner_email ?? 'Nobody')

  async function save() {
    if (!rule) return
    setBusy(true)
    try {
      const newId = await saveAutomation(rule)
      toast.success(isNew ? tr("Automation created.") : tr("Changes saved."))
      setDirty(false)
      if (isNew) navigate(`/automations/${newId}`, { replace: true })
      else load()
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
    setBusy(false)
  }
  async function copy() {
    if (!row) return
    try {
      const newId = await copyAutomation(row.id)
      toast.success(tr("A copy was added to My Automations (turned off until you check it)."))
      navigate(`/automations/${newId}`)
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={rule.scope === 'board' && rule.board_id ? `/automations?tab=board&board=${rule.board_id}` : '/automations'} className="text-sm text-blue-700 underline">
            {tr("← Automations")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{isNew ? tr("New Automation") : row?.name}</h1>
          {row && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span>{tr("Owner:")} {ownerText}</span>
              <Badges row={row} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Can permission="automations">
            <button type="button" className={secondaryButtonClass} onClick={() => setDialog({ kind: 'test', snapshot: dirty || isNew ? { ...rule } : undefined })}>
              <Icon name="play" /> {tr("Test")}
            </button>
          </Can>
          {row && row.level >= 3 && rule.scope === 'personal' && (
            <Can permission="automations.share" level="edit">
              <button type="button" className={secondaryButtonClass} onClick={() => setDialog({ kind: 'share' })}>
                <Icon name="share" /> {tr("Share")}
              </button>
            </Can>
          )}
          {row && !row.mine && (
            <Can permission="automations" level="edit">
              <button type="button" className={secondaryButtonClass} onClick={copy}>
                {tr("Copy to Mine")}
              </button>
            </Can>
          )}
          {!readOnly && (
            <Can permission="automations" level="edit">
              <button type="button" className={buttonClass} disabled={busy || (!dirty && !isNew)} onClick={save}>
                {busy ? ACTION.saving : isNew ? tr("Create Automation") : ACTION.save}
              </button>
            </Can>
          )}
        </div>
      </div>

      {!isNew && (
        <Can permission="automations">
          <div className="flex gap-2 border-b border-slate-200" role="tablist">
            {[
              { key: 'rule', get label() {
    return tr("Rule")
  } },
              { key: 'log', get label() {
    return tr("Run Log")
  } },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setParams(t.key === 'log' ? { tab: 'log' } : {}, { replace: true })}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Can>
      )}

      {tab === 'log' && row ? (
        <Can permission="automations">
          <RunLog automationId={row.id} />
        </Can>
      ) : (
        <Can permission="automations">
          {readOnly && (
            <p className="rounded-md bg-slate-100 p-3 text-sm text-slate-700">
              {tr("You can see and test this automation")}{row?.paused_reason === 'owner_removed' ? '' : tr(" and copy it to your own automations")}{tr(", but not change it.")}
            </p>
          )}
          {!isNew && row && !row.mine && !readOnly && (
            <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              {tr("This automation belongs to")} {ownerText}{tr(". It runs with their permissions, so you can only add what both of you are permitted to do.")}
            </p>
          )}

          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
            <p className="font-medium">{tr("In words")}</p>
            <p className="mt-1">{describeRule(rule, cat, choices)}</p>
          </div>

          <Section
            title={tr("Name")}
            aside={
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={rule.enabled} onChange={(on) => change({ enabled: on })} label={tr("Automation on or off")} disabled={readOnly || row?.paused_reason === 'owner_removed'} />
                {rule.enabled ? tr("On") : tr("Off")}
              </label>
            }
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="au-name" className="mb-1 block text-sm font-medium text-slate-700">
                  {tr("Name")}
                </label>
                <input id="au-name" className={inputClass} value={rule.name} maxLength={120} onChange={(e) => change({ name: e.target.value })} disabled={readOnly} placeholder={tr("For example Finish cards in Done")} />
              </div>
              <div>
                <label htmlFor="au-desc" className="mb-1 block text-sm font-medium text-slate-700">
                  {tr("Description (optional)")}
                </label>
                <input id="au-desc" className={inputClass} value={rule.description ?? ''} maxLength={1000} onChange={(e) => change({ description: e.target.value || null })} disabled={readOnly} />
              </div>
            </div>
            {choices.can_board_rules && (isNew || row?.level === 3) && (
              <div className="mt-3">
                <label htmlFor="au-scope" className="mb-1 block text-sm font-medium text-slate-700">
                  {tr("Who sees it")}
                </label>
                <select
                  id="au-scope"
                  className={`${narrowInputClass} w-full max-w-xl`}
                  value={rule.scope === 'board' ? (rule.board_id ?? '') : ''}
                  onChange={(e) => change(e.target.value ? { scope: 'board', board_id: e.target.value } : { scope: 'personal', board_id: null })}
                  disabled={readOnly}
                >
                  <option value="">{tr("Only me, and the people I share it with")}</option>
                  {editableBoards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {tr("Board automation: everyone on")} {b.name} {tr("(runs only for cards on this board)")}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </Section>

          <Section title={tr("When")}>
            <label htmlFor="au-trigger" className="mb-1 block text-sm font-medium text-slate-700">
              {tr("What starts it")}
            </label>
            <select
              id="au-trigger"
              className={`${narrowInputClass} w-full max-w-xl`}
              value={rule.trigger_key}
              onChange={(e) => change({ trigger_key: e.target.value, trigger_config: e.target.value === 'schedule' ? { frequency: 'daily', time: '08:00' } : {} })}
              disabled={readOnly}
            >
              <option value="">{tr("Choose…")}</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {cat.triggers
                    .filter((t) => t.group === g)
                    .map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            {rule.trigger_key && !trigger && <p className="mt-1 text-sm text-red-700">{tr("The owner no longer has access to what starts this automation.")}</p>}
            {trigger && <TriggerSettings def={trigger} rule={rule} choices={choices} onChange={(c) => change({ trigger_config: c })} disabled={readOnly} />}
            {trigger?.timed && <p className="mt-2 text-xs text-slate-500">{tr("Checked every minute. Each card or payment starts it once for each due date.")}</p>}
          </Section>

          <Section
            title={tr("If (optional)")}
            aside={
              rule.conditions.length > 1 && (
                <select aria-label={tr("Match")} className={`${narrowInputClass} w-56`} value={rule.match} onChange={(e) => change({ match: e.target.value as Rule['match'] })} disabled={readOnly}>
                  <option value="all">{tr("All conditions are true")}</option>
                  <option value="any">{tr("Any one condition is true")}</option>
                </select>
              )
            }
          >
            {rule.conditions.length === 0 && <p className="text-sm text-slate-500">{tr("No conditions: it runs every time.")}</p>}
            <ul className="space-y-3">
              {rule.conditions.map((c, i) => (
                <li key={i} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                  <ConditionRow cond={c} index={i} subject={subject} catalog={cat} choices={choices} rule={rule} onChange={(x) => setCondition(i, x)} disabled={readOnly} />
                  {!readOnly && (
                    <button type="button" aria-label={tr("Remove this condition")} className="text-slate-500 hover:text-red-700" onClick={() => change({ conditions: rule.conditions.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!readOnly && trigger && (
              <select
                aria-label={tr("Add a condition")}
                className={`${narrowInputClass} mt-3 w-full max-w-md`}
                value=""
                onChange={(e) => e.target.value && change({ conditions: [...rule.conditions, { type: e.target.value, op: conditionChoices.find((c) => c.key === e.target.value)?.ops?.[0], values: [] }] })}
              >
                <option value="">{tr("+ Add a condition…")}</option>
                {conditionChoices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Section>

          <Section title={tr("Then")}>
            {rule.actions.length === 0 && <p className="text-sm text-slate-500">{tr("Add at least one action.")}</p>}
            <ol className="space-y-3">
              {rule.actions.map((a, i) => (
                <li key={i} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                  <span className="mt-0.5 text-sm font-semibold text-slate-500">{i + 1}.</span>
                  <ActionRow action={a} index={i} subject={subject} catalog={cat} choices={choices} rule={rule} onChange={(x) => setAction(i, x)} disabled={readOnly} />
                  {!readOnly && (
                    <div className="flex flex-col gap-1">
                      <button type="button" aria-label={tr("Move up")} className="text-slate-500 hover:text-slate-900 disabled:opacity-30" disabled={i === 0} onClick={() => moveAction(i, -1)}>
                        ↑
                      </button>
                      <button type="button" aria-label={tr("Move down")} className="text-slate-500 hover:text-slate-900 disabled:opacity-30" disabled={i === rule.actions.length - 1} onClick={() => moveAction(i, 1)}>
                        ↓
                      </button>
                      <button type="button" aria-label={tr("Remove this action")} className="text-slate-500 hover:text-red-700" onClick={() => change({ actions: rule.actions.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {!readOnly && trigger && rule.actions.length < cat.settings.max_actions_per_rule && (
              <select aria-label={tr("Add an action")} className={`${narrowInputClass} mt-3 w-full max-w-md`} value="" onChange={(e) => e.target.value && change({ actions: [...rule.actions, { type: e.target.value }] })}>
                <option value="">{tr("+ Add an action…")}</option>
                {actionGroups.map((g) => (
                  <optgroup key={g} label={g}>
                    {actionChoices
                      .filter((a) => a.group === g)
                      .map((a) => (
                        <option key={a.key} value={a.key}>
                          {a.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
            <p className="mt-3 text-xs text-slate-500">
              {tr("Text can include")} {cat.placeholders.map((p) => `{${p}}`).join(' ')}{tr(". They are filled in when the automation runs, for example “Order")} {'{order_number}'} – {'{customer}'}”.
            </p>
          </Section>
        </Can>
      )}

      {dialog?.kind === 'test' && <TestDialog automation={row ?? undefined} rule={dialog.snapshot} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'share' && row && <ShareAutomationDialog automation={row} choices={choices} onClose={() => setDialog(null)} onSaved={load} />}
    </div>
  )
}
