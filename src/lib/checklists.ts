import { supabase } from './supabase'

/** One row of machine_checklist_status. */
export type ChecklistStatusRow = {
  machine_id: string
  order_id: string
  serial_number: string | null
  machine_type: string
  ready: boolean
  checklist_id: string | null
  started_at: string | null
  started_by_name: string | null
  last_worked_at: string | null
  last_worked_by_name: string | null
  signed_at: string | null
  signed_name: string | null
  total_items: number
  done_items: number
  na_items: number
  status: 'not_started' | 'in_progress' | 'signed'
}

export type Checklist = {
  id: string
  machine_id: string
  order_id: string
  started_at: string
  started_by_name: string | null
  general_notes: string | null
  last_worked_at: string | null
  last_worked_by_name: string | null
  signed_name: string | null
  signed_at: string | null
  signed_by: string | null
  signature_path: string | null
}

export type ChecklistItem = {
  id: string
  checklist_id: string
  section: string
  item_text: string
  sort_order: number
  is_one_off: boolean
  added_by_name: string | null
  status: 'open' | 'done' | 'na'
  status_by_name: string | null
  status_at: string | null
  notes: string | null
  notes_by_name: string | null
  notes_at: string | null
}

export type TemplateItem = {
  id: string
  machine_type_id: string | null
  section: string
  item_text: string
  sort_order: number
  archived: boolean
}

export const SIGNATURE_BUCKET = 'checklist-signatures'
/** Signature pictures are kept under this size. */
export const MAX_SIGNATURE_BYTES = 50 * 1024

/** Suggested section headings for new template items. */
export const SUGGESTED_SECTIONS = ['Electrical', 'Mechanical', 'Safety', 'Paint', 'Labels']

const dateTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short' })

/** "Nov 4, 2026, 3:15 p.m." in Halifax time. */
export function showDateTime(iso: string | null | undefined) {
  return iso ? dateTime.format(new Date(iso)) : '—'
}

/** Items grouped by section, sections in the order they first appear. */
export function groupBySection<T extends { section: string; sort_order: number }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order)
  const map = new Map<string, T[]>()
  for (const i of sorted) map.set(i.section, [...(map.get(i.section) ?? []), i])
  return [...map.entries()].map(([section, list]) => ({ section, items: list }))
}

/** "In progress 42/60, last worked on by Sam on Nov 4, 2026 3:15 PM" */
export function checklistStatusText(s: Pick<ChecklistStatusRow, 'status' | 'total_items' | 'done_items' | 'na_items' | 'last_worked_by_name' | 'last_worked_at' | 'signed_name' | 'signed_at' | 'ready'>) {
  if (s.status === 'signed') return `Signed by ${s.signed_name ?? '—'} on ${showDateTime(s.signed_at)}`
  if (s.status === 'in_progress') {
    const done = s.done_items + s.na_items
    return `In progress ${done}/${s.total_items}${
      s.last_worked_by_name ? `, last worked on by ${s.last_worked_by_name} on ${showDateTime(s.last_worked_at)}` : ''
    }`
  }
  return 'Not started'
}

/** Downloads a signature picture and returns a link the page can show (or null). */
export async function signatureUrl(path: string | null) {
  if (!supabase || !path) return null
  const { data } = await supabase.storage.from(SIGNATURE_BUCKET).download(path)
  return data ? URL.createObjectURL(data) : null
}
