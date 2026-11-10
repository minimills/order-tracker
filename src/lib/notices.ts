import { useCallback, useEffect, useState } from 'react'
import { addDaysISO, showDate, todayISO } from './dates'
import { supabase } from './supabase'
import { useDepartments } from './useDepartments'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Priority = 'normal' | 'important' | 'urgent'
export type NoteColour = 'yellow' | 'blue' | 'green' | 'pink' | 'orange' | 'purple' | 'white'
export type Notice = {
  id: string
  title: string
  body: string
  body_text: string
  colour: NoteColour
  category: string | null
  priority: Priority
  audience_everyone: boolean
  show_from: string
  show_until: string | null
  pinned: boolean
  comments_enabled: boolean
  author_email: string | null
  author_name: string | null
  edited_at: string | null
  edited_by: string | null
  archived: boolean
  archived_at: string | null
  created_at: string
}
export type Audience = { notice_id: string; target_type: 'user' | 'group' | 'department'; target: string }
export type NoticeRead = { notice_id: string; read_at: string; acknowledged_at: string | null }
export type NoticeReaction = { notice_id: string; user_email: string; emoji: string }
export type NoticeComment = { id: string; notice_id: string; author_email: string | null; author_name: string | null; body: string; created_at: string }
export type AckRow = { email: string; name: string; read_at: string | null; acknowledged_at: string | null }
export type ChecklistItem = { id: string; text: string; done: boolean }
export type PersonalNote = {
  id: string
  title: string
  body: string
  colour: NoteColour
  checklist: ChecklistItem[]
  pos_x: number
  pos_y: number
  z: number
  remind_at: string | null
  reminded_at: string | null
  updated_at: string
}
export type Holiday = {
  id: string
  name: string
  start_date: string
  end_date: string
  kind: 'statutory' | 'company' | 'closure'
  day_off: boolean
  hidden: boolean
  notes: string | null
  source: 'manual' | 'canada-holidays'
  edited: boolean
}

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------
/** Sticky note colours: the paper and a slightly darker edge. */
export const NOTE_COLOURS: { value: NoteColour; label: string; paper: string; edge: string }[] = [
  { value: 'yellow', label: 'Yellow', paper: '#fdf5b8', edge: '#efe08a' },
  { value: 'blue', label: 'Blue', paper: '#dcebfd', edge: '#b9d4f6' },
  { value: 'green', label: 'Green', paper: '#dcf5e3', edge: '#b5e3c3' },
  { value: 'pink', label: 'Pink', paper: '#fde3ea', edge: '#f5c3d1' },
  { value: 'orange', label: 'Orange', paper: '#fde6cc', edge: '#f4c99b' },
  { value: 'purple', label: 'Purple', paper: '#ebe4fb', edge: '#d3c6f3' },
  { value: 'white', label: 'White card', paper: '#ffffff', edge: '#e2e8f0' },
]
export const colourOf = (c: string) => NOTE_COLOURS.find((x) => x.value === c) ?? NOTE_COLOURS[0]

export const PRIORITY: Record<Priority, { label: string; hint: string; badge: string }> = {
  normal: { label: 'Normal', hint: 'Shows on the board.', badge: 'bg-slate-100 text-slate-700' },
  important: { label: 'Important', hint: 'Board, in-app notification and phone push.', badge: 'bg-amber-100 text-amber-900' },
  urgent: {
    label: 'Urgent',
    hint: 'All of that, plus email, a red banner on every page until acknowledged, and pinned at the top.',
    badge: 'bg-red-600 text-white',
  },
}

/** A small, steady tilt per notice (−1.5° to 1.5°), so the board looks hand-pinned but tidy. */
export function tiltOf(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return `${(((Math.abs(h) % 31) - 15) / 10).toFixed(1)}deg`
}

export const HOLIDAY_KIND: Record<Holiday['kind'], string> = {
  statutory: 'Statutory holiday',
  company: 'Company holiday',
  closure: 'Office closure',
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)

/** "today", "tomorrow", "in 3 days", or "now, until Jan 1" while it is on. */
export function whenText(start: string, end: string, today = todayISO()) {
  if (start <= today && end >= today) return end === today || start === end ? 'today' : `now, until ${showDate(end, 'MMM d')}`
  const n = dayDiff(today, start)
  if (n === 1) return 'tomorrow'
  return `in ${n} days`
}

/** "Dec 24 – Jan 1" or "Nov 11". */
export function rangeText(start: string, end: string) {
  if (start === end) return showDate(start, 'EEE, MMM d')
  return `${showDate(start, 'MMM d')} – ${showDate(end, start.slice(0, 4) === end.slice(0, 4) ? 'MMM d' : 'MMM d, yyyy')}`
}

/** Is the notice showing today (not scheduled for later and not expired)? */
export function isLive(n: Notice, today = todayISO()) {
  return !n.archived && n.show_from <= today && (!n.show_until || n.show_until >= today)
}

/** Board order: Urgent first, then pinned, then newest. */
export function boardOrder(a: Notice, b: Notice) {
  const rank = (n: Notice) => (n.priority === 'urgent' ? 0 : n.pinned ? 1 : 2)
  return rank(a) - rank(b) || b.created_at.localeCompare(a.created_at)
}

const timeFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** "Nov 12, 9:00 a.m." in Halifax time. */
export const showDateTime = (iso: string) => timeFmt.format(new Date(iso))
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', month: 'short', day: 'numeric', year: 'numeric' })
export const showDay = (iso: string) => dayFmt.format(new Date(iso))

/** A date-time input value ("2026-11-12T09:00") from a stored time, in this computer's time. */
export function toLocalInput(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
export type BoardData = {
  notices: Notice[]
  audience: Audience[]
  reads: NoticeRead[]
  reactions: NoticeReaction[]
  comments: NoticeComment[]
}
const NOTICE_COLUMNS =
  'id, title, body, body_text, colour, category, priority, audience_everyone, show_from, show_until, pinned, comments_enabled, author_email, author_name, edited_at, edited_by, archived, archived_at, created_at'

/**
 * The notices the database lets this person see. "board" = not archived and
 * not expired (scheduled ones only come back for their poster and managers);
 * "archive" = expired or archived.
 */
export async function loadNotices(scope: 'board' | 'archive', withComments: boolean): Promise<BoardData> {
  const empty: BoardData = { notices: [], audience: [], reads: [], reactions: [], comments: [] }
  if (!supabase) return empty
  const today = todayISO()
  let q = supabase.from('notices').select(NOTICE_COLUMNS)
  q =
    scope === 'board'
      ? q.eq('archived', false).or(`show_until.is.null,show_until.gte.${today}`).order('created_at', { ascending: false }).limit(300)
      : q.or(`archived.eq.true,show_until.lt.${today}`).order('show_from', { ascending: false }).limit(500)
  const { data, error } = await q
  if (error) throw error
  const notices = (data as Notice[]) ?? []
  if (!notices.length) return empty
  const ids = notices.map((n) => n.id)
  const [a, r, x, c] = await Promise.all([
    supabase.from('notice_audience').select('notice_id, target_type, target').in('notice_id', ids),
    supabase.from('notice_reads').select('notice_id, read_at, acknowledged_at').in('notice_id', ids),
    supabase.from('notice_reactions').select('notice_id, user_email, emoji').in('notice_id', ids),
    withComments
      ? supabase.from('notice_comments').select('id, notice_id, author_email, author_name, body, created_at').in('notice_id', ids).order('created_at')
      : Promise.resolve({ data: [] }),
  ])
  return {
    notices,
    audience: (a.data as Audience[]) ?? [],
    reads: (r.data as NoticeRead[]) ?? [],
    reactions: (x.data as NoticeReaction[]) ?? [],
    comments: (c.data as NoticeComment[]) ?? [],
  }
}

/** People, groups and departments for "Who is it for", plus my own departments. */
export function useAudienceChoices(withPeople: boolean) {
  const { departments } = useDepartments()
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [groups, setGroups] = useState<{ id: string; name: string; archived: boolean }[]>([])
  const [myDepartments, setMyDepartments] = useState<string[]>([])
  useEffect(() => {
    if (!supabase) return
    if (withPeople) supabase.rpc('notice_people_choices').then(({ data }) => setPeople((data as typeof people) ?? []))
    supabase
      .from('user_groups')
      .select('id, name, archived')
      .order('name')
      .then(({ data }) => setGroups((data as typeof groups) ?? []))
    supabase.auth.getSession().then(({ data }) => {
      const email = data.session?.user.email?.toLowerCase()
      if (!email) return
      supabase!
        .from('user_departments')
        .select('department_id')
        .eq('user_email', email)
        .then(({ data: rows }) => setMyDepartments(((rows as { department_id: string }[]) ?? []).map((d) => d.department_id)))
    })
  }, [withPeople])
  const nameOf = (a: Pick<Audience, 'target_type' | 'target'>) => {
    if (a.target_type === 'user') return people.find((p) => p.email === a.target)?.name ?? a.target
    if (a.target_type === 'group') return groups.find((g) => g.id === a.target)?.name ?? 'Removed group'
    return departments.find((d) => d.id === a.target)?.name ?? 'Removed department'
  }
  return {
    people,
    groups: groups.filter((g) => !g.archived),
    departments: departments.filter((d) => !d.archived),
    myDepartments,
    nameOf,
  }
}

// ---------------------------------------------------------------------------
// Menu dot and "New notices" count (checked every minute and when the window gets focus)
// ---------------------------------------------------------------------------
let unreadListeners: ((n: number) => void)[] = []
let unreadValue = 0
export async function refreshNoticeUnread() {
  if (!supabase) return
  const { data } = await supabase.rpc('notice_unread_count')
  unreadValue = Number(data ?? 0)
  unreadListeners.forEach((l) => l(unreadValue))
}
export function useNoticeUnread(enabled: boolean) {
  const [n, setN] = useState(unreadValue)
  useEffect(() => {
    if (!enabled || !supabase) return
    unreadListeners.push(setN)
    void refreshNoticeUnread()
    const timer = window.setInterval(() => void refreshNoticeUnread(), 60_000)
    const onFocus = () => void refreshNoticeUnread()
    window.addEventListener('focus', onFocus)
    return () => {
      unreadListeners = unreadListeners.filter((l) => l !== setN)
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled])
  return n
}

// ---------------------------------------------------------------------------
// Urgent notices I haven't acknowledged (the red banner)
// ---------------------------------------------------------------------------
export type UrgentNotice = { id: string; title: string; author_name: string | null; show_from: string }
let urgentListeners: ((n: UrgentNotice[]) => void)[] = []
let urgentValue: UrgentNotice[] = []
export async function refreshUrgentNotices() {
  if (!supabase) return
  const { data } = await supabase.rpc('my_urgent_notices')
  urgentValue = (data as UrgentNotice[]) ?? []
  urgentListeners.forEach((l) => l(urgentValue))
}
export function useUrgentNotices(enabled: boolean) {
  const [list, setList] = useState(urgentValue)
  useEffect(() => {
    if (!enabled || !supabase) return
    urgentListeners.push(setList)
    void refreshUrgentNotices()
    const timer = window.setInterval(() => void refreshUrgentNotices(), 60_000)
    const onFocus = () => void refreshUrgentNotices()
    window.addEventListener('focus', onFocus)
    return () => {
      urgentListeners = urgentListeners.filter((l) => l !== setList)
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled])
  return list
}

/** Acknowledge a notice, then update the banner and the menu dot. */
export async function acknowledgeNotice(id: string) {
  if (!supabase) return { error: null }
  const { error } = await supabase.rpc('acknowledge_notice', { p_notice: id })
  if (!error) {
    void refreshUrgentNotices()
    void refreshNoticeUnread()
  }
  return { error }
}

// ---------------------------------------------------------------------------
// Upcoming holidays (the next ones within a year, hidden ones left out)
// ---------------------------------------------------------------------------
export function useUpcomingHolidays(enabled: boolean, limit = 8) {
  const [list, setList] = useState<Holiday[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    if (!supabase || !enabled) return
    const today = todayISO()
    const { data } = await supabase
      .from('company_holidays')
      .select('id, name, start_date, end_date, kind, day_off, hidden, notes, source, edited')
      .eq('hidden', false)
      .gte('end_date', today)
      .lte('start_date', addDaysISO(today, 366))
      .order('start_date')
      .limit(limit)
    setList((data as Holiday[]) ?? [])
    setLoading(false)
  }, [enabled, limit])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  return { list, loading }
}

/** The canada-holidays.ca address for one year of statutory holidays. */
export const holidayApiUrl = (province: string, year: number) => `https://canada-holidays.ca/api/v1/provinces/${province}?year=${year}`
