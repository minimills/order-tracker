// @permission-scope automations
import { useMemo, useState, type ReactNode } from 'react'
import { inputClass, narrowInputClass } from '../form'
import {
  BOARD_KINDS,
  CHANNELS,
  OPS,
  TARGET_KINDS,
  WEEKDAYS,
  labelNames,
  ruleBoards,
  stageNames,
  targetText,
  type Action,
  type Catalog,
  type Choices,
  type Condition,
  type Rule,
  type Subject,
  type Target,
  type TriggerDef,
} from '../../lib/automations'
import { stageLabel } from '../../lib/stages'
import { tr } from '../../i18n'

type Opt = { value: string; label: string }

/** Choose any number of values from a list (a scrolling list of checkboxes). */
/* @layout-helper */
export function MultiPick({ id, options, value, onChange, disabled }: { id: string; options: Opt[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const [q, setQ] = useState('')
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="min-w-0 flex-1">
      {options.length > 8 && (
        <input aria-label={tr("Search the list")} className={`${inputClass} mb-1 py-1`} placeholder={tr("Search…")} value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
      )}
      <div id={id} className="max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white p-2">
        {shown.length === 0 && <p className="text-xs text-slate-500">{tr("Nothing to choose from.")}</p>}
        {shown.map((o) => (
          <label key={o.value} className="flex items-center gap-2 py-0.5 text-sm">
            <input
              type="checkbox"
              disabled={disabled}
              checked={value.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))}
            />
            <span className="min-w-0 break-words">{o.label}</span>
          </label>
        ))}
      </div>
      {value.length > 0 && <p className="mt-1 text-xs text-slate-500">{value.length} {tr("selected")}</p>}
    </div>
  )
}

/** What the trigger asks for: which stage, which label, how many days, which schedule. */
export function TriggerSettings({ def, rule, choices, onChange, disabled }: { def: TriggerDef; rule: Rule; choices: Choices; onChange: (c: Record<string, unknown>) => void; disabled: boolean }) {
  const cfg = rule.trigger_config
  const set = (k: string, v: unknown) => onChange({ ...cfg, [k]: v === '' ? undefined : v })
  const boards = ruleBoards(rule)
  const conf = def.config ?? []
  if (conf.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap gap-4">
      {conf.includes('to_stage') && (
        <div>
          <label htmlFor="tr-stage" className="mb-1 block text-sm font-medium text-slate-700">
            {def.key === 'service_call_status' ? tr("New status") : tr("To the stage")}
          </label>
          <select id="tr-stage" className={`${narrowInputClass} min-w-48`} value={(cfg.stage_name as string) ?? ''} onChange={(e) => set('stage_name', e.target.value)} disabled={disabled}>
            <option value="">{tr("Any stage")}</option>
            {stageNames(choices, def.key === 'service_call_status' ? choices.boards.filter((b) => b.purpose === 'service').map((b) => b.id) : boards).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
      {conf.includes('label') && (
        <div>
          <label htmlFor="tr-label" className="mb-1 block text-sm font-medium text-slate-700">
            {tr("The label")}
          </label>
          <select id="tr-label" className={`${narrowInputClass} min-w-48`} value={(cfg.label as string) ?? ''} onChange={(e) => set('label', e.target.value)} disabled={disabled}>
            <option value="">{tr("Any label")}</option>
            {labelNames(choices, boards).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
      {conf.includes('days') && (
        <div>
          <label htmlFor="tr-days" className="mb-1 block text-sm font-medium text-slate-700">
            {tr("Days ahead")}
          </label>
          <input
            id="tr-days"
            type="number"
            min={0}
            max={365}
            className={`${narrowInputClass} w-28`}
            placeholder={def.key === 'payment_due' ? '7' : tr("Board setting")}
            value={(cfg.days as string | number | undefined) ?? ''}
            onChange={(e) => set('days', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={disabled}
          />
        </div>
      )}
      {conf.includes('order_stage') && (
        <div>
          <label htmlFor="tr-ostage" className="mb-1 block text-sm font-medium text-slate-700">
            {tr("To the stage")}
          </label>
          <select id="tr-ostage" className={`${narrowInputClass} min-w-48`} value={(cfg.stage as string) ?? ''} onChange={(e) => set('stage', e.target.value)} disabled={disabled}>
            <option value="">{tr("Any stage")}</option>
            {choices.order_stages.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </select>
        </div>
      )}
      {conf.includes('schedule') && (
        <>
          <div>
            <label htmlFor="tr-freq" className="mb-1 block text-sm font-medium text-slate-700">
              {tr("How often")}
            </label>
            <select id="tr-freq" className={`${narrowInputClass} w-48`} value={(cfg.frequency as string) ?? 'daily'} onChange={(e) => set('frequency', e.target.value)} disabled={disabled}>
              <option value="daily">{tr("Every day")}</option>
              <option value="weekdays">{tr("Every weekday (Monday to Friday)")}</option>
              <option value="weekly">{tr("On chosen days of the week")}</option>
            </select>
          </div>
          <div>
            <label htmlFor="tr-time" className="mb-1 block text-sm font-medium text-slate-700">
              {tr("At (Halifax time)")}
            </label>
            <input id="tr-time" type="time" className={`${narrowInputClass} w-32`} value={(cfg.time as string) ?? '08:00'} onChange={(e) => set('time', e.target.value)} disabled={disabled} />
          </div>
          {cfg.frequency === 'weekly' && (
            <fieldset className="w-full">
              <legend className="mb-1 text-sm font-medium text-slate-700">{tr("Days")}</legend>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((d, i) => {
                  const days = (cfg.days as number[] | undefined) ?? []
                  return (
                    <label key={d} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={days.includes(i + 1)}
                        onChange={(e) => set('days', e.target.checked ? [...days, i + 1].sort() : days.filter((x) => x !== i + 1))}
                      />
                      {d}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}
        </>
      )}
    </div>
  )
}

/** One condition (If …). */
export function ConditionRow({
  cond,
  index,
  subject,
  catalog,
  choices,
  rule,
  onChange,
  disabled,
}: {
  cond: Condition
  index: number
  subject: Subject
  catalog: Catalog
  choices: Choices
  rule: Rule
  onChange: (c: Condition) => void
  disabled: boolean
}) {
  const def = catalog.conditions.find((c) => c.key === cond.type)
  const id = `cond-${index}`
  const values = cond.values ?? []
  const setValues = (v: string[]) => onChange({ ...cond, values: v })
  const boards = ruleBoards(rule)
  const fields = catalog.fields[subject] ?? []
  const field = fields.find((f) => f.key === cond.field)
  if (!def) return <p className="text-sm text-red-700">{tr("This condition is not available to you. Remove it.")}</p>
  const opSelect = (ops: string[]) => (
    <select aria-label={tr("How")} className={`${narrowInputClass} w-44`} value={cond.op ?? ops[0]} onChange={(e) => onChange({ ...cond, op: e.target.value })} disabled={disabled}>
      {ops.map((o) => (
        <option key={o} value={o}>
          {OPS[o] ?? o}
        </option>
      ))}
    </select>
  )
  let body: ReactNode = null
  switch (def.input) {
    case 'boards':
      body = <MultiPick id={id} options={choices.boards.map((b) => ({ value: b.id, label: b.name }))} value={values} onChange={setValues} disabled={disabled} />
      break
    case 'board_kinds':
      body = <MultiPick id={id} options={BOARD_KINDS} value={values} onChange={setValues} disabled={disabled} />
      break
    case 'stages':
      body = <MultiPick id={id} options={stageNames(choices, boards).map((s) => ({ value: s, label: s }))} value={values} onChange={setValues} disabled={disabled} />
      break
    case 'yes_no':
      body = (
        <select aria-label={tr("Is it")} className={`${narrowInputClass} w-28`} value={cond.value === false ? 'no' : 'yes'} onChange={(e) => onChange({ ...cond, value: e.target.value === 'yes' })} disabled={disabled}>
          <option value="yes">{tr("Yes")}</option>
          <option value="no">{tr("No")}</option>
        </select>
      )
      break
    case 'labels':
      body = (
        <>
          {opSelect(def.ops ?? ['has'])}
          <MultiPick id={id} options={labelNames(choices, boards).map((s) => ({ value: s, label: s }))} value={values} onChange={setValues} disabled={disabled} />
        </>
      )
      break
    case 'people':
      body = (
        <>
          {opSelect(def.ops ?? ['has'])}
          {cond.op !== 'nobody' && (
            <MultiPick
              id={id}
              options={[{ value: 'actor', get label() {
    return tr("The person who made the change")
  } }, ...choices.people.map((p) => ({ value: p.email, label: p.name }))]}
              value={values}
              onChange={setValues}
              disabled={disabled}
            />
          )}
        </>
      )
      break
    case 'departments':
      body = <MultiPick id={id} options={choices.departments.map((d) => ({ value: d.id, label: d.name }))} value={values} onChange={setValues} disabled={disabled} />
      break
    case 'machine_types':
      body = <MultiPick id={id} options={choices.machine_types.map((m) => ({ value: m.id, label: m.name }))} value={values} onChange={setValues} disabled={disabled} />
      break
    case 'voltages':
      body = <MultiPick id={id} options={choices.voltages.map((v) => ({ value: v, label: v }))} value={values} onChange={setValues} disabled={disabled} />
      break
    case 'order_stages':
      body = <MultiPick id={id} options={choices.order_stages.map((v) => ({ value: v, label: stageLabel(v) }))} value={values} onChange={setValues} disabled={disabled} />
      break
    case 'text_list':
      body = (
        <input
          id={id}
          className={`${inputClass} min-w-0 flex-1`}
          placeholder={tr("For example Canada, United States")}
          defaultValue={values.join(', ')}
          onBlur={(e) => setValues(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
          disabled={disabled}
        />
      )
      break
    case 'number':
      body = (
        <>
          {opSelect(def.ops ?? ['gt'])}
          <input id={id} type="number" className={`${narrowInputClass} w-36`} value={(cond.value as number | string | undefined) ?? ''} onChange={(e) => onChange({ ...cond, value: e.target.value })} disabled={disabled} />
        </>
      )
      break
    case 'field': {
      const ops = (def.ops ?? []).filter((o) => (field?.type === 'text' ? o !== 'gt' && o !== 'lt' : o !== 'contains'))
      body = (
        <>
          <select aria-label={tr("Field")} className={`${narrowInputClass} w-48`} value={cond.field ?? ''} onChange={(e) => onChange({ ...cond, field: e.target.value })} disabled={disabled}>
            <option value="">{tr("Choose a field…")}</option>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          {opSelect(ops.length ? ops : ['equals'])}
          {cond.op !== 'is_empty' && cond.op !== 'is_not_empty' && (
            <input
              aria-label={tr("Value")}
              type={field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text'}
              className={`${narrowInputClass} min-w-36 flex-1`}
              value={(cond.value as string | number | undefined) ?? ''}
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
              disabled={disabled}
            />
          )}
        </>
      )
      break
    }
  }
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 text-sm font-medium text-slate-700">{def.label}</p>
      {!def.subjects.includes(subject) && <p className="mb-1 text-xs text-red-700">{tr("This condition does not apply to the chosen trigger.")}</p>}
      <div className="flex min-w-0 flex-wrap items-start gap-2">{body}</div>
    </div>
  )
}

/** Who a notification goes to. */
export function TargetsEditor({ value, onChange, choices, subject, disabled }: { value: Target[]; onChange: (t: Target[]) => void; choices: Choices; subject: Subject; disabled: boolean }) {
  const [kind, setKind] = useState('user')
  const kinds = TARGET_KINDS.filter(
    (k) =>
      !(['assignees', 'board'].includes(k.value) && subject !== 'card') && !(k.value === 'person' && subject !== 'time_off') && !(k.value === 'technician' && !['order', 'card', 'payment', 'machine'].includes(subject)),
  )
  const list: Opt[] =
    kind === 'user'
      ? choices.people.map((p) => ({ value: p.email, label: p.name }))
      : kind === 'group'
        ? choices.groups.filter((g) => g.can_message).map((g) => ({ value: g.id, label: g.name }))
        : kind === 'department'
          ? choices.departments.filter((d) => d.can_message).map((d) => ({ value: d.id, label: d.name }))
          : []
  const add = (t: Target) => !value.some((x) => x.type === t.type && x.target === t.target) && onChange([...value, t])
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select aria-label={tr("Who")} className={`${narrowInputClass} w-60`} value={kind} onChange={(e) => setKind(e.target.value)} disabled={disabled}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        {['user', 'group', 'department'].includes(kind) ? (
          <select aria-label={tr("Which")} className={`${narrowInputClass} min-w-48 flex-1`} value="" onChange={(e) => e.target.value && add({ type: kind, target: e.target.value })} disabled={disabled}>
            <option value="">{tr("Select…")}</option>
            {list.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50" onClick={() => add({ type: kind })} disabled={disabled}>
            {tr("Add")}
          </button>
        )}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {value.map((t, i) => (
          <li key={`${t.type}:${t.target ?? ''}`} className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-sm">
            {targetText(t, choices)}
            {!disabled && (
              <button type="button" aria-label={tr("Remove {{targetText}}", { targetText: targetText(t, choices) })} className="text-xs text-slate-500 hover:text-red-700" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                ✕
              </button>
            )}
          </li>
        ))}
        {value.length === 0 && <li className="text-sm text-slate-500">{tr("Nobody chosen yet.")}</li>}
      </ul>
      <p className="text-xs text-slate-500">{tr("Only people you are allowed to message are offered. People who cannot see the card or order are left out when it runs.")}</p>
    </div>
  )
}

/** One action (Then …). */
export function ActionRow({
  action,
  index,
  subject,
  catalog,
  choices,
  rule,
  onChange,
  disabled,
}: {
  action: Action
  index: number
  subject: Subject
  catalog: Catalog
  choices: Choices
  rule: Rule
  onChange: (a: Action) => void
  disabled: boolean
}) {
  const def = catalog.actions.find((a) => a.key === action.type)
  const id = `act-${index}`
  const set = (patch: Partial<Action>) => onChange({ ...action, ...patch })
  const boards = ruleBoards(rule)
  const editable = useMemo(() => choices.boards.filter((b) => b.level >= 2), [choices])
  const target = choices.boards.find((b) => b.id === action.board_id)
  if (!def) return <p className="text-sm text-red-700">{tr("This action is not available to you (the owner may have lost access). Remove it.")}</p>
  const field = (label: string, el: ReactNode, key: string, grow = false) => (
    <div className={grow ? 'min-w-0 flex-1 basis-64' : ''} key={key}>
      <label htmlFor={`${id}-${key}`} className="mb-1 block text-xs font-medium text-slate-600">
        {label}
      </label>
      {el}
    </div>
  )
  const boardPicker = field(
    'Board',
    <select id={`${id}-board`} className={`${narrowInputClass} min-w-48`} value={action.board_id ?? ''} onChange={(e) => set({ board_id: e.target.value, stage_id: undefined, stage_name: undefined })} disabled={disabled}>
      <option value="">{tr("Choose a board…")}</option>
      {editable.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>,
    'board',
  )
  const stageOnTarget = field(
    'Stage',
    <select id={`${id}-stage`} className={`${narrowInputClass} min-w-40`} value={action.stage_id ?? ''} onChange={(e) => set({ stage_id: e.target.value, stage_name: target?.stages.find((s) => s.id === e.target.value)?.name })} disabled={disabled || !target}>
      <option value="">{tr("First stage")}</option>
      {(target?.stages ?? []).map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>,
    'stage',
  )
  const text = (label: string, key: 'title' | 'message' | 'body' | 'description' | 'notes', grow = true, area = false) =>
    field(
      label,
      area ? (
        <textarea id={`${id}-${key}`} rows={2} className={inputClass} value={(action[key] as string | undefined) ?? ''} onChange={(e) => set({ [key]: e.target.value })} disabled={disabled} />
      ) : (
        <input id={`${id}-${key}`} className={inputClass} value={(action[key] as string | undefined) ?? ''} onChange={(e) => set({ [key]: e.target.value })} disabled={disabled} />
      ),
      key,
      grow,
    )
  const days = (label: string, key: 'days' | 'due_days' | 'show_days' | 'length', placeholder = '') =>
    field(
      label,
      <input id={`${id}-${key}`} type="number" className={`${narrowInputClass} w-28`} placeholder={placeholder} value={(action[key] as string | number | undefined) ?? ''} onChange={(e) => set({ [key]: e.target.value === '' ? undefined : Number(e.target.value) })} disabled={disabled} />,
      key,
    )

  let body: ReactNode = null
  switch (action.type) {
    case 'move_card':
      body = field(
        'To the stage',
        <select
          id={`${id}-stage`}
          className={`${narrowInputClass} min-w-48`}
          value={action.stage === 'next' ? '__next' : (action.stage_name ?? '')}
          onChange={(e) => (e.target.value === '__next' ? set({ stage: 'next', stage_name: undefined }) : set({ stage: undefined, stage_name: e.target.value }))}
          disabled={disabled}
        >
          <option value="">{tr("Choose a stage…")}</option>
          <option value="__next">{tr("The next stage")}</option>
          {stageNames(choices, boards).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>,
        'stage',
      )
      break
    case 'copy_card':
      body = (
        <>
          {boardPicker}
          {stageOnTarget}
        </>
      )
      break
    case 'add_label':
    case 'remove_label':
      body = (
        <>
          {field(
            'Label',
            <>
              <input id={`${id}-label`} list={`${id}-labels`} className={`${narrowInputClass} w-48`} value={action.label ?? ''} onChange={(e) => set({ label: e.target.value })} disabled={disabled} />
              <datalist id={`${id}-labels`}>
                {labelNames(choices, boards).map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </>,
            'label',
          )}
          {action.type === 'add_label' &&
            field('Colour (if the label is new)', <input id={`${id}-colour`} type="color" className="h-10 w-16 rounded border border-slate-300" value={action.colour ?? '#16a34a'} onChange={(e) => set({ colour: e.target.value })} disabled={disabled} />, 'colour')}
        </>
      )
      break
    case 'assign':
    case 'unassign':
      body = field(
        'Person',
        <select id={`${id}-person`} className={`${narrowInputClass} min-w-48`} value={action.person ?? ''} onChange={(e) => set({ person: e.target.value })} disabled={disabled}>
          <option value="">{tr("Choose a person…")}</option>
          <option value="actor">{tr("The person who made the change")}</option>
          <option value="owner">{tr("Me (the owner)")}</option>
          {action.type === 'unassign' && <option value="all">{tr("Everyone on the card")}</option>}
          {choices.people.map((p) => (
            <option key={p.email} value={p.email}>
              {p.name}
            </option>
          ))}
        </select>,
        'person',
      )
      break
    case 'set_due':
      body = (
        <>
          {field(
            'Due date',
            <select id={`${id}-clear`} className={`${narrowInputClass} w-56`} value={action.clear ? 'clear' : 'days'} onChange={(e) => set({ clear: e.target.value === 'clear' })} disabled={disabled}>
              <option value="days">{tr("A number of days from today")}</option>
              <option value="clear">{tr("No due date (clear it)")}</option>
            </select>,
            'clear',
          )}
          {!action.clear && days('Days from today', 'days', '3')}
        </>
      )
      break
    case 'shift_due':
      body = days('Days (negative = earlier)', 'days', '2')
      break
    case 'add_checklist':
      body = (
        <>
          {text('Checklist title', 'title')}
          {field(
            'Tasks (one per line)',
            <textarea id={`${id}-items`} rows={3} className={inputClass} value={(action.items ?? []).join('\n')} onChange={(e) => set({ items: e.target.value.split('\n') })} disabled={disabled} />,
            'items',
            true,
          )}
        </>
      )
      break
    case 'create_card':
      body = (
        <>
          {boardPicker}
          {stageOnTarget}
          {text('Card title', 'title')}
          {text('Description', 'description', true, true)}
          {days('Due in days (optional)', 'due_days')}
          {subject !== 'none' && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={!!action.link} onChange={(e) => set({ link: e.target.checked })} disabled={disabled} /> {tr("Link the new card to the same order or machine")}
            </label>
          )}
        </>
      )
      break
    case 'change_order_stage':
      body = field(
        'New stage',
        <select id={`${id}-ostage`} className={`${narrowInputClass} min-w-48`} value={action.stage ?? ''} onChange={(e) => set({ stage: e.target.value })} disabled={disabled}>
          <option value="">{tr("Choose a stage…")}</option>
          {choices.order_stages.map((s) => (
            <option key={s} value={s}>
              {stageLabel(s)}
            </option>
          ))}
        </select>,
        'ostage',
      )
      break
    case 'notify':
      body = (
        <>
          {field(
            'Send as',
            <select id={`${id}-channel`} className={`${narrowInputClass} w-60`} value={action.channel ?? 'app'} onChange={(e) => set({ channel: e.target.value as Action['channel'] })} disabled={disabled}>
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>,
            'channel',
          )}
          <div className="w-full">
            <p className="mb-1 text-xs font-medium text-slate-600">{tr("To")}</p>
            <TargetsEditor value={action.targets ?? []} onChange={(t) => set({ targets: t })} choices={choices} subject={subject} disabled={disabled} />
          </div>
          {text('Title', 'title')}
          {text('Message', 'message', true, true)}
          <p className="w-full text-xs text-slate-500">{tr("People still choose in Settings → Notifications whether they get automation messages in the app, on the phone or by email.")}</p>
        </>
      )
      break
    case 'post_notice':
      body = (
        <>
          {text('Notice title', 'title')}
          {text('Notice text', 'body', true, true)}
          {field(
            'Priority',
            <select id={`${id}-priority`} className={`${narrowInputClass} w-36`} value={action.priority ?? 'normal'} onChange={(e) => set({ priority: e.target.value as Action['priority'] })} disabled={disabled}>
              <option value="normal">{tr("Normal")}</option>
              <option value="important">{tr("Important")}</option>
            </select>,
            'priority',
          )}
          {field(
            'For',
            <select id={`${id}-audience`} className={`${narrowInputClass} w-56`} value={action.audience ?? (choices.can_post_everyone ? 'everyone' : 'departments')} onChange={(e) => set({ audience: e.target.value as Action['audience'] })} disabled={disabled}>
              {choices.can_post_everyone && <option value="everyone">{tr("Everyone")}</option>}
              <option value="departments">{tr("Chosen departments")}</option>
            </select>,
            'audience',
          )}
          {days('Show for days (optional)', 'show_days')}
          {(action.audience ?? (choices.can_post_everyone ? 'everyone' : 'departments')) === 'departments' && (
            <div className="w-full">
              <MultiPick
                id={`${id}-depts`}
                options={choices.departments.filter((d) => choices.can_post_everyone || choices.my_departments.includes(d.id)).map((d) => ({ value: d.id, label: d.name }))}
                value={action.departments ?? []}
                onChange={(v) => set({ departments: v, audience: 'departments' })}
                disabled={disabled}
              />
            </div>
          )}
        </>
      )
      break
    case 'add_calendar_entry':
      body = (
        <>
          {field(
            'Whose calendar',
            <select id={`${id}-tech`} className={`${narrowInputClass} min-w-48`} value={action.tech ?? 'owner'} onChange={(e) => set({ tech: e.target.value })} disabled={disabled}>
              <option value="owner">{tr("Mine")}</option>
              {choices.can_calendar_others && subject === 'time_off' && <option value="person">{tr("The person who is off")}</option>}
              {choices.can_calendar_others && <option value="technician">{tr("The order’s technician")}</option>}
              {choices.can_calendar_others &&
                choices.people.map((p) => (
                  <option key={p.email} value={p.email}>
                    {p.name}
                  </option>
                ))}
            </select>,
            'tech',
          )}
          {field(
            'When',
            <select id={`${id}-when`} className={`${narrowInputClass} w-60`} value={action.when ?? 'days'} onChange={(e) => set({ when: e.target.value as Action['when'] })} disabled={disabled}>
              <option value="days">{tr("A number of days from today")}</option>
              {subject !== 'none' && <option value="subject">{tr("The dates of what started it")}</option>}
            </select>,
            'when',
          )}
          {(action.when ?? 'days') === 'days' && days('Days from today', 'days', '0')}
          {(action.when ?? 'days') === 'days' && days('Number of days', 'length', '1')}
          {field(
            'Kind',
            <select id={`${id}-kind`} className={`${narrowInputClass} w-44`} value={action.kind ?? 'other'} onChange={(e) => set({ kind: e.target.value as Action['kind'] })} disabled={disabled}>
              <option value="other">{tr("Appointment")}</option>
              {choices.can_service && <option value="onsite">{tr("On-site day")}</option>}
              {choices.can_service && <option value="travel">{tr("Travel day")}</option>}
              {choices.can_service && <option value="training">{tr("Training")}</option>}
            </select>,
            'kind',
          )}
          {text('Title', 'title')}
          {text('Notes', 'notes')}
        </>
      )
      break
    default:
      body = <p className="text-sm text-slate-500">{tr("Nothing to choose for this action.")}</p>
  }
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 text-sm font-medium text-slate-700">{def.label}</p>
      {!def.subjects.includes(subject) && <p className="mb-1 text-xs text-red-700">{tr("This action cannot be used with the chosen trigger.")}</p>}
      <div className="flex min-w-0 flex-wrap items-end gap-3">{body}</div>
    </div>
  )
}
