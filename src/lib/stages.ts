import { useEffect, useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import { STAGES, type Stage } from './types'

/**
 * Stage names shown on screen. The database always stores the fixed values in
 * STAGES ("Ready"); an admin can rename what people see in Admin → Stage names
 * (app_settings key 'stage_labels', for example {"Ready": "Ready / testing"}).
 */
export type StageLabels = Record<Stage, string>

export const DEFAULT_STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s, s])) as StageLabels

/** What each stage means (shown in Admin → Stage names). */
export const STAGE_HINTS: Record<Stage, string> = {
  Quote: 'Not ordered yet. Not on the shop board, no serial numbers.',
  Confirmed: 'Ordered. On the shop board, waiting to be built.',
  'In production': 'Being built.',
  Ready: 'Machines are built and being tested.',
  'Ready to ship': 'Tested and waiting to be crated / picked up.',
  Shipped: 'The shipment has left. Leaves the shop board.',
  Cancelled: 'Will not be built. Leaves the shop board.',
}

let labels: StageLabels = DEFAULT_STAGE_LABELS
let loading = false
const listeners = new Set<() => void>()

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

function set(next: Partial<StageLabels> | null) {
  labels = { ...DEFAULT_STAGE_LABELS }
  for (const s of STAGES) {
    const v = next?.[s]?.trim()
    if (v) labels[s] = v
  }
  listeners.forEach((l) => l())
}

/** Loads the names once (called by useStageLabels). */
export async function loadStageLabels() {
  if (!supabase || loading) return
  loading = true
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'stage_labels').maybeSingle()
  set((data?.value as Partial<StageLabels> | null) ?? null)
}

/** Saves new names (admins / "admin.stages"). */
export async function saveStageLabels(next: Partial<StageLabels>) {
  if (!supabase) return { message: 'Not connected' }
  const clean = Object.fromEntries(
    STAGES.filter((s) => next[s]?.trim() && next[s]!.trim() !== s).map((s) => [s, next[s]!.trim()]),
  )
  const { error } = await supabase.from('app_settings').upsert({ key: 'stage_labels', value: clean })
  if (!error) set(clean)
  return error
}

/** The name shown for a stage ("Ready / testing"). Works outside React too. */
export function stageLabel(stage: string | null | undefined) {
  if (!stage) return ''
  return labels[stage as Stage] ?? stage
}

/** Re-renders when the names change. Returns stageLabel. */
export function useStageLabels() {
  useSyncExternalStore(subscribe, () => labels)
  useEffect(() => {
    loadStageLabels()
  }, [])
  return stageLabel
}
