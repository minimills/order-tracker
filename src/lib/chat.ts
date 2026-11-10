import { useEffect, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { cleanRichText } from './richText'
import { supabase } from './supabase'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ConversationKind = 'direct' | 'group' | 'department' | 'user_group' | 'channel'
export type NotifyMode = 'all' | 'mentions' | 'mute'
export type ConversationRow = {
  id: string
  kind: ConversationKind
  name: string | null
  other_email: string | null
  archived: boolean
  last_message_at: string | null
  last_author: string | null
  last_text: string | null
  unread: number
  mentions: number
  notify: NotifyMode
  members: number
  can_post: boolean
}
export type Mention = { type: 'user' | 'department' | 'group'; key: string; label: string }
export type ChatLink = { type: 'order' | 'machine' | 'board' | 'card'; id: string; text: string; board_id?: string; order_id?: string }
export type ChatMessage = {
  id: string
  conversation_id: string
  author_email: string | null
  author_name: string | null
  body: string
  body_text: string
  reply_to: string | null
  mentions: Mention[]
  links: ChatLink[]
  edited_at: string | null
  deleted_at: string | null
  pinned_at: string | null
  pinned_by: string | null
  created_at: string
}
export type Reaction = { message_id: string; user_email: string; emoji: string }
export type Member = { conversation_id: string; user_email: string; role: string; notify: NotifyMode; removed: boolean; last_read_at: string }
export type Person = { email: string; name: string }

/** The reactions people can add (a fixed, approved set). */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '🎉', '🙏', '✅'] as const

export const KIND_LABEL: Record<ConversationKind, string> = {
  direct: 'Direct messages',
  group: 'Group chats',
  department: 'Department channels',
  user_group: 'Group channels',
  channel: 'Channels',
}
export const NOTIFY_LABEL: Record<NotifyMode, string> = { all: 'All messages', mentions: 'Mentions only', mute: 'Muted' }

const timeFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', hour: 'numeric', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', month: 'short', day: 'numeric' })
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax' })
/** "3:05 p.m." today, "Nov 9" before. */
export function chatTime(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return dayKey.format(d) === dayKey.format(new Date()) ? timeFmt.format(d) : dayFmt.format(d)
}
export const clockTime = (iso: string) => timeFmt.format(new Date(iso))
export const dayLabel = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', dateStyle: 'full' }).format(new Date(iso))
export const sameDay = (a: string, b: string) => dayKey.format(new Date(a)) === dayKey.format(new Date(b))

// ---------------------------------------------------------------------------
// Unread count for the menu (live, with a 30-second check as a fallback)
// ---------------------------------------------------------------------------
let unreadListeners: ((n: number) => void)[] = []
let unreadValue = 0
export async function refreshChatUnread() {
  if (!supabase) return
  const { data } = await supabase.rpc('chat_unread_total')
  unreadValue = Number(data ?? 0)
  unreadListeners.forEach((l) => l(unreadValue))
}
export function useChatUnread(enabled: boolean) {
  const [n, setN] = useState(unreadValue)
  useEffect(() => {
    if (!enabled || !supabase) return
    unreadListeners.push(setN)
    void refreshChatUnread()
    const timer = window.setInterval(() => void refreshChatUnread(), 30_000)
    const ch = supabase
      .channel('chat-inbox')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, () => void refreshChatUnread())
      .subscribe()
    return () => {
      unreadListeners = unreadListeners.filter((l) => l !== setN)
      window.clearInterval(timer)
      void supabase?.removeChannel(ch)
    }
  }, [enabled])
  return n
}

// ---------------------------------------------------------------------------
// Online / away (Realtime presence; people who hide their status are left out)
// ---------------------------------------------------------------------------
export type Status = 'online' | 'away'
let presenceChannel: RealtimeChannel | null = null
let presenceMap = new Map<string, Status>()
let presenceListeners: ((m: Map<string, Status>) => void)[] = []
let presenceUsers = 0

function publishPresence() {
  if (!presenceChannel) return
  const state = presenceChannel.presenceState<{ email: string; status: Status }>()
  const next = new Map<string, Status>()
  for (const list of Object.values(state)) {
    for (const p of list) if (p.email && next.get(p.email) !== 'online') next.set(p.email, p.status)
  }
  presenceMap = next
  presenceListeners.forEach((l) => l(next))
}

/** Starts sharing my status (unless hidden) and returns everyone's. */
export function usePresence(enabled: boolean, me: string, hidden: boolean) {
  const [map, setMap] = useState(presenceMap)
  useEffect(() => {
    if (!enabled || !supabase || !me) return
    presenceListeners.push(setMap)
    presenceUsers++
    if (!presenceChannel) {
      presenceChannel = supabase.channel('chat-presence', { config: { private: true, presence: { key: me } } })
      presenceChannel.on('presence', { event: 'sync' }, publishPresence).subscribe((status) => {
        if (status === 'SUBSCRIBED' && !hidden) void presenceChannel?.track({ email: me, status: document.hidden ? 'away' : 'online' })
      })
    }
    let idle: number | undefined
    const set = (s: Status) => {
      if (!hidden) void presenceChannel?.track({ email: me, status: s })
    }
    const activity = () => {
      window.clearTimeout(idle)
      set(document.hidden ? 'away' : 'online')
      idle = window.setTimeout(() => set('away'), 5 * 60_000)
    }
    document.addEventListener('visibilitychange', activity)
    window.addEventListener('pointerdown', activity)
    window.addEventListener('keydown', activity)
    if (hidden) void presenceChannel.untrack()
    return () => {
      presenceListeners = presenceListeners.filter((l) => l !== setMap)
      document.removeEventListener('visibilitychange', activity)
      window.removeEventListener('pointerdown', activity)
      window.removeEventListener('keydown', activity)
      window.clearTimeout(idle)
      presenceUsers--
      if (presenceUsers === 0 && presenceChannel) {
        void supabase?.removeChannel(presenceChannel)
        presenceChannel = null
      }
    }
  }, [enabled, me, hidden])
  return map
}

// ---------------------------------------------------------------------------
// Mentions and links inside a message
// ---------------------------------------------------------------------------
export type MentionTarget = Mention & { hint: string }

/** Mentions found in the typed text ("@Bob Shop"), longest names first. */
export function findMentions(text: string, targets: MentionTarget[]): Mention[] {
  const lower = text.toLowerCase()
  return [...targets]
    .sort((a, b) => b.label.length - a.label.length)
    .filter((t) => lower.includes(`@${t.label.toLowerCase()}`))
    .map(({ type, key, label }) => ({ type, key, label }))
}

export function linkHref(l: ChatLink) {
  if (l.type === 'order') return `#/orders/${l.id}`
  if (l.type === 'machine') return l.order_id ? `#/orders/${l.order_id}` : '#/orders'
  if (l.type === 'board') return `#/boards/${l.id}`
  return `#/boards/${l.board_id}?card=${l.id}`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The message as safe HTML: cleaned rich text, with @mentions highlighted and
 * orders / machines / boards / cards turned into links (text nodes only).
 */
export function messageHtml(m: Pick<ChatMessage, 'body' | 'mentions' | 'links'>, me: string, myGroups: Set<string>) {
  const clean = cleanRichText(m.body)
  const parts: { re: string; make: (doc: Document, text: string) => Node }[] = []
  for (const men of m.mentions ?? []) {
    const mine = (men.type === 'user' && men.key === me) || myGroups.has(`${men.type}:${men.key}`)
    parts.push({
      re: escapeRe(`@${men.label}`),
      make: (doc, text) => {
        const s = doc.createElement('span')
        s.className = mine ? 'chat-mention chat-mention-me' : 'chat-mention'
        s.textContent = text
        return s
      },
    })
  }
  for (const l of m.links ?? []) {
    parts.push({
      re: escapeRe(l.text),
      make: (doc, text) => {
        const a = doc.createElement('a')
        a.className = 'chat-link'
        a.setAttribute('href', linkHref(l))
        a.textContent = text
        return a
      },
    })
  }
  if (!parts.length) return clean
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html')
  const re = new RegExp(parts.map((p) => `(${p.re})`).join('|'), 'gi')
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text)
  for (const t of texts) {
    const value = t.nodeValue ?? ''
    re.lastIndex = 0
    if (!re.test(value)) continue
    re.lastIndex = 0
    const frag = doc.createDocumentFragment()
    let last = 0
    for (let match = re.exec(value); match; match = re.exec(value)) {
      const idx = match.slice(1).findIndex((g) => g !== undefined)
      frag.appendChild(doc.createTextNode(value.slice(last, match.index)))
      frag.appendChild(parts[idx].make(doc, match[0]))
      last = match.index + match[0].length
    }
    frag.appendChild(doc.createTextNode(value.slice(last)))
    t.parentNode?.replaceChild(frag, t)
  }
  return (doc.body.firstChild as HTMLElement).innerHTML
}

// ---------------------------------------------------------------------------
// Link previews (read with the viewer's own permissions; cached)
// ---------------------------------------------------------------------------
export type Preview = { title: string; detail: string } | null
const previewCache = new Map<string, Promise<Preview>>()
export function loadPreview(l: ChatLink): Promise<Preview> {
  const key = `${l.type}:${l.id}`
  const hit = previewCache.get(key)
  if (hit) return hit
  const p = (async (): Promise<Preview> => {
    if (!supabase) return null
    if (l.type === 'order') {
      const { data } = await supabase.from('order_summary').select('order_code, customer_name, stage, machines_list').eq('id', l.id).maybeSingle()
      return data
        ? { title: `Order ${data.order_code} · ${data.customer_name ?? ''}`, detail: [data.stage, data.machines_list].filter(Boolean).join(' · ') }
        : null
    }
    if (l.type === 'machine') {
      const { data } = await supabase.from('order_machine_status').select('machine_type, serial_number, order_id').eq('id', l.id).maybeSingle()
      if (!data) return null
      const { data: o } = await supabase.from('order_summary').select('order_code, customer_name, stage').eq('id', data.order_id).maybeSingle()
      return { title: `${data.machine_type} ${data.serial_number ?? ''}`, detail: o ? `Order ${o.order_code} · ${o.customer_name ?? ''} · ${o.stage}` : '' }
    }
    if (l.type === 'board') {
      const { data } = await supabase.from('boards').select('name, description').eq('id', l.id).maybeSingle()
      return data ? { title: `Board: ${data.name}`, detail: data.description ?? '' } : null
    }
    const { data } = await supabase.from('board_cards').select('title, due_date, boards(name), board_stages(name)').eq('id', l.id).maybeSingle()
    if (!data) return null
    const d = data as unknown as { title: string; due_date: string | null; boards: { name: string } | null; board_stages: { name: string } | null }
    return { title: `Card: ${d.title}`, detail: [d.boards?.name, d.board_stages?.name, d.due_date ? `due ${d.due_date}` : ''].filter(Boolean).join(' · ') }
  })()
  previewCache.set(key, p)
  return p
}
