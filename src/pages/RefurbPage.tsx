import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import SerialNumber from '../components/SerialNumber'
import PrintButton from '../components/print/PrintButton'
import { buttonClass, inputClass, narrowInputClass, secondaryButtonClass } from '../components/form'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { askText, confirmAction } from '../lib/confirm'
import { showDate, todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { cad, OLD_PART_LABEL } from '../lib/machines'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { useOptionList } from '../lib/useOptionList'
import { ACTION } from '../lib/wording'

type Job = {
  id: string
  machine_id: string
  job_number: number
  status: 'open' | 'completed' | 'cancelled'
  board_id: string | null
  card_id: string | null
  old_serial: string | null
  new_serial: string | null
  condition_before: string | null
  condition_after: string | null
  before_notes: string | null
  after_notes: string | null
  opened_at: string
  opened_by_name: string | null
  completed_at: string | null
  completed_by_name: string | null
  cancelled_at: string | null
  cancel_reason: string | null
}
type Info = {
  job: Job
  machine: { id: string; serial: string | null; machine_type: string; condition: string | null; stock_status: string | null }
  stages: { id: string; name: string; step: string }[]
  current_stage: string | null
  checklist: { total: number; done: number }
  final_check: { status: 'not_started' | 'in_progress' | 'signed'; signed_name: string | null; signed_at: string | null }
  next_serial: string | null
  board_closed: boolean
}
type Note = { id: string; stage_name: string | null; work_date: string; note: string; by_name: string | null }
type Part = { id: string; part: string; quantity: number; unit_cost?: number; cost?: number; old_part: string; stage_name: string | null; notes: string | null; by_name: string | null }
type Cost = { id: string; description: string; supplier: string | null; amount: number; cost_date: string; notes: string | null }
type Summary = {
  buyback: number
  buyback_original: number | null
  buyback_currency: string | null
  parts: number
  outside: number
  freight_in: number
  labour_hours: number
  labour_cost: number | null
  labour_included: boolean
  total: number
  sale: number | null
  profit: number | null
  margin_pct: number | null
}
type Labour = { person: string | null; person_name: string | null; hours: number; cost: number | null; rate_known: boolean }

const card = 'rounded-lg border border-slate-200 bg-white p-4 text-sm'
const th = 'px-2 py-1.5 text-left font-medium'
const td = 'px-2 py-1.5'

/** One refurbishment job: stages, work done, parts, outside costs, conditions, cost summary, complete. */
export default function RefurbPage() {
  const { id } = useParams()
  const { can } = usePermissions()
  const costs = can('refurb.costs')
  const [info, setInfo] = useState<Info | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [parts, setParts] = useState<Part[]>([])
  const [outside, setOutside] = useState<Cost[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [labour, setLabour] = useState<Labour[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const conditions = useOptionList('machine_condition').options
  const [note, setNote] = useState({ stage_id: '', work_date: todayISO(), note: '' })
  const [part, setPart] = useState({ part: '', quantity: '1', unit_cost: '', old_part: 'scrapped', stage_name: '' })
  const [cost, setCost] = useState({ description: '', supplier: '', amount: '', cost_date: todayISO() })
  const [cond, setCond] = useState<{ condition_before: string; condition_after: string; before_notes: string; after_notes: string } | null>(null)

  const load = useCallback(async () => {
    if (!supabase || !id) return
    const { data, error: e } = await supabase.rpc('refurb_job_info', { p_job: id })
    if (e) return setError(friendlyError(e))
    const i = data as Info
    setInfo(i)
    setCond({ condition_before: i.job.condition_before ?? '', condition_after: i.job.condition_after ?? '', before_notes: i.job.before_notes ?? '', after_notes: i.job.after_notes ?? '' })
    const [n, p] = await Promise.all([
      supabase.from('refurb_notes').select('id, stage_name, work_date, note, by_name').eq('job_id', id).eq('archived', false).order('work_date').order('created_at'),
      costs
        ? supabase.from('refurb_parts').select('id, part, quantity, unit_cost, cost, old_part, stage_name, notes, by_name').eq('job_id', id).eq('archived', false).order('created_at')
        : supabase.rpc('refurb_parts_list', { p_job: id }),
    ])
    setNotes((n.data as Note[]) ?? [])
    setParts(((p.data as Part[]) ?? []).map((x) => ({ ...x, quantity: Number(x.quantity), cost: x.cost != null ? Number(x.cost) : undefined })))
    if (costs) {
      const [c, s, l] = await Promise.all([
        supabase.from('refurb_costs').select('id, description, supplier, amount, cost_date, notes').eq('job_id', id).eq('archived', false).order('cost_date'),
        supabase.rpc('refurb_cost_summary', { p_job: id }),
        supabase.rpc('refurb_labour', { p_job: id }),
      ])
      setOutside(((c.data as Cost[]) ?? []).map((x) => ({ ...x, amount: Number(x.amount) })))
      setSummary(s.data as Summary)
      setLabour(((l.data as Labour[]) ?? []).map((x) => ({ ...x, hours: Number(x.hours), cost: x.cost != null ? Number(x.cost) : null })))
    }
  }, [id, costs])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  useBreadcrumbs(info && [{ label: 'Machines', to: '/machines' }, { label: `${info.machine.machine_type} ${info.machine.serial ?? ''}`.trim(), to: `/machines/${info.machine.id}` }, { label: `Refurbishment ${info.job.job_number}` }])

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) {
    setBusy(true)
    const { error: e } = await fn()
    setBusy(false)
    if (e) {
      toast.error(friendlyError(e))
      return false
    }
    if (ok) toast.success(ok)
    await load()
    return true
  }

  if (error)
    return (
      <Can permission="refurb">
        <p className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}</p>
      </Can>
    )
  if (!info || !cond)
    return (
      <Can permission="refurb">
        <p className="text-sm text-slate-500">Loading…</p>
      </Can>
    )
  const j = info.job
  const open = j.status === 'open'

  async function complete() {
    if (!supabase) return
    const { data, error: e } = await supabase.rpc('complete_refurb_job', { p_job: j.id, p: { preview: true } })
    if (e) return toast.error(friendlyError(e))
    const pv = data as { old_serial: string; new_serial: string; problems: string[] }
    if (pv.problems.length) return toast.error(pv.problems.join(' '), { duration: 8000 })
    if (
      !(await confirmAction(
        `Complete this refurbishment? The machine’s serial changes from ${pv.old_serial} to ${pv.new_serial}; the old serial stays searchable and points to the new one. The machine becomes Ready to sell with a refurbished warranty.`,
        { confirmLabel: 'Complete Refurbishment' },
      ))
    )
      return
    await run(() => supabase!.rpc('complete_refurb_job', { p_job: j.id, p: cond }), `Refurbishment completed. The machine is now ${pv.new_serial}.`)
  }
  async function cancel() {
    const reason = await askText('Why is this refurbishment cancelled?', { label: 'Reason', confirmLabel: 'Cancel Refurbishment' })
    if (!reason) return
    await run(() => supabase!.rpc('cancel_refurb_job', { p_job: j.id, p_reason: reason }), 'Refurbishment cancelled.')
  }
  const archive = async (kind: 'note' | 'part' | 'cost', itemId: string) => {
    if (!(await confirmAction('Archive this entry? It is kept in the history but no longer counted.', { confirmLabel: ACTION.archive }))) return
    await run(() => supabase!.rpc('archive_refurb_item', { p_kind: kind, p_id: itemId, p_archived: true }), 'Entry archived.')
  }

  return (
    <Can permission="refurb">
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold">
                Refurbishment {j.job_number}: {info.machine.machine_type}
              </h1>
              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${open ? 'bg-violet-100 text-violet-900' : j.status === 'completed' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-700'}`}>
                {open ? 'In progress' : j.status === 'completed' ? 'Completed' : 'Cancelled'}
              </span>
              <Can permission="machines.print">
                <PrintButton title={`Refurbishment ${j.job_number} ${info.machine.serial ?? ''}`} subtitle={info.machine.machine_type} />
              </Can>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              {info.machine.serial && <SerialNumber serial={info.machine.serial} />}
              <span>
                · started {showDate(j.opened_at.slice(0, 10))} by {j.opened_by_name}
              </span>
              {j.status === 'completed' && (
                <span>
                  · completed {showDate(j.completed_at?.slice(0, 10))}: {j.old_serial} → {j.new_serial}
                </span>
              )}
              {j.status === 'cancelled' && <span>· cancelled: {j.cancel_reason}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2" data-print="hide">
            <Link to={`/machines/${info.machine.id}`} className={secondaryButtonClass}>
              Machine Page
            </Link>
            {j.board_id && (
              <Can permission="boards">
                <Link to={`/boards/${j.board_id}${j.card_id ? `?card=${j.card_id}` : ''}`} className={secondaryButtonClass}>
                  Open the Board
                </Link>
              </Can>
            )}
            <Can permission="checklist">
              <Link to={`/checklists/${info.machine.id}`} className={secondaryButtonClass}>
                Final Check
              </Link>
            </Can>
            {open && (
              <Can permission="refurb.complete" level="edit">
                <button type="button" className={secondaryButtonClass} onClick={cancel} disabled={busy}>
                  Cancel Refurbishment
                </button>
                <button type="button" className={buttonClass} onClick={complete} disabled={busy}>
                  Complete Refurbishment
                </button>
              </Can>
            )}
          </div>
        </div>

        <section className={card} aria-label="Progress" data-print-section="Progress">
          <h2 className="mb-2 font-semibold">Stages</h2>
          <ol className="flex flex-wrap gap-1.5">
            {info.stages.map((s) => (
              <li key={s.id} className={`rounded-full px-2.5 py-0.5 text-xs ${s.name === info.current_stage ? 'bg-violet-600 font-semibold text-white' : 'bg-slate-100 text-slate-700'}`}>
                {s.name}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-slate-600">
            Checklist: {info.checklist.done} of {info.checklist.total} tasks completed · Final check:{' '}
            {info.final_check.status === 'signed'
              ? `signed by ${info.final_check.signed_name} on ${showDate(info.final_check.signed_at?.slice(0, 10))}`
              : info.final_check.status === 'in_progress'
                ? 'in progress'
                : 'not started (start it in the Testing / Final check stage)'}
            {open && info.next_serial && ` · new serial when completed: ${info.next_serial}`}
          </p>
          <p className="mt-1 text-xs text-slate-500">Move the card through the stages on the board; start, pause and finish its tasks there. Labour hours come from those timers.</p>
        </section>

        <section className={card} aria-label="Condition" data-print-section="Condition">
          <h2 className="mb-2 font-semibold">Condition Before and After</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['before', 'after'] as const).map((w) => (
              <div key={w} className="space-y-1">
                <label className="flex items-center gap-2">
                  <span className="w-16">{w === 'before' ? 'Before' : 'After'}</span>
                  <select
                    className={`${narrowInputClass} flex-1`}
                    disabled={!open || !can('refurb', 'edit')}
                    value={cond[`condition_${w}`]}
                    onChange={(e) => setCond({ ...cond, [`condition_${w}`]: e.target.value })}
                  >
                    <option value="">Not recorded</option>
                    {conditions.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <textarea
                  aria-label={`Condition notes ${w}`}
                  rows={3}
                  className={inputClass}
                  maxLength={4000}
                  disabled={!open || !can('refurb', 'edit')}
                  value={cond[`${w}_notes`]}
                  onChange={(e) => setCond({ ...cond, [`${w}_notes`]: e.target.value })}
                />
              </div>
            ))}
          </div>
          {open && (
            <Can permission="refurb" level="edit">
              <button type="button" className={`${secondaryButtonClass} mt-2`} disabled={busy} onClick={() => run(() => supabase!.rpc('set_refurb_conditions', { p_job: j.id, p: cond }), 'Conditions saved.')}>
                {ACTION.save}
              </button>
            </Can>
          )}
          <Can permission="refurb.photos">
            <p className="mt-3 rounded-md border border-dashed border-slate-300 p-2 text-xs text-slate-500">Before and after photos per stage: available in a future update.</p>
          </Can>
        </section>

        <section className={card} aria-label="Work done" data-print-section="Work done">
          <h2 className="mb-2 font-semibold">Work Done</h2>
          {notes.length === 0 ? (
            <p className="text-slate-500">No work recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-500">
                      {showDate(n.work_date)} · {n.stage_name ?? 'General'} · {n.by_name}
                    </div>
                    <div className="whitespace-pre-wrap">{n.note}</div>
                  </div>
                  {open && (
                    <Can permission="refurb" level="edit">
                      <button type="button" className="text-xs underline" onClick={() => archive('note', n.id)}>
                        {ACTION.archive}
                      </button>
                    </Can>
                  )}
                </li>
              ))}
            </ul>
          )}
          {open && (
            <Can permission="refurb" level="edit">
              <div className="mt-3 grid gap-2 sm:grid-cols-[12rem_10rem_1fr_auto]" data-print="hide">
                <select aria-label="Stage" className={narrowInputClass} value={note.stage_id} onChange={(e) => setNote({ ...note, stage_id: e.target.value })}>
                  <option value="">General</option>
                  {info.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <input aria-label="Date" type="date" className={narrowInputClass} value={note.work_date} onChange={(e) => setNote({ ...note, work_date: e.target.value })} />
                <input aria-label="What was done" className={narrowInputClass} placeholder="What was done" value={note.note} onChange={(e) => setNote({ ...note, note: e.target.value })} />
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy || !note.note.trim()}
                  onClick={async () => (await run(() => supabase!.rpc('save_refurb_note', { p: { ...note, job_id: j.id } }), 'Work recorded.')) && setNote({ ...note, note: '' })}
                >
                  Add
                </button>
              </div>
            </Can>
          )}
        </section>

        <section className={card} aria-label="Parts replaced" data-print-section="Parts replaced">
          <h2 className="mb-2 font-semibold">Parts Replaced</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem]">
              <thead className="text-xs text-slate-600">
                <tr>
                  <th className={th}>Part</th>
                  <th className={`${th} text-right`}>Quantity</th>
                  <Can permission="refurb.costs">
                    <th className={`${th} text-right`}>Unit cost</th>
                    <th className={`${th} text-right`}>Cost</th>
                  </Can>
                  <th className={th}>Old part</th>
                  <th className={th}>Stage</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {parts.length === 0 && (
                  <tr>
                    <td className={`${td} text-slate-500`} colSpan={7}>
                      No parts recorded yet.
                    </td>
                  </tr>
                )}
                {parts.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className={td}>{p.part}</td>
                    <td className={`${td} text-right tabular-nums`}>{p.quantity}</td>
                    <Can permission="refurb.costs">
                      <td className={`${td} text-right tabular-nums`}>{cad(p.unit_cost)}</td>
                      <td className={`${td} text-right tabular-nums`}>{cad(p.cost)}</td>
                    </Can>
                    <td className={td}>{OLD_PART_LABEL[p.old_part] ?? p.old_part}</td>
                    <td className={td}>{p.stage_name ?? '—'}</td>
                    <td className={`${td} text-right`}>
                      {open && (
                        <Can permission="refurb" level="edit">
                          <button type="button" className="text-xs underline" onClick={() => archive('part', p.id)}>
                            {ACTION.archive}
                          </button>
                        </Can>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && (
            <Can permission="refurb" level="edit">
              <div className="mt-3 flex flex-wrap items-end gap-2" data-print="hide">
                <input aria-label="Part" className={`${narrowInputClass} w-56`} placeholder="Part" value={part.part} onChange={(e) => setPart({ ...part, part: e.target.value })} />
                <input aria-label="Quantity" inputMode="decimal" className={`${narrowInputClass} w-20`} value={part.quantity} onChange={(e) => setPart({ ...part, quantity: e.target.value })} />
                <Can permission="refurb.costs">
                  <input aria-label="Unit cost (CAD)" inputMode="decimal" placeholder="Unit cost" className={`${narrowInputClass} w-28`} value={part.unit_cost} onChange={(e) => setPart({ ...part, unit_cost: e.target.value })} />
                </Can>
                <select aria-label="Old part" className={narrowInputClass} value={part.old_part} onChange={(e) => setPart({ ...part, old_part: e.target.value })}>
                  {Object.entries(OLD_PART_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <select aria-label="Stage" className={narrowInputClass} value={part.stage_name} onChange={(e) => setPart({ ...part, stage_name: e.target.value })}>
                  <option value="">Stage</option>
                  {info.stages.map((s) => (
                    <option key={s.id}>{s.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy || !part.part.trim()}
                  onClick={async () =>
                    (await run(() => supabase!.rpc('save_refurb_part', { p: { ...part, job_id: j.id } }), 'Part recorded.')) && setPart({ part: '', quantity: '1', unit_cost: '', old_part: 'scrapped', stage_name: part.stage_name })
                  }
                >
                  Add Part
                </button>
              </div>
            </Can>
          )}
        </section>

        <Can permission="refurb.costs">
          <section className={card} aria-label="Outside costs" data-print-section="Outside costs">
            <h2 className="mb-2 font-semibold">Outside Costs</h2>
            {outside.length === 0 ? (
              <p className="text-slate-500">No outside costs recorded.</p>
            ) : (
              <ul className="space-y-1">
                {outside.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {showDate(c.cost_date)} · {c.description}
                      {c.supplier ? ` (${c.supplier})` : ''}
                    </span>
                    <span className="flex items-center gap-3 tabular-nums">
                      {cad(c.amount)}
                      {open && (
                        <Can permission="refurb" level="edit">
                          <button type="button" className="text-xs underline" onClick={() => archive('cost', c.id)}>
                            {ACTION.archive}
                          </button>
                        </Can>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {open && (
              <Can permission="refurb" level="edit">
                <div className="mt-3 flex flex-wrap items-end gap-2" data-print="hide">
                  <input aria-label="Description" className={`${narrowInputClass} w-56`} placeholder="For example: powder coating" value={cost.description} onChange={(e) => setCost({ ...cost, description: e.target.value })} />
                  <input aria-label="Supplier" className={`${narrowInputClass} w-40`} placeholder="Supplier" value={cost.supplier} onChange={(e) => setCost({ ...cost, supplier: e.target.value })} />
                  <input aria-label="Amount (CAD)" inputMode="decimal" className={`${narrowInputClass} w-28`} placeholder="Amount" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} />
                  <input aria-label="Date" type="date" className={narrowInputClass} value={cost.cost_date} onChange={(e) => setCost({ ...cost, cost_date: e.target.value })} />
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || !cost.description.trim() || !cost.amount}
                    onClick={async () => (await run(() => supabase!.rpc('save_refurb_cost', { p: { ...cost, job_id: j.id } }), 'Cost recorded.')) && setCost({ description: '', supplier: '', amount: '', cost_date: todayISO() })}
                  >
                    Add Cost
                  </button>
                </div>
              </Can>
            )}
          </section>

          {summary && (
            <section className={card} aria-label="Cost summary" data-print-section="Cost summary">
              <h2 className="mb-2 font-semibold">Cost Summary (CAD)</h2>
              <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1">
                <dt>Buy-back price{summary.buyback_currency === 'USD' ? ` (${summary.buyback_original} USD)` : ''}</dt>
                <dd className="text-right tabular-nums">{cad(summary.buyback)}</dd>
                <dt>Parts</dt>
                <dd className="text-right tabular-nums">{cad(summary.parts)}</dd>
                <dt>Labour ({summary.labour_hours} hours)</dt>
                <dd className="text-right tabular-nums">{summary.labour_included ? cad(summary.labour_cost) : 'Needs pay rates permission'}</dd>
                <dt>Outside costs</dt>
                <dd className="text-right tabular-nums">{cad(summary.outside)}</dd>
                <dt>Freight in</dt>
                <dd className="text-right tabular-nums">{cad(summary.freight_in)}</dd>
                <dt className="border-t border-slate-200 pt-1 font-semibold">Total cost</dt>
                <dd className="border-t border-slate-200 pt-1 text-right font-semibold tabular-nums">{cad(summary.total)}</dd>
                <dt>Sale price</dt>
                <dd className="text-right tabular-nums">{summary.sale != null ? cad(summary.sale) : 'Not set (Machine page → Stock Details)'}</dd>
                {summary.profit != null && (
                  <>
                    <dt className="font-semibold">{summary.profit >= 0 ? 'Profit' : 'Loss'}</dt>
                    <dd className={`text-right font-semibold tabular-nums ${summary.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {cad(summary.profit)} ({summary.margin_pct}% margin)
                    </dd>
                  </>
                )}
              </dl>
              {labour.length > 0 && (
                <p className="mt-2 text-xs text-slate-600">
                  Labour from the board timers:{' '}
                  {labour.map((l) => `${l.person_name ?? l.person ?? 'Unknown'} ${l.hours} h${l.cost != null ? ` (${cad(l.cost)})` : ''}${!l.rate_known ? ', no pay rate' : ''}`).join('; ')}
                </p>
              )}
            </section>
          )}
        </Can>
      </div>
    </Can>
  )
}
