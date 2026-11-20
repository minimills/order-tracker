/**
 * Automations: WHEN something happens, IF optional conditions are true, THEN
 * do one or more actions. The lists of triggers, conditions, fields and actions
 * come from the database (`automation_catalog()`), already narrowed to what the
 * signed-in person may see and do; the choices (boards, stages, labels, people…)
 * from `automation_choices()`. Every automation runs with its owner's
 * permissions, checked again by the database on every run (migration 0049).
 */
import { stageLabel } from './stages'
import { supabase } from './supabase'

export type Subject = 'card' | 'order' | 'payment' | 'machine' | 'notice' | 'time_off' | 'none'

export type TriggerDef = { key: string; group: string; label: string; subject: Subject; perms: string[]; config?: string[]; timed?: boolean }
export type ConditionDef = { key: string; label: string; subjects: Subject[]; input: string; ops?: string[]; perms?: string[] }
export type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'date' }
export type ActionDef = { key: string; group: string; label: string; subjects: Subject[]; perms: string[] }

export type Catalog = {
  triggers: TriggerDef[]
  conditions: ConditionDef[]
  actions: ActionDef[]
  fields: Partial<Record<Subject, FieldDef[]>>
  placeholders: string[]
  can_share: boolean
  can_edit: boolean
  can_manage_all: boolean
  settings: { max_rules_per_user: number; max_actions_per_rule: number; runs_per_minute_rule: number; runs_per_minute_user: number; max_chain: number; keep_days: number }
}

export type BoardChoice = {
  id: string
  name: string
  purpose: string
  level: number
  stages: { id: string; name: string }[]
  labels: { id: string; name: string; colour: string }[]
}
export type Choices = {
  boards: BoardChoice[]
  people: { email: string; name: string }[]
  groups: { id: string; name: string; can_message: boolean }[]
  departments: { id: string; name: string; can_message: boolean }[]
  machine_types: { id: string; name: string }[]
  voltages: string[]
  order_stages: string[]
  my_departments: string[]
  can_post_everyone: boolean
  can_calendar_others: boolean
  can_service: boolean
  can_board_rules: boolean
}

export type Condition = { type: string; op?: string; values?: string[]; value?: string | number | boolean; field?: string }
export type Target = { type: string; target?: string }
export type Action = {
  type: string
  stage?: string
  stage_id?: string
  stage_name?: string
  board_id?: string
  label?: string
  colour?: string
  person?: string
  days?: number | string
  clear?: boolean
  title?: string
  items?: string[]
  description?: string
  due_days?: number | string
  link?: boolean
  channel?: 'app' | 'push' | 'email'
  targets?: Target[]
  message?: string
  body?: string
  priority?: 'normal' | 'important'
  audience?: 'everyone' | 'departments'
  departments?: string[]
  show_days?: number | string
  tech?: string
  when?: 'subject' | 'days'
  length?: number | string
  kind?: 'other' | 'onsite' | 'travel' | 'training'
  notes?: string
}

export type TriggerConfig = {
  stage_name?: string
  label?: string
  days?: number | string
  stage?: string
  frequency?: 'daily' | 'weekdays' | 'weekly'
  days_of_week?: number[]
  time?: string
}

export type Rule = {
  id?: string
  name: string
  description: string | null
  scope: 'personal' | 'board'
  board_id: string | null
  enabled: boolean
  trigger_key: string
  trigger_config: Record<string, unknown>
  match: 'all' | 'any'
  conditions: Condition[]
  actions: Action[]
  template_key?: string | null
}

export type Share = { type: 'user' | 'group' | 'department'; target: string; can_edit: boolean; name?: string }

export type AutomationRow = Rule & {
  id: string
  owner_email: string | null
  owner_name: string | null
  paused_reason: 'owner_removed' | 'admin' | null
  paused_by: string | null
  removed_owner_email: string | null
  last_run_at: string | null
  last_status: string | null
  run_count: number
  runs_today: number
  level: number
  mine: boolean
  shared_with_me: boolean
  board_name: string | null
  can_archive: boolean
  shares: Share[]
  archived: boolean
  created_at: string
  updated_at: string
}

export type ActionResult = { type: string; label: string; status: 'ok' | 'skipped' | 'failed'; message: string | null; permission?: boolean }
export type Run = {
  id: number
  automation_id: string
  started_at: string
  trigger_text: string | null
  subject_title: string | null
  link: string | null
  actor_name: string | null
  status: string
  message: string | null
  actions: ActionResult[]
  is_test: boolean
  depth: number
}
export type TestResult = {
  status: string
  message: string | null
  actions: ActionResult[]
  conditions: { type: string; ok: boolean }[]
  subject: string | null
  link: string | null
  problems?: string[]
}
export type Template = {
  id: string
  key: string | null
  name: string
  description: string | null
  trigger_key: string
  trigger_config: Record<string, unknown>
  match: 'all' | 'any'
  conditions: Condition[]
  actions: Action[]
  archived: boolean
}

export function blankRule(boardId?: string | null): Rule {
  return {
    name: '',
    description: null,
    scope: boardId ? 'board' : 'personal',
    board_id: boardId ?? null,
    enabled: true,
    trigger_key: boardId ? 'card_moved' : '',
    trigger_config: {},
    match: 'all',
    conditions: boardId ? [{ type: 'board', values: [boardId] }] : [],
    actions: [],
  }
}

export function ruleFromTemplate(t: Template, boardId?: string | null): Rule {
  return {
    ...blankRule(boardId),
    name: t.name,
    description: t.description,
    trigger_key: t.trigger_key,
    trigger_config: t.trigger_config ?? {},
    match: t.match ?? 'all',
    conditions: t.conditions ?? [],
    actions: t.actions ?? [],
    template_key: t.key,
  }
}

/** The fields the database stores (what save_automation and test_automation accept). */
export function ruleBody(r: Rule) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    scope: r.scope,
    board_id: r.scope === 'board' ? r.board_id : null,
    enabled: r.enabled,
    trigger_key: r.trigger_key,
    trigger_config: r.trigger_config,
    match: r.match,
    conditions: r.conditions,
    actions: r.actions,
    template_key: r.template_key ?? null,
  }
}

const rpc = async <T,>(fn: string, args?: Record<string, unknown>) => {
  if (!supabase) throw new Error('The database is not set up.')
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data as T
}

export const loadCatalog = () => rpc<Catalog>('automation_catalog')
export const loadChoices = () => rpc<Choices>('automation_choices')
export const listAutomations = (all = false) => rpc<AutomationRow[]>('automation_list', { p_all: all })
export const saveAutomation = (r: Rule) => rpc<string>('save_automation', { p: ruleBody(r) })
export const setAutomationEnabled = (id: string, on: boolean) => rpc<void>('set_automation_enabled', { p_id: id, p_on: on })
export const archiveAutomation = (id: string, archived: boolean) => rpc<void>('archive_automation', { p_id: id, p_archived: archived })
export const copyAutomation = (id: string) => rpc<string>('copy_automation', { p_id: id })
export const shareAutomation = (id: string, shares: Share[]) => rpc<void>('share_automation', { p_id: id, p_shares: shares })
export const testAutomation = (p: { id?: string; rule?: Rule; subject_id?: string | null }) =>
  rpc<TestResult>('test_automation', { p: { id: p.id, rule: p.rule ? ruleBody(p.rule) : undefined, subject_id: p.subject_id ?? null } })
export const testSubjects = (p: { id?: string; rule?: Rule }) =>
  rpc<{ id: string | null; title: string }[]>('automation_test_subjects', {
    p: { id: p.id, trigger_key: p.rule?.trigger_key, scope: p.rule?.scope, board_id: p.rule?.board_id },
  })

export async function loadRuns(id: string, limit = 100) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('automation_runs')
    .select('id, automation_id, started_at, trigger_text, subject_title, link, actor_name, status, message, actions, is_test, depth')
    .eq('automation_id', id)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data as Run[]) ?? []
}

export async function loadTemplates(withArchived = false) {
  if (!supabase) return []
  let q = supabase.from('automation_templates').select('id, key, name, description, trigger_key, trigger_config, match, conditions, actions, archived').order('sort_order')
  if (!withArchived) q = q.eq('archived', false)
  const { data, error } = await q
  if (error) throw error
  return (data as Template[]) ?? []
}

/** A template can be offered when the person may use its trigger and every action. */
export function templateAllowed(t: Template, cat: Catalog) {
  return cat.triggers.some((x) => x.key === t.trigger_key) && t.actions.every((a) => cat.actions.some((x) => x.key === a.type))
}

export const RUN_STATUS: Record<string, { text: string; tone: string }> = {
  done: { text: 'Completed', tone: 'bg-green-100 text-green-800' },
  partial: { text: 'Partly completed', tone: 'bg-amber-100 text-amber-800' },
  failed: { text: 'Failed', tone: 'bg-red-100 text-red-800' },
  skipped: { text: 'Skipped', tone: 'bg-slate-200 text-slate-700' },
  limited: { text: 'Limited', tone: 'bg-amber-100 text-amber-800' },
  loop: { text: 'Stopped (repeat)', tone: 'bg-amber-100 text-amber-800' },
  test: { text: 'Test', tone: 'bg-blue-100 text-blue-800' },
}

export const ACTION_STATUS: Record<string, string> = { ok: 'Done', skipped: 'Skipped', failed: 'Failed' }

export const CHANNELS = [
  { value: 'app', label: 'In-app notification' },
  { value: 'push', label: 'Phone push notification' },
  { value: 'email', label: 'Email notification' },
] as const

export const TARGET_KINDS = [
  { value: 'user', label: 'A person' },
  { value: 'group', label: 'A group' },
  { value: 'department', label: 'A department' },
  { value: 'assignees', label: 'The people on the card' },
  { value: 'actor', label: 'The person who made the change' },
  { value: 'owner', label: 'Me (the owner)' },
  { value: 'board', label: 'Everyone who can open the board' },
  { value: 'person', label: 'The person who is off' },
  { value: 'technician', label: 'The technician' },
] as const

export const BOARD_KINDS = [
  { value: 'production', label: 'Production boards' },
  { value: 'service', label: 'Service Calls board' },
  { value: 'other', label: 'Other boards' },
]

export const OPS: Record<string, string> = {
  has: 'has',
  has_not: 'does not have',
  nobody: 'nobody',
  gt: 'is more than',
  lt: 'is less than',
  eq: 'is exactly',
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function when(iso: string | null | undefined) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Halifax', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** The automation in words: "When a card is moved to Done, if …, then …". */
export function describeRule(r: Rule, cat: Catalog | null, choices: Choices | null) {
  if (!cat) return ''
  const t = cat.triggers.find((x) => x.key === r.trigger_key)
  const cfg = r.trigger_config as TriggerConfig & { days?: unknown }
  let start = t ? t.label : 'Something happens (not available to you)'
  if (t?.key === 'card_moved' || t?.key === 'service_call_status') start += cfg.stage_name ? `: ${cfg.stage_name}` : ''
  if (t?.key === 'label_added' && cfg.label) start += `: ${cfg.label}`
  if (t?.key === 'order_stage_changed' && cfg.stage) start += ` to ${stageLabel(cfg.stage)}`
  if ((t?.key === 'card_due_soon' || t?.key === 'payment_due') && cfg.days !== undefined && cfg.days !== '') start += ` (${cfg.days} days ahead)`
  if (t?.key === 'schedule') {
    const f = cfg.frequency ?? 'daily'
    const days = (r.trigger_config.days as number[] | undefined) ?? []
    start = `${f === 'weekdays' ? 'Every weekday' : f === 'weekly' ? `Every ${days.map((d) => WEEKDAYS[d - 1]).join(', ') || 'week'}` : 'Every day'} at ${cfg.time ?? '08:00'}`
  }
  const conds = r.conditions.map((c) => conditionText(c, cat, choices)).filter(Boolean)
  const acts = r.actions.map((a) => actionText(a, cat, choices))
  return `When ${lowerFirst(start)}${conds.length ? `, if ${conds.join(r.match === 'any' ? ' or ' : ' and ')}` : ''}, then ${acts.length ? acts.join(', then ') : 'nothing yet'}.`
}

function lowerFirst(s: string) {
  return s.startsWith('A ') || s.startsWith('An ') || s.startsWith('Time ') || s.startsWith('Someone ') || s.startsWith('Every ') || s.startsWith('On ')
    ? s.charAt(0).toLowerCase() + s.slice(1)
    : s
}

function names(values: string[] | undefined, lookup: (v: string) => string) {
  const list = (values ?? []).map(lookup)
  if (list.length === 0) return '(none chosen)'
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`
}

export function conditionText(c: Condition, cat: Catalog, choices: Choices | null) {
  const def = cat.conditions.find((x) => x.key === c.type)
  if (!def) return 'a condition that is not available to you'
  const board = (id: string) => choices?.boards.find((b) => b.id === id)?.name ?? 'a board'
  const dept = (id: string) => choices?.departments.find((d) => d.id === id)?.name ?? 'a department'
  const type = (id: string) => choices?.machine_types.find((m) => m.id === id)?.name ?? 'a machine type'
  const person = (e: string) => (e === 'actor' ? 'the person who made the change' : (choices?.people.find((p) => p.email === e)?.name ?? e))
  switch (c.type) {
    case 'board':
      return `the board is ${names(c.values, board)}`
    case 'board_kind':
      return `the board is one of: ${names(c.values, (v) => BOARD_KINDS.find((k) => k.value === v)?.label ?? v)}`
    case 'stage':
      return `the stage is ${names(c.values, (v) => v)}`
    case 'last_stage':
      return c.value === false ? 'the card is not in the last stage' : 'the card is in the last stage'
    case 'label':
      return `the card ${c.op === 'has_not' ? 'does not have' : 'has'} the label ${names(c.values, (v) => v)}`
    case 'assignee':
      return c.op === 'nobody' ? 'nobody is assigned' : `${names(c.values, person)} ${c.op === 'has_not' ? 'is not' : 'is'} on the card`
    case 'department':
      return `the department is ${names(c.values, dept)}`
    case 'machine_type':
      return `a machine is ${names(c.values, type)}`
    case 'country':
      return `the customer country is ${names(c.values, (v) => v)}`
    case 'order_value':
      return `the order value ${OPS[c.op ?? 'gt']} ${c.value ?? ''}`
    case 'voltage':
      return `the voltage is ${names(c.values, (v) => v)}`
    case 'order_stage':
      return `the order stage is ${names(c.values, (v) => stageLabel(v))}`
    case 'field': {
      const f = Object.values(cat.fields)
        .flat()
        .find((x) => x?.key === c.field)
      const op = OPS[c.op ?? 'equals'] ?? c.op
      return `${(f?.label ?? 'a field').toLowerCase()} ${op}${c.op === 'is_empty' || c.op === 'is_not_empty' ? '' : ` “${c.value ?? ''}”`}`
    }
    default:
      return def.label.toLowerCase()
  }
}

export function actionText(a: Action, cat: Catalog, choices: Choices | null) {
  const def = cat.actions.find((x) => x.key === a.type)
  if (!def) return 'an action that is not available to you'
  const board = (id?: string) => choices?.boards.find((b) => b.id === id)?.name ?? 'a board'
  const person = (e?: string) =>
    e === 'actor' ? 'the person who made the change' : e === 'owner' ? 'me' : e === 'all' ? 'everyone' : (choices?.people.find((p) => p.email === e)?.name ?? e ?? 'someone')
  switch (a.type) {
    case 'move_card':
      return a.stage === 'next' ? 'move the card to the next stage' : `move the card to ${a.stage_name ?? 'a stage'}`
    case 'copy_card':
      return `copy the card to ${board(a.board_id)}`
    case 'add_label':
      return `add the label ${a.label ?? ''}`
    case 'remove_label':
      return `remove the label ${a.label ?? ''}`
    case 'assign':
      return `assign ${person(a.person)}`
    case 'unassign':
      return `remove ${person(a.person)} from the card`
    case 'set_due':
      return a.clear ? 'clear the due date' : `set the due date to ${a.days ?? 0} days from today`
    case 'shift_due':
      return `move the due date by ${a.days ?? 0} days`
    case 'add_checklist':
      return `add the checklist “${a.title ?? ''}”`
    case 'create_card':
      return `create the card “${a.title ?? ''}” on ${board(a.board_id)}`
    case 'change_order_stage':
      return `move the order to ${stageLabel(a.stage) || 'a stage'}`
    case 'notify': {
      const ch = a.channel === 'push' ? 'a phone push notification' : a.channel === 'email' ? 'an email notification' : 'an in-app notification'
      const who = (a.targets ?? []).map((t) => targetText(t, choices)).join(', ') || 'nobody yet'
      return `send ${ch} to ${who}`
    }
    case 'post_notice':
      return `post the notice “${a.title ?? ''}”`
    case 'add_calendar_entry':
      return `add “${a.title ?? ''}” to the Calendar`
    default:
      return def.label.charAt(0).toLowerCase() + def.label.slice(1)
  }
}

export function targetText(t: Target, choices: Choices | null) {
  switch (t.type) {
    case 'user':
      return choices?.people.find((p) => p.email === t.target)?.name ?? t.target ?? 'a person'
    case 'group':
      return `group ${choices?.groups.find((g) => g.id === t.target)?.name ?? ''}`.trim()
    case 'department':
      return `department ${choices?.departments.find((d) => d.id === t.target)?.name ?? ''}`.trim()
    default:
      return TARGET_KINDS.find((k) => k.value === t.type)?.label.toLowerCase() ?? t.type
  }
}

/** Every stage name on the boards the person can open (for "moved to a stage" and card conditions). */
export function stageNames(choices: Choices | null, boardIds?: string[]) {
  const set = new Set<string>()
  for (const b of choices?.boards ?? []) if (!boardIds?.length || boardIds.includes(b.id)) b.stages.forEach((s) => set.add(s.name))
  return [...set].sort((a, b) => a.localeCompare(b))
}

export function labelNames(choices: Choices | null, boardIds?: string[]) {
  const set = new Set<string>()
  for (const b of choices?.boards ?? []) if (!boardIds?.length || boardIds.includes(b.id)) b.labels.forEach((l) => set.add(l.name))
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** The boards a rule is limited to (board automation, or a "Board is" condition). */
export function ruleBoards(r: Rule) {
  if (r.scope === 'board' && r.board_id) return [r.board_id]
  return r.conditions.find((c) => c.type === 'board')?.values ?? []
}
