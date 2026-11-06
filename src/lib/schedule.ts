/**
 * Scheduling: working days, build times, expected ship dates and department
 * deadlines. Pure functions (no database), so the same rules give the same
 * dates on the New order form, the Order page, the board and the dashboard.
 *
 * Rules (owner's spec):
 * - Orders are built one after another in queue order. An order starts when
 *   the orders ahead of it finish their REMAINING build time (or today).
 * - Machines in one order: one after another (default) or at the same time.
 * - A machine's steps run back to back: Fabrication, Sandblasting, Powder
 *   coating, Assembly, Final check, Crating (crated machines only).
 * - Expected ship date = build end + buffer, in working days, then the weekend
 *   rule. The buffer sits before Shipping and does not hold up the next order.
 * - Weekend rule for every calculated date: Saturday → Friday, Sunday → Monday.
 * - Build time per type and step: the average of the last 5 builds when there
 *   are at least 3, otherwise the default from Admin → Machine types.
 */

export const STEPS = [
  { key: 'fabrication', label: 'Fabrication' },
  { key: 'sandblasting', label: 'Sandblasting' },
  { key: 'powder_coating', label: 'Powder coating' },
  { key: 'assembly', label: 'Assembly' },
  { key: 'final_check', label: 'Final check' },
  { key: 'crating', label: 'Crating' },
] as const
export type StepKey = (typeof STEPS)[number]['key']
export const STEP_LABEL: Record<StepKey | 'shipping', string> = {
  ...(Object.fromEntries(STEPS.map((s) => [s.key, s.label])) as Record<StepKey, string>),
  shipping: 'Shipping',
}

export type SchedulingSettings = {
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  working_days: number[]
  holidays: { date: string; name: string }[]
  buffer_days: number
  machines_in_parallel: boolean
}
export const DEFAULT_SCHEDULING: SchedulingSettings = { working_days: [1, 2, 3, 4, 5], holidays: [], buffer_days: 8, machines_in_parallel: false }

export type OrderDefaults = {
  currency_canada: string
  currency_other: string
  voltage: string
  crate: boolean
  down_payment_days: number
  balance_days_before_ship: number
}
export const DEFAULT_ORDER_DEFAULTS: OrderDefaults = {
  currency_canada: 'CAD',
  currency_other: 'USD',
  voltage: '240V',
  crate: true,
  down_payment_days: 30,
  balance_days_before_ship: 90,
}

// ---------------------------------------------------------------------------
// Dates (YYYY-MM-DD strings, no time zones)
// ---------------------------------------------------------------------------
function toDate(iso: string) {
  return new Date(`${iso}T12:00:00Z`)
}
function toIso(d: Date) {
  return d.toISOString().slice(0, 10)
}
export function addDays(iso: string, n: number) {
  const d = toDate(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return toIso(d)
}
/** 1 = Monday … 7 = Sunday */
export function isoWeekday(iso: string) {
  const w = toDate(iso).getUTCDay()
  return w === 0 ? 7 : w
}
export function daysBetween(a: string, b: string) {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000)
}

/** Saturday moves back to Friday, Sunday forward to Monday. */
export function weekendRule(iso: string) {
  const w = isoWeekday(iso)
  if (w === 6) return addDays(iso, -1)
  if (w === 7) return addDays(iso, 1)
  return iso
}

export class WorkCalendar {
  private days: Set<number>
  private holidays: Set<string>
  constructor(settings: SchedulingSettings) {
    this.days = new Set(settings.working_days.length ? settings.working_days : [1, 2, 3, 4, 5])
    this.holidays = new Set(settings.holidays.map((h) => h.date))
  }
  isWorkDay(iso: string) {
    return this.days.has(isoWeekday(iso)) && !this.holidays.has(iso)
  }
  /** The day itself if it is a working day, else the next one. */
  onOrAfter(iso: string) {
    let d = iso
    for (let i = 0; i < 400 && !this.isWorkDay(d); i++) d = addDays(d, 1)
    return d
  }
  /** The next working day after this day. */
  after(iso: string) {
    return this.onOrAfter(addDays(iso, 1))
  }
  /** Last day of a job of n working days that starts on `start` (a working day). */
  endOf(start: string, n: number) {
    let d = start
    for (let i = 1; i < n; i++) d = this.after(d)
    return d
  }
  /** n working days after this day. */
  addWorkDays(iso: string, n: number) {
    let d = iso
    for (let i = 0; i < n; i++) d = this.after(d)
    return d
  }
  /** Working days from a (exclusive) to b (inclusive). */
  between(a: string, b: string) {
    let n = 0
    for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (this.isWorkDay(d)) n++
    return n
  }
}

// ---------------------------------------------------------------------------
// Build times
// ---------------------------------------------------------------------------
export type TypeBuild = { id: string; name: string; build_days: Partial<Record<StepKey, number>> }
export type StepStat = { machine_type_id: string; step: StepKey; builds: number; avg_days: number }

export type StepTime = { days: number; source: 'average' | 'default'; builds: number }

/** Working days for one type and step: average of the last 5 builds (3 or more), else the default. */
export function stepTime(type: TypeBuild | undefined, step: StepKey, stats: StepStat[]): StepTime {
  const s = stats.find((x) => x.machine_type_id === type?.id && x.step === step)
  if (s && s.builds >= 3) return { days: Math.max(1, Math.round(Number(s.avg_days))), source: 'average', builds: s.builds }
  return { days: Math.max(0, Math.round(Number(type?.build_days?.[step] ?? 0))), source: 'default', builds: s?.builds ?? 0 }
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------
export type SchedMachine = {
  id: string
  machine_type_id: string
  needs_crate: boolean
  /** Steps already marked done (they take no more time). */
  done: Partial<Record<StepKey, string>>
  /**
   * Steps finished without a date ticked: a machine marked built has finished
   * Fabrication → Assembly, a signed final check finishes Final check, a crate
   * finishes Crating. They take no more time.
   */
  finished?: StepKey[]
}

/** The steps a machine's own status already covers. */
export function finishedByStatus(m: { ready?: boolean | null; checklist_done?: boolean | null; crate_count?: number | null }): StepKey[] {
  return [
    ...(m.ready ? (['fabrication', 'sandblasting', 'powder_coating', 'assembly'] as StepKey[]) : []),
    ...(m.checklist_done ? (['final_check'] as StepKey[]) : []),
    ...((m.crate_count ?? 0) > 0 ? (['crating'] as StepKey[]) : []),
  ]
}
export type SchedOrder = { id: string; machines: SchedMachine[] }

export type StepPlan = { step: StepKey; start: string | null; due: string; days: number; done: string | null; finished: boolean; source: StepTime['source'] }
export type MachinePlan = { machine_id: string; steps: StepPlan[]; end: string | null }
export type OrderPlan = {
  order_id: string
  /** Orders ahead of it in the queue. */
  ahead: number
  start: string
  /** Working days of build still to do for this order. */
  build_days: number
  build_end: string
  buffer_days: number
  ship_date: string
  machines: MachinePlan[]
  /** Per step: the latest machine deadline (order-level deadline). */
  steps: { step: StepKey | 'shipping'; due: string }[]
  /** Which build times were averages (for "how was this worked out"). */
  averages: string[]
}

export type ScheduleInput = {
  orders: SchedOrder[]
  types: TypeBuild[]
  stats: StepStat[]
  settings: SchedulingSettings
  today: string
}

/** Lays out every order in queue order. Pass the board orders sorted by place in the queue. */
export function computeSchedule({ orders, types, stats, settings, today }: ScheduleInput): OrderPlan[] {
  const cal = new WorkCalendar(settings)
  const typeById = new Map(types.map((t) => [t.id, t]))
  let cursor = cal.onOrAfter(today) // first free working day of the shop
  const plans: OrderPlan[] = []

  orders.forEach((order, index) => {
    const start = cursor
    const averages = new Set<string>()
    let buildDays = 0
    let orderEnd: string | null = null
    let machineCursor = start
    const machines: MachinePlan[] = order.machines.map((m) => {
      let c = settings.machines_in_parallel ? start : machineCursor
      let end: string | null = null
      const steps: StepPlan[] = []
      for (const { key } of STEPS) {
        if (key === 'crating' && !m.needs_crate) continue
        const t = stepTime(typeById.get(m.machine_type_id), key, stats)
        if (t.source === 'average') averages.add(`${typeById.get(m.machine_type_id)?.name ?? 'Machine'} ${STEP_LABEL[key].toLowerCase()}`)
        const done = m.done[key] ?? null
        const finished = Boolean(done) || Boolean(m.finished?.includes(key))
        if (finished || t.days === 0) {
          // Done (or no time needed): due when the previous step ends.
          steps.push({ step: key, start: null, due: end ?? cal.onOrAfter(addDays(c, -1)), days: 0, done, finished, source: t.source })
          continue
        }
        const stepEnd = cal.endOf(c, t.days)
        steps.push({ step: key, start: c, due: stepEnd, days: t.days, done: null, finished: false, source: t.source })
        buildDays += t.days
        end = stepEnd
        c = cal.after(stepEnd)
      }
      if (!settings.machines_in_parallel && end) machineCursor = cal.after(end)
      if (end && (!orderEnd || end > orderEnd)) orderEnd = end
      return { machine_id: m.id, steps, end }
    })
    const buildEnd = orderEnd ?? cal.onOrAfter(addDays(start, -1))
    if (settings.machines_in_parallel) {
      // Parallel: the order's build time is its longest machine.
      buildDays = orderEnd ? cal.between(addDays(start, -1), orderEnd) : 0
    }
    const ship = weekendRule(cal.addWorkDays(buildEnd < start ? addDays(start, -1) : buildEnd, settings.buffer_days))
    const steps: OrderPlan['steps'] = STEPS.map(({ key }) => {
      const dues = machines.flatMap((mp) => mp.steps.filter((s) => s.step === key).map((s) => s.due))
      return dues.length ? { step: key, due: weekendRule(dues.sort().at(-1)!) } : null
    }).filter((x): x is { step: StepKey; due: string } => x !== null)
    steps.push({ step: 'shipping', due: ship })
    plans.push({
      order_id: order.id,
      ahead: index,
      start,
      build_days: buildDays,
      build_end: buildEnd,
      buffer_days: settings.buffer_days,
      ship_date: ship,
      machines: machines.map((mp) => ({ ...mp, steps: mp.steps.map((s) => ({ ...s, due: weekendRule(s.due) })) })),
      steps,
      averages: [...averages],
    })
    if (orderEnd) cursor = cal.after(orderEnd)
  })
  return plans
}

/** "3 orders ahead, 41 working days to build, 8 days buffer" */
export function workingText(p: OrderPlan) {
  const ahead = p.ahead === 0 ? 'Next in the queue' : `${p.ahead} order${p.ahead === 1 ? '' : 's'} ahead`
  return `${ahead}, ${p.build_days} working day${p.build_days === 1 ? '' : 's'} to build, ${p.buffer_days} day${p.buffer_days === 1 ? '' : 's'} buffer`
}

/** The deadlines to save when accepting a plan (one per machine and step). */
export function deadlinesOf(p: OrderPlan) {
  return p.machines.flatMap((m) => m.steps.map((s) => ({ machine_id: m.machine_id, step: s.step, due_on: s.due })))
}

/** A short fingerprint of a suggestion (to remember "Keep"). */
export function planSignature(p: OrderPlan) {
  return [p.ship_date, ...deadlinesOf(p).map((d) => `${d.machine_id.slice(0, 8)}:${d.step}:${d.due_on}`).sort()].join('|')
}

export type Promised = { ship: string | null; deadlines: { machine_id: string; step: StepKey; due_on: string }[] }

/** Does the live plan differ from what was promised? (ignores steps already done) */
export function differsFromPromised(p: OrderPlan, promised: Promised) {
  if (p.ship_date !== promised.ship) return true
  const map = new Map(promised.deadlines.map((d) => [`${d.machine_id}:${d.step}`, d.due_on]))
  return p.machines.some((m) => m.steps.some((s) => !s.finished && map.get(`${m.machine_id}:${s.step}`) !== s.due))
}

// ---------------------------------------------------------------------------
// Deadline status (colours)
// ---------------------------------------------------------------------------
export type DeadlineState = 'done' | 'missed' | 'close' | 'ok'

/** Missed = past and not done; close = within 3 working days. */
export function deadlineState(due: string, done: string | null, today: string, settings: SchedulingSettings): DeadlineState {
  if (done) return 'done'
  if (due < today) return 'missed'
  const cal = new WorkCalendar(settings)
  return cal.between(today, due) <= 3 ? 'close' : 'ok'
}

export const DEADLINE_TONE: Record<DeadlineState, string> = {
  done: 'bg-green-50 text-green-800 ring-green-200',
  missed: 'bg-red-50 text-red-800 ring-red-300',
  close: 'bg-amber-50 text-amber-900 ring-amber-300',
  ok: 'bg-white text-slate-700 ring-slate-200',
}

// ---------------------------------------------------------------------------
// New order date defaults
// ---------------------------------------------------------------------------
/** Down payment due: N days after today, weekend rule. */
export function downPaymentDue(today: string, d: OrderDefaults) {
  return weekendRule(addDays(today, d.down_payment_days))
}
/** Balance due: N days before the expected ship date, weekend rule. */
export function balanceDue(ship: string, d: OrderDefaults) {
  return weekendRule(addDays(ship, -d.balance_days_before_ship))
}
/** For short orders: halfway between the down payment due date and the ship date. */
export function suggestBalanceDue(downDue: string, ship: string) {
  const mid = addDays(downDue, Math.max(1, Math.floor(daysBetween(downDue, ship) / 2)))
  return weekendRule(mid)
}
/** CAD for Canada, otherwise USD (from the defaults). */
export function currencyFor(country: string | null | undefined, d: OrderDefaults) {
  return /^\s*(canada|ca|can)\s*$/i.test(country ?? '') ? d.currency_canada : d.currency_other
}

// ---------------------------------------------------------------------------
// Promised dates (what was accepted) and how they are doing
// ---------------------------------------------------------------------------
/** `done_on` is a date, or STATUS_DONE when the machine's status covers it (built, checked, crated). */
export type DoneStep = { machine_id: string; step: StepKey; done_on: string }
export const STATUS_DONE = 'status'
export type PromisedItem = { step: StepKey | 'shipping'; due: string; done: string | null; state: DeadlineState }

/**
 * The deadlines to save when accepting a plan. Steps already done keep the
 * deadline that was promised (so "late" is still measured against it).
 */
export function acceptDeadlines(p: OrderPlan, promised: Promised) {
  const old = new Map(promised.deadlines.map((d) => [`${d.machine_id}:${d.step}`, d.due_on]))
  const steps = p.machines.flatMap((m) => m.steps)
  return deadlinesOf(p).flatMap((d, i) => {
    if (!steps[i]?.finished) return [d]
    // Finished steps keep the deadline they had; finished without one get none.
    const was = old.get(`${d.machine_id}:${d.step}`)
    return was ? [{ ...d, due_on: was }] : []
  })
}

/** Per step for one machine: its promised deadline, whether it's done, and the colour. */
export function machinePromised(machineId: string, promised: Promised, done: DoneStep[], today: string, settings: SchedulingSettings): PromisedItem[] {
  return STEPS.flatMap(({ key }) => {
    const d = promised.deadlines.find((x) => x.machine_id === machineId && x.step === key)
    if (!d) return []
    const doneOn = done.find((x) => x.machine_id === machineId && x.step === key)?.done_on ?? null
    return [{ step: key, due: d.due_on, done: doneOn, state: deadlineState(d.due_on, doneOn, today, settings) }]
  })
}

/**
 * Order-level deadlines: per step the earliest machine deadline still to do
 * (or the latest one, done, when every machine has done it); then Shipping = the promised ship date.
 */
export function orderPromised(
  promised: Promised,
  done: DoneStep[],
  today: string,
  settings: SchedulingSettings,
  shippedOn: string | null = null,
): PromisedItem[] {
  const items: PromisedItem[] = []
  for (const { key } of STEPS) {
    const ds = promised.deadlines.filter((x) => x.step === key)
    if (!ds.length) continue
    const dones = ds.map((x) => done.find((s) => s.machine_id === x.machine_id && s.step === key)?.done_on ?? null)
    const open = ds.filter((_, i) => !dones[i]).map((x) => x.due_on).sort()
    if (open.length) {
      // The earliest machine still to do decides the colour (one missed = missed).
      items.push({ step: key, due: open[0], done: null, state: deadlineState(open[0], null, today, settings) })
    } else {
      const due = ds.map((x) => x.due_on).sort().at(-1)!
      const doneOn = (dones as string[]).filter((d) => d !== STATUS_DONE).sort().at(-1) ?? STATUS_DONE
      items.push({ step: key, due, done: doneOn, state: 'done' })
    }
  }
  if (promised.ship) items.push({ step: 'shipping', due: promised.ship, done: shippedOn, state: deadlineState(promised.ship, shippedOn, today, settings) })
  return items
}

/** The next deadline still to meet (missed ones first in line). */
export function nextDeadline(items: PromisedItem[]) {
  return items.find((i) => i.state !== 'done') ?? null
}
