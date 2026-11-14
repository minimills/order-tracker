import { useCallback, useEffect, useState } from 'react'
import { showDate } from './dates'
import { fetchAll } from './fetchAll'
import { supabase } from './supabase'

/** One row of the order_service_info view (orders with their service plan and log totals). */
export type ServiceInfo = {
  order_id: string
  order_code: string
  order_number: number
  split_number: number | null
  stage: string
  archived: boolean
  customer_name: string | null
  customer_company: string | null
  customer_country: string | null
  customer_state_province: string | null
  training_needed: boolean
  training_days: number | null
  travel_days: number | null
  technician_email: string | null
  technician_name: string | null
  service_start: string | null
  service_end: string | null
  first_onsite: string | null
  last_onsite: string | null
  entries: number
  hours: number
  certificate_status: 'draft' | 'signed' | 'superseded' | null
}

export async function loadServiceInfo() {
  if (!supabase) return { data: [] as ServiceInfo[], error: null }
  return fetchAll<ServiceInfo>(() => supabase!.from('order_service_info').select('*').order('order_id'))
}

/** order id → service info, for the Orders board and the Orders list. */
export function useServiceInfo(enabled: boolean) {
  const [map, setMap] = useState<Map<string, ServiceInfo>>(new Map())
  useEffect(() => {
    if (!enabled) return
    loadServiceInfo().then(({ data }) => setMap(new Map(data.map((s) => [s.order_id, s]))))
  }, [enabled])
  return map
}

/** "Nov 16 – Nov 20, 2026", "From Nov 16, 2026", or "" when there are no dates. */
export function serviceDates(start: string | null, end: string | null) {
  if (start && end) return start === end ? showDate(start) : `${showDate(start, 'MMM d')} – ${showDate(end)}`
  if (start) return `From ${showDate(start)}`
  if (end) return `Until ${showDate(end)}`
  return ''
}

export type ServiceState = 'upcoming' | 'in_progress' | 'completed'

/** Which Service list an order belongs to. */
export function serviceState(s: ServiceInfo, today: string): ServiceState {
  if (s.certificate_status === 'signed') return 'completed'
  if (s.service_end && s.service_end < today) return 'completed'
  if ((s.service_start && s.service_start <= today) || s.entries > 0) return 'in_progress'
  return 'upcoming'
}

/** Orders that belong in the Service section. */
export const needsService = (s: ServiceInfo) =>
  !s.archived && s.stage !== 'Cancelled' && (s.training_needed || !!s.technician_email || s.entries > 0)

// ---------------------------------------------------------------------------
// Service log
// ---------------------------------------------------------------------------
export type EntryMachine = { machine_id: string; notes: string }
export type EntryDraft = {
  client_id: string
  /** The order (training) or the service call the day belongs to. */
  order_id: string | null
  service_call_id?: string | null
  entry_date: string
  kind: 'travel' | 'onsite'
  hours: string
  notes: string
  machines: EntryMachine[]
}
export type SavedEntry = {
  id: string
  client_id: string
  order_id: string | null
  service_call_id: string | null
  entry_date: string
  kind: 'travel' | 'onsite'
  hours: number | null
  notes: string | null
  created_by_name: string | null
  updated_by_name: string | null
  created_at: string
  service_entry_machines: { machine_id: string; notes: string | null }[]
}

export const KIND_LABEL = { travel: 'Travel day', onsite: 'On-site day' } as const

export function newClientId() {
  return crypto.randomUUID()
}

/** The payload save_service_entry() expects. */
export function entryPayload(d: EntryDraft) {
  return {
    client_id: d.client_id,
    order_id: d.order_id,
    service_call_id: d.service_call_id ?? null,
    entry_date: d.entry_date,
    kind: d.kind,
    hours: d.hours.trim() === '' ? null : Number(d.hours),
    notes: d.notes,
    machines: d.machines.map((m) => ({ machine_id: m.machine_id, notes: m.notes })),
  }
}

// ---------------------------------------------------------------------------
// Entries waiting to be saved (kept on this phone when there is no signal)
// ---------------------------------------------------------------------------
export type OutboxItem = { draft: EntryDraft; queued_at: string; error: string | null }
const OUTBOX_KEY = 'service-outbox-v1'

function readOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    return raw ? (JSON.parse(raw) as OutboxItem[]) : []
  } catch {
    return []
  }
}
function writeOutbox(items: OutboxItem[]) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items))
  } catch {
    // storage full or blocked: the entry stays on screen until the page closes
  }
  window.dispatchEvent(new Event('service-outbox'))
}

/** True when the problem is the connection (keep the entry and try again later). */
function isConnectionProblem(error: { message?: string } | null) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true
  const m = (error?.message ?? '').toLowerCase()
  return m.includes('failed to fetch') || m.includes('network') || m.includes('load failed') || m.includes('timeout')
}

let flushing = false
/** Sends every waiting entry; keeps those that could not be saved. */
export async function flushOutbox() {
  if (!supabase || flushing) return
  flushing = true
  try {
    for (const item of readOutbox()) {
      const { error } = await supabase.rpc('save_service_entry', { p_entry: entryPayload(item.draft) })
      const now = readOutbox()
      if (!error) {
        writeOutbox(now.filter((x) => x.draft.client_id !== item.draft.client_id))
      } else {
        const message = isConnectionProblem(error) ? null : error.message
        writeOutbox(now.map((x) => (x.draft.client_id === item.draft.client_id ? { ...x, error: message } : x)))
        if (!message) break // still offline: try again later
      }
    }
  } finally {
    flushing = false
  }
}

/** Puts an entry in the outbox (replacing an older copy of it) and tries to send it. */
export async function queueEntry(draft: EntryDraft) {
  const others = readOutbox().filter((x) => x.draft.client_id !== draft.client_id)
  writeOutbox([...others, { draft, queued_at: new Date().toISOString(), error: null }])
  await flushOutbox()
  return !readOutbox().some((x) => x.draft.client_id === draft.client_id)
}

export function discardQueued(clientId: string) {
  writeOutbox(readOutbox().filter((x) => x.draft.client_id !== clientId))
}

/** The waiting entries; retries when the phone is back online and every 30 seconds. */
export function useOutbox(onSaved?: () => void) {
  const [items, setItems] = useState<OutboxItem[]>(readOutbox)
  const refresh = useCallback(() => setItems(readOutbox()), [])
  useEffect(() => {
    let before = readOutbox().length
    const changed = () => {
      const now = readOutbox()
      setItems(now)
      if (now.length < before) onSaved?.()
      before = now.length
    }
    const retry = () => void flushOutbox()
    window.addEventListener('service-outbox', changed)
    window.addEventListener('storage', changed)
    window.addEventListener('online', retry)
    const timer = window.setInterval(retry, 30_000)
    retry()
    return () => {
      window.removeEventListener('service-outbox', changed)
      window.removeEventListener('storage', changed)
      window.removeEventListener('online', retry)
      window.clearInterval(timer)
    }
  }, [onSaved])
  return { items, refresh }
}

// ---------------------------------------------------------------------------
// Commissioning certificates
// ---------------------------------------------------------------------------
export type CertMachine = { key: string; machine_id: string | null; machine: string; serial: string | null; removed: boolean }
export type CompanyInfo = { name?: string; address?: string; phone?: string; email?: string; website?: string; logo?: string | null; office_email?: string }
export type Certificate = {
  id: string
  order_id: string | null
  service_call_id: string | null
  kind: 'commissioning' | 'service_report'
  version: number
  status: 'draft' | 'signed' | 'superseded'
  replaces: string | null
  title: string
  part1: string
  part2: string
  machines: CertMachine[]
  start_date: string | null
  end_date: string | null
  site_address: string | null
  info: { order_number?: string; reference?: string; customer_name?: string | null; customer_company?: string | null; customer_country?: string | null; company?: CompanyInfo }
  tech_email: string | null
  tech_name: string | null
  tech_signature_path: string | null
  tech_sign_date: string | null
  tech_signed_at: string | null
  customer_name: string | null
  customer_title: string | null
  customer_signature_path: string | null
  customer_sign_date: string | null
  customer_signed_at: string | null
  locked_at: string | null
  created_at: string
}

export const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: 'tech_full_name', label: 'Technician’s full name' },
  { key: 'company_name', label: 'Our company name' },
  { key: 'customer_name', label: 'Customer name' },
  { key: 'customer_company', label: 'Customer company' },
  { key: 'order_number', label: 'Order number' },
  { key: 'start_date', label: 'First on-site day' },
  { key: 'end_date', label: 'Last on-site day' },
  { key: 'site_address', label: 'Site address' },
  { key: 'today', label: 'Today’s date (the signing date once signed)' },
]

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Replaces {placeholders} in template HTML with the values (escaped). Unknown ones stay as typed. */
export function fillPlaceholders(html: string, values: Record<string, string>) {
  return html.replace(/\{([a-z_]+)\}/g, (all, key: string) => (key in values ? escapeHtml(values[key]) : all))
}

/** The values for one certificate. */
export function certificateValues(c: Certificate, company: CompanyInfo, today: string): Record<string, string> {
  const blank = '________'
  return {
    tech_full_name: c.tech_name || blank,
    company_name: company.name || 'Belfast Mini Mills',
    customer_name: c.info.customer_name || blank,
    customer_company: c.info.customer_company || c.info.customer_name || blank,
    order_number: c.info.order_number || blank,
    start_date: c.start_date ? showDate(c.start_date) : blank,
    end_date: c.end_date ? showDate(c.end_date) : blank,
    site_address: c.site_address || blank,
    today: showDate(c.locked_at ? (c.customer_sign_date ?? c.tech_sign_date ?? today) : today),
  }
}

/** "Order 76" or "Service call S-12". */
export const documentReference = (c: Pick<Certificate, 'order_id' | 'info'>) =>
  c.order_id ? `Order ${c.info.order_number ?? ''}` : (c.info.reference ?? `Service call ${c.info.order_number ?? ''}`)

export const certificateFileName = (c: Certificate) =>
  `${c.title} - ${documentReference(c)}${c.version > 1 ? ` (version ${c.version})` : ''}.pdf`

// ---------------------------------------------------------------------------
// Service calls (cards on the Service Calls board)
// ---------------------------------------------------------------------------
export type CallMachine = { machine_id: string; machine: string; serial: string | null; order_code: string }
export type ServiceCallInfo = {
  card_id: string
  call_number: number
  call_code: string
  board_id: string
  title: string
  description: string | null
  archived: boolean
  created_at: string
  stage_id: string
  stage_name: string
  stage_order: number
  done: boolean
  customer_id: string | null
  customer_name: string | null
  customer_company: string | null
  customer_country: string | null
  customer_state_province: string | null
  technician_email: string | null
  technician_name: string | null
  planned_start: string | null
  planned_end: string | null
  machines: CallMachine[]
  entries: number
  hours: number
  report_status: 'draft' | 'signed' | 'superseded' | null
}

// ---------------------------------------------------------------------------
// Technician calendar
// ---------------------------------------------------------------------------
export type CalendarKind = 'training' | 'service' | 'travel' | 'onsite' | 'other' | 'event'
export type CalendarRow = {
  source: 'training' | 'service_call' | 'travel_log' | 'manual' | 'phone' | 'event'
  source_id: string
  tech_email: string | null
  tech_name: string | null
  kind: CalendarKind
  start_date: string
  end_date: string
  title: string
  customer: string | null
  country: string | null
  notes: string | null
  link: string | null
  /** Read from the technician's own phone calendar (read-only in the app). */
  from_phone: boolean
  /** Start time of a timed entry (null = all day). */
  start_at: string | null
  location: string | null
  /** End time of a timed entry (may be empty on old phone entries: shown as one hour). */
  end_at: string | null
}
/** Colours (light background, dark text, solid dot) per kind, readable for colour-blind people (also labelled). */
export const CALENDAR_KINDS: Record<CalendarKind, { label: string; chip: string; dot: string }> = {
  training: { label: 'Training visit', chip: 'bg-blue-100 text-blue-900 ring-blue-300', dot: 'bg-blue-600' },
  service: { label: 'Service call', chip: 'bg-violet-100 text-violet-900 ring-violet-300', dot: 'bg-violet-600' },
  travel: { label: 'Travel day', chip: 'bg-amber-100 text-amber-900 ring-amber-300', dot: 'bg-amber-500' },
  onsite: { label: 'Other on-site day', chip: 'bg-emerald-100 text-emerald-900 ring-emerald-300', dot: 'bg-emerald-600' },
  other: { label: 'Other', chip: 'bg-slate-100 text-slate-800 ring-slate-300', dot: 'bg-slate-500' },
  event: { label: 'Company event', chip: 'bg-rose-50 text-rose-900 ring-rose-300', dot: 'bg-rose-500' },
}

/** Types the office can give an entry read from a phone calendar. */
export const PHONE_EVENT_KINDS: { kind: CalendarKind; label: string }[] = [
  { kind: 'travel', label: 'Travel day' },
  { kind: 'onsite', label: 'On site' },
  { kind: 'service', label: 'Service call' },
  { kind: 'training', label: 'Training visit' },
  { kind: 'other', label: 'Other' },
]
const timeFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', hour: 'numeric', minute: '2-digit' })
/** "9:30 a.m." in Halifax time. */
export const showTime = (iso: string) => timeFmt.format(new Date(iso))

/** The private phone-calendar link (the calendar-feed Edge Function). */
export function calendarFeedUrl(token: string) {
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
  return `${base}/functions/v1/calendar-feed?token=${token}`
}

/** A signature picture as a data: URL (for the screen and the PDF). */
export async function signatureDataUrl(path: string | null) {
  if (!supabase || !path) return null
  const { data } = await supabase.storage.from('certificate-signatures').download(path)
  if (!data) return null
  return await new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsDataURL(data)
  })
}
