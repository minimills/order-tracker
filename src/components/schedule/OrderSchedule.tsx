// @permission-scope schedule
import { useState } from 'react'
import { toast } from 'sonner'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import {
  differsFromPromised,
  machinePromised,
  orderPromised,
  planSignature,
  STATUS_DONE,
  STEP_LABEL,
  workingText,
  type Promised,
  type StepKey,
} from '../../lib/schedule'
import { acceptPlan, keepPlan } from '../../lib/scheduleActions'
import { supabase } from '../../lib/supabase'
import { useSchedule } from '../../lib/useSchedule'
import Can from '../Can'
import { Section, secondaryButtonClass, buttonClass } from '../form'
import SerialNumber from '../SerialNumber'
import Timeline from './Timeline'

type Props = {
  order: { id: string; expected_ship_date: string | null; actual_ship_date: string | null }
  machines: { id: string; serial_number: string | null; name: string; needs_crate: boolean }[]
  /** Called after anything here is saved (the page reloads). */
  onChanged: () => void
}

/**
 * The Order page "Schedule" section: how the ship date was worked out, the
 * promised department deadlines (amber = close, red = missed), steps done per
 * machine, and suggested new dates with Accept / Keep. Promised dates never
 * change by themselves.
 */
export default function OrderSchedule({ order, machines, onChanged }: Props) {
  const s = useSchedule(true, order.id)
  const [busy, setBusy] = useState(false)
  if (s.loading) return null

  const plan = s.planById.get(order.id) ?? null
  const promised: Promised = { ship: order.expected_ship_date, deadlines: s.deadlines.filter((d) => d.order_id === order.id) }
  const done = machines.flatMap((m) => s.doneSteps(m.id))
  const items = orderPromised(promised, done, s.today, s.settings, order.actual_ship_date)
  const noDeadlines = promised.deadlines.length === 0
  const suggest =
    plan && (noDeadlines || differsFromPromised(plan, promised)) && s.keptSignature(order.id) !== planSignature(plan) ? plan : null
  const later = suggest && promised.ship && suggest.ship_date > promised.ship

  async function run(fn: () => Promise<boolean | void>) {
    setBusy(true)
    const ok = await fn()
    setBusy(false)
    if (ok !== false) {
      await s.reload()
      onChanged()
    }
  }

  async function toggleStep(machineId: string, step: StepKey, isDone: boolean) {
    if (!supabase) return false
    const { error } = isDone
      ? await supabase.from('machine_steps').delete().eq('machine_id', machineId).eq('step', step)
      : await supabase.from('machine_steps').insert({ machine_id: machineId, step, done_on: s.today })
    if (error) {
      toast.error(friendlyError(error))
      return false
    }
  }

  async function setCrate(machineId: string, value: boolean) {
    if (!supabase) return false
    const { error } = await supabase.from('order_machines').update({ needs_crate: value }).eq('id', machineId)
    if (error) {
      toast.error(friendlyError(error))
      return false
    }
  }

  if (!plan && items.length === 0) return null

  return (
    <Section title="Schedule">
      {plan ? (
        <p className="text-sm text-slate-700">
          {workingText(plan)}. Build starts {showDate(plan.start)}.
          {plan.averages.length > 0 && <span className="text-slate-500"> Uses recent build averages for: {plan.averages.join(', ')}.</span>}
        </p>
      ) : (
        <p className="text-sm text-slate-500">This order is not in the shop queue, so no schedule is calculated. Promised dates:</p>
      )}

      {items.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-slate-500">Promised Deadlines</p>
          <Timeline items={items} />
        </div>
      )}

      {suggest && (
        <div className={`mt-4 rounded-md border p-3 text-sm ${later ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50'}`}>
          {noDeadlines ? (
            <p>
              <strong>No department deadlines are saved for this order yet.</strong> Suggested ship date{' '}
              {showDate(suggest.ship_date)}
              {promised.ship && promised.ship !== suggest.ship_date && <> (promised {showDate(promised.ship)})</>}.
            </p>
          ) : (
            <p>
              <strong>Suggested New Dates</strong> (the queue, machines or progress changed): ship{' '}
              {promised.ship ? showDate(promised.ship) : 'no date'} → <strong>{showDate(suggest.ship_date)}</strong>
              {later && <span className="font-medium text-red-800"> – later than promised</span>}.
            </p>
          )}
          <div className="mt-2">
            <Timeline items={suggest.steps} />
          </div>
          <Can permission="schedule.accept" level="edit">
            <div className="mt-3 flex gap-2">
              <button type="button" className={buttonClass} disabled={busy} onClick={() => run(() => acceptPlan(order.id, suggest, promised))}>
                Accept New Dates
              </button>
              {!noDeadlines && (
                <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => run(() => keepPlan(order.id, suggest))}>
                  Keep Promised Dates
                </button>
              )}
            </div>
          </Can>
        </div>
      )}

      <Can permission="schedule.machines">
        <ul className="mt-4 divide-y divide-slate-100 text-sm">
          {machines.map((m) => {
            const mine = machinePromised(m.id, promised, done, s.today, s.settings)
            const planned = plan?.machines.find((x) => x.machine_id === m.id)
            const steps = mine.length
              ? mine
              : (planned?.steps.map((x) => ({ step: x.step, due: x.due, done: x.finished ? (x.done ?? STATUS_DONE) : null, state: x.finished ? ('done' as const) : ('ok' as const) })) ?? [])
            return (
              <li key={m.id} className="py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{m.name}</span>
                  {m.serial_number && <SerialNumber serial={m.serial_number} />}
                  <Can permission="order.machines.crate_flag" level="edit">
                    <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600" title="Only crated machines get a crating deadline">
                      <input type="checkbox" className="h-4 w-4" checked={m.needs_crate} disabled={busy} onChange={(e) => run(() => setCrate(m.id, e.target.checked))} />
                      Crate
                    </label>
                  </Can>
                </div>
                {steps.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {steps.map((x) => (
                      <Can
                        key={x.step}
                        permission="schedule.step_done"
                        level="edit"
                        fallback={<Timeline items={[x]} />}
                      >
                        <label
                          className="flex cursor-pointer items-center gap-1 text-xs"
                          title={x.done === STATUS_DONE ? `${STEP_LABEL[x.step]} completed (machine marked as built, checked or crated)` : x.done ? `${STEP_LABEL[x.step]} completed ${showDate(x.done)} – clear to mark incomplete` : `Mark complete when ${STEP_LABEL[x.step].toLowerCase()} is finished`}
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={Boolean(x.done)}
                            disabled={busy || x.done === STATUS_DONE}
                            onChange={() => run(() => toggleStep(m.id, x.step as StepKey, Boolean(x.done)))}
                          />
                          <Timeline items={[x]} />
                        </label>
                      </Can>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        <Can permission="schedule.step_done" level="edit">
          <p className="mt-2 text-xs text-slate-500">
            Mark each step complete when it is finished. Recorded times become the build-time averages, and late steps appear on Reports
            → Department delays.
          </p>
        </Can>
      </Can>
    </Section>
  )
}
