// @permission-scope notifications.bell
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { activityTime } from '../lib/activity'
import { supabase } from '../lib/supabase'

type Note = { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }

const DUE_CHECK_MS = 10 * 60 * 1000
let lastDueCheck = 0

/** Board messages for me (card assigned, moved, comments, due soon / overdue). */
export default function NotificationsBell() {
  const navigate = useNavigate()
  const location = useLocation()
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
    const { data } = await supabase.from('notifications').select('id, kind, title, body, link, created_at, read_at').order('created_at', { ascending: false }).limit(50)
    setNotes((data as Note[]) ?? [])
  }, [])

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
        className="relative rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-lg leading-none hover:bg-slate-50"
        aria-label={`Notifications: ${unread.length} new`}
        aria-expanded={open}
      >
        <span aria-hidden="true">📬</span>
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
            {unread.length > 0 && (
              <button type="button" className="text-xs text-slate-600 underline" onClick={() => markRead(null)}>
                Mark all as read
              </button>
            )}
          </div>
          <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
            {notes.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">No notifications yet.</li>}
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`block w-full px-3 py-2.5 text-left hover:bg-slate-50 ${n.read_at ? '' : 'bg-blue-50/60'}`}
                  onClick={() => {
                    markRead([n.id])
                    setOpen(false)
                    if (n.link) navigate(n.link)
                  }}
                >
                  <div className={`text-sm ${n.read_at ? 'text-slate-700' : 'font-medium text-slate-900'}`}>
                    {n.kind === 'board_overdue' && '❗ '}
                    {n.title}
                  </div>
                  {n.body && <div className="text-xs text-slate-600">{n.body}</div>}
                  <div className="mt-0.5 text-[11px] text-slate-400">{activityTime.format(new Date(n.created_at))}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
