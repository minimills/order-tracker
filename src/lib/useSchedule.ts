import { useCallback, useEffect, useMemo, useState } from 'react'
import { todayISO } from './dates'
import { fetchAll } from './fetchAll'
import {
  computeSchedule,
  finishedByStatus,
  STATUS_DONE,
  DEFAULT_ORDER_DEFAULTS,
  DEFAULT_SCHEDULING,
  type OrderDefaults,
  type OrderPlan,
  type Promised,
  type SchedMachine,
  type SchedOrder,
  type SchedulingSettings,
  type StepKey,
  type StepStat,
  type TypeBuild,
} from './schedule'
import { supabase } from './supabase'

type MachineRow = {
  id: string
  order_id: string
  machine_type_id: string
  needs_crate: boolean | null
  created_at: string
  serial_number: string | null
  ready: boolean
  checklist_done: boolean
  crate_count: number
}
type StepRow = { machine_id: string; order_id: string; step: StepKey; done_on: string; done_by_name: string | null }
type DeadlineRow = { order_id: string; machine_id: string; step: StepKey; due_on: string }
type BoardOrder = { id: string; board_position: number | null; expected_ship_date: string | null; schedule_kept: string | null }

/** Loads one app setting merged over its defaults. */
export async function loadSetting<T extends object>(key: string, fallback: T): Promise<T> {
  if (!supabase) return fallback
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle()
  return { ...fallback, ...((data?.value as Partial<T> | null) ?? {}) }
}

/**
 * Everything the schedule needs, and the live plan for every order in the
 * shop queue (in queue order). `planFor(extra)` adds an order that isn't on
 * the queue yet (the New order form) at the end.
 */
export function useSchedule(enabled = true, alsoOrderId?: string) {
  const [settings, setSettings] = useState<SchedulingSettings>(DEFAULT_SCHEDULING)
  const [defaults, setDefaults] = useState<OrderDefaults>(DEFAULT_ORDER_DEFAULTS)
  const [types, setTypes] = useState<TypeBuild[]>([])
  const [stats, setStats] = useState<StepStat[]>([])
  const [board, setBoard] = useState<BoardOrder[]>([])
  const [machines, setMachines] = useState<MachineRow[]>([])
  const [steps, setSteps] = useState<StepRow[]>([])
  const [deadlines, setDeadlines] = useState<DeadlineRow[]>([])
  const [loading, setLoading] = useState(true)
  const today = todayISO()

  const load = useCallback(async () => {
    if (!supabase || !enabled) return
    const [s, d, t, st, b] = await Promise.all([
      loadSetting('scheduling', DEFAULT_SCHEDULING),
      loadSetting('order_defaults', DEFAULT_ORDER_DEFAULTS),
      supabase.from('machine_types').select('id, name, build_days'),
      supabase.from('machine_type_step_stats').select('*'),
      fetchAll<BoardOrder>(() =>
        supabase!
          .from('orders')
          .select('id, board_position, expected_ship_date, schedule_kept')
          .eq('archived', false)
          .not('board_position', 'is', null)
          .order('board_position'),
      ),
    ])
    const ids = [...new Set([...b.data.map((o) => o.id), ...(alsoOrderId ? [alsoOrderId] : [])])]
    const chunks = <R,>(fn: (part: string[]) => Promise<{ data: R[] }>) =>
      Promise.all(Array.from({ length: Math.ceil(ids.length / 150) }, (_, i) => fn(ids.slice(i * 150, i * 150 + 150)))).then((r) =>
        r.flatMap((x) => x.data),
      )
    const [m, sp, dl] = ids.length
      ? await Promise.all([
          chunks<MachineRow>((part) =>
            fetchAll<MachineRow>(() =>
              supabase!.from('order_machine_status').select('id, order_id, machine_type_id, needs_crate, created_at, serial_number, ready, checklist_done, crate_count').in('order_id', part).order('id'),
            ),
          ),
          chunks<StepRow>((part) => fetchAll<StepRow>(() => supabase!.from('machine_steps').select('*').in('order_id', part).order('machine_id'))),
          chunks<DeadlineRow>((part) => fetchAll<DeadlineRow>(() => supabase!.from('order_deadlines').select('*').in('order_id', part).order('machine_id'))),
        ])
      : [[], [], []]
    setSettings(s)
    setDefaults(d)
    setTypes((t.data as TypeBuild[] | null) ?? [])
    setStats((st.data as StepStat[] | null) ?? [])
    setBoard(b.data)
    setMachines(m)
    setSteps(sp)
    setDeadlines(dl)
    setLoading(false)
  }, [enabled, alsoOrderId])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const schedOrders: SchedOrder[] = useMemo(() => {
    const doneBy = new Map<string, Partial<Record<StepKey, string>>>()
    for (const s of steps) doneBy.set(s.machine_id, { ...(doneBy.get(s.machine_id) ?? {}), [s.step]: s.done_on })
    return board.map((o) => ({
      id: o.id,
      machines: machines
        .filter((m) => m.order_id === o.id)
        .sort((a, b) => (a.serial_number ?? '').localeCompare(b.serial_number ?? '') || a.created_at.localeCompare(b.created_at))
        .map((m): SchedMachine => ({ id: m.id, machine_type_id: m.machine_type_id, needs_crate: m.needs_crate !== false, done: doneBy.get(m.id) ?? {}, finished: finishedByStatus(m) })),
    }))
  }, [board, machines, steps])

  const plans = useMemo(
    () => computeSchedule({ orders: schedOrders, types, stats, settings, today }),
    [schedOrders, types, stats, settings, today],
  )
  const planById = useMemo(() => new Map(plans.map((p) => [p.order_id, p])), [plans])

  /** The plan for an order that is not on the queue yet, added at the end. */
  const planFor = useCallback(
    (extra: SchedOrder): OrderPlan =>
      computeSchedule({ orders: [...schedOrders.filter((o) => o.id !== extra.id), extra], types, stats, settings, today }).at(-1)!,
    [schedOrders, types, stats, settings, today],
  )

  const promised = useCallback(
    (orderId: string): Promised => ({
      ship: board.find((o) => o.id === orderId)?.expected_ship_date ?? null,
      deadlines: deadlines.filter((d) => d.order_id === orderId),
    }),
    [board, deadlines],
  )
  const keptSignature = useCallback((orderId: string) => board.find((o) => o.id === orderId)?.schedule_kept ?? null, [board])
  // Steps ticked done, plus steps the machine's status covers (built / checked / crated).
  const allDone = useMemo(() => {
    const ticked = new Set(steps.map((s) => `${s.machine_id}:${s.step}`))
    const fromStatus = machines.flatMap((m) =>
      finishedByStatus(m)
        .filter((step) => !ticked.has(`${m.id}:${step}`))
        .map((step): StepRow => ({ machine_id: m.id, order_id: m.order_id, step, done_on: STATUS_DONE, done_by_name: null })),
    )
    return [...steps, ...fromStatus]
  }, [steps, machines])
  const doneSteps = useCallback((machineId: string) => allDone.filter((s) => s.machine_id === machineId), [allDone])
  const stepsOf = useCallback((orderId: string) => allDone.filter((s) => s.order_id === orderId), [allDone])

  return { loading, reload: load, today, settings, defaults, types, stats, plans, planById, planFor, promised, keptSignature, doneSteps, stepsOf, deadlines }
}
