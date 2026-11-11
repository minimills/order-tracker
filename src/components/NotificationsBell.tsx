// @permission-scope notifications.bell
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { activityTime } from '../lib/activity'
import { useAuth } from '../lib/auth'
import { notificationPermission, readStorage, writeStorage } from '../lib/browserNotifications'
import { usePreferences } from '../lib/preferences'
import { supabase } from '../lib/supabase'
import Icon from './Icon'

type Note = {
  id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  created_at: string
  read_at: string | null
  desktop?: boolean
}

// Notifications already shown on this computer (so each is shown once).
const SHOWN_KEY = 'bmm.desktop-shown'
const shownIds = new Set<string>((readStorage(SHOWN_KEY, true) ?? '').split(',').filter(Boolean))
let firstLoad = true

const DUE_CHECK_MS = 10 * 60 * 1000
let lastDueCheck = 0

/** Board messages for me (card assigned, moved, comments, due soon / overdue). */
export default function NotificationsBell() {
  const navigate = useNavigate()
  const location = useLocation()
  const { session } = useAuth()
  const { desktopNotifications } = usePreferences()
  const [notes, setNotes] = useState<Note[]>([])
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    // Due soon / overdue messages are made on request (once every 10 minutes is plenty).
    if (Date.now() - lastDueCheck > DUE_CHECK_MS) {
      lastDueCheck = Date.now()
      await supabase.rpc('board_due_notifications')
    }
    const { data } = await supabase.from('notifications').select('*').eq('in_app', true).order('created_at', { ascending: false }).limit(50)
    const list = (data as Note[]) ?? []
    setNotes(list)
    // Desktop notifications for new unread ones (not the ones already there when the app opened).
    const fresh = list.filter((n) => !n.read_at && n.desktop && !shownIds.has(n.id) && Date.now() - Date.parse(n.created_at) < 15 * 60_000)
    list.forEach((n) => shownIds.add(n.id))
    writeStorage(SHOWN_KEY, [...shownIds].slice(-300).join(','), true)
    if (firstLoad) {
      firstLoad = false
      return
    }
    if (!fresh.length || !desktopNotifications || notificationPermission() !== 'granted' || document.visibilityState === 'visible' && document.hasFocus()) return
    const email = session?.user.email?.toLowerCase()
    if (email) {
      const { data: quiet } = await supabase.rpc('in_quiet_hours', { p_email: email })
      if (quiet) return
    }
    for (const n of fresh.slice(0, 3)) {
      try {
        const d = new Notification(n.title, { body: n.body ?? undefined, tag: n.id })
        d.onclick = () => {
          window.focus()
          if (n.link) navigate(n.link)
          d.close()
        }
      } catch {
        // Some phones only allow notifications from the installed app's service worker.
      }
    }
  }, [desktopNotifications, session, navigate])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
    const t = setInterval(load, 60 * 1000)
    window.addEventListener('focus', load)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [load, location.pathname])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const unread = notes.filter((n) => !n.read_at)
  async function markRead(ids: string[] | null) {
    if (!supabase) return
    await supabase.rpc('mark_notifications_read', { p_ids: ids })
    setNotes((all) => all.map((n) => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)))
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm leading-none hover:bg-slate-50"
        aria-label={`Notifications: ${unread.length} new`}
        aria-expanded={open}
      >
        <Icon name="inbox" />
        <span className="hidden sm:inline">Notifications</span>
        {unread.length > 0 && (
          <span className="absolute -top-2 -right-2 min-w-5 rounded-full bg-blue-600 px-1.5 py-0.5 text-center text-xs font-bold text-white">
            {unread.length > 99 ? '99+' : unread.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <span className="font-semibold">Notifications</span>
            <span className="flex items-center gap-3">
              {unread.length > 0 && <span className="text-xs text-slate-500">{unread.length} unread</span>}
              <button type="button" className="text-xs font-medium text-blue-700 underline disabled:text-slate-400 disabled:no-underline" disabled={unread.length === 0} onClick={() => markRead(null)}>
                Mark All as Read
              </button>
            </span>
          </div>
          <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
            {notes.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">You have no notifications.</li>}
            {notes.map((n) => (
              <li key={n.id} className={`flex items-start gap-2 px-3 py-2.5 ${n.read_at ? '' : 'bg-blue-50/60'}`}>
                {/* Round check: mark this one as read */}
                <button
                  type="button"
                  disabled={!!n.read_at}
                  onClick={() => markRead([n.id])}
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                    n.read_at ? 'border-slate-300 bg-slate-100 text-slate-400' : 'border-blue-500 text-transparent hover:bg-blue-600 hover:text-white'
                  }`}
                  aria-label={n.read_at ? 'Read' : `Mark as read: ${n.title}`}
                  title={n.read_at ? 'Read' : 'Mark as read'}
                >
                  <Icon name="check" className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    markRead([n.id])
                    setOpen(false)
                    if (n.link) navigate(n.link)
                  }}
                >
                  <div className={`text-sm ${n.read_at ? 'text-slate-500' : 'font-semibold text-slate-900'}`}>
                    {n.kind === 'board_overdue' && <Icon name="alert" className="mr-1 h-3.5 w-3.5 text-red-700" label="Overdue" />}
                    {n.title}
                  </div>
                  {n.body && <div className={`line-clamp-2 text-xs ${n.read_at ? 'text-slate-400' : 'text-slate-600'}`}>{n.body}</div>}
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                    {!n.read_at && <span className="h-1.5 w-1.5 rounded-full bg-blue-600" aria-label="Unread" />}
                    {activityTime.format(new Date(n.created_at))}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
