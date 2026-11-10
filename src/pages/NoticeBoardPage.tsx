import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import Icon from '../components/Icon'
import { buttonClass, narrowInputClass } from '../components/form'
import AckDialog from '../components/notices/AckDialog'
import HolidaysPanel from '../components/notices/HolidaysPanel'
import MyNotes from '../components/notices/MyNotes'
import NoticeCard from '../components/notices/NoticeCard'
import NoticeDialog from '../components/notices/NoticeDialog'
import { useAuth } from '../lib/auth'
import { todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import {
  boardOrder,
  isLive,
  loadNotices,
  PRIORITY,
  refreshNoticeUnread,
  useAudienceChoices,
  type BoardData,
  type Notice,
  type Priority,
} from '../lib/notices'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { useOptionList } from '../lib/useOptionList'

const EMPTY: BoardData = { notices: [], audience: [], reads: [], reactions: [], comments: [] }

/**
 * The Notice Board: a whiteboard of notices (Team Board) and each person's
 * private sticky notes (My Notes). Filters and the open notice are kept in the
 * address, so a link from a notification opens the right notice.
 */
export default function NoticeBoardPage() {
  const { can } = usePermissions()
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'mine' && can('notices.my_notes', 'edit') ? 'mine' : 'team'
  const tab = params.get('tab') === 'archive' && can('notices.archive') ? 'archive' : 'board'
  const highlight = params.get('notice')
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  const [data, setData] = useState<BoardData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [newIds, setNewIds] = useState<Set<string> | null>(null)
  const [editing, setEditing] = useState<Notice | 'new' | null>(null)
  const [acks, setAcks] = useState<Notice | null>(null)
  const choices = useAudienceChoices(can('notices.post.everyone', 'edit'))
  const categories = useOptionList('notice_category')
  const today = todayISO()

  const load = useCallback(async () => {
    try {
      setData(await loadNotices(tab, can('notices.comments')))
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
    setLoading(false)
  }, [tab, can])

  // Scheduled notices and reminders are also sent by the database every minute;
  // opening the board sends any that are due straight away.
  useEffect(() => {
    if (view !== 'team') return
    // oxlint-disable-next-line react/set-state-in-effect
    setLoading(true)
    void (supabase?.rpc('notice_board_tick') ?? Promise.resolve()).then(() => load())
  }, [view, load])

  // "New" = showing for me, not mine, and not seen before this visit.
  useEffect(() => {
    if (tab !== 'board' || loading || newIds) return
    const fresh = data.notices.filter((n) => isLive(n, today) && n.author_email !== me && !data.reads.some((r) => r.notice_id === n.id)).map((n) => n.id)
    // oxlint-disable-next-line react/set-state-in-effect
    setNewIds(new Set(fresh))
    if (!fresh.length) return
    const t = window.setTimeout(() => {
      void supabase?.rpc('mark_notices_read', { p_ids: fresh }).then(() => refreshNoticeUnread())
    }, 2500)
    return () => window.clearTimeout(t)
  }, [tab, loading, data, me, today, newIds])

  // A link to one notice: show it (in the Archive if it is no longer on the board).
  useEffect(() => {
    if (!highlight || loading) return
    if (data.notices.some((n) => n.id === highlight)) {
      window.setTimeout(() => document.getElementById(`notice-${highlight}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100)
    } else if (tab === 'board' && can('notices.archive')) {
      set({ tab: 'archive' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, loading, data])

  // Filters and search.
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const cat = params.get('cat') ?? ''
  const pri = (params.get('pri') ?? '') as Priority | ''
  const mine = params.get('mydept') === '1'
  const audienceOf = useCallback((id: string) => data.audience.filter((a) => a.notice_id === id), [data.audience])
  const shown = useMemo(
    () =>
      data.notices.filter((n) => {
        if (cat && n.category !== cat) return false
        if (pri && n.priority !== pri) return false
        if (mine && !audienceOf(n.id).some((a) => a.target_type === 'department' && choices.myDepartments.includes(a.target))) return false
        if (q && !`${n.title} ${n.body_text} ${n.author_name ?? ''} ${n.category ?? ''}`.toLowerCase().includes(q)) return false
        return true
      }),
    [data.notices, cat, pri, mine, q, audienceOf, choices.myDepartments],
  )
  const live = shown.filter((n) => n.show_from <= today).sort(boardOrder)
  const top = live.filter((n) => n.priority === 'urgent' || n.pinned)
  const rest = live.filter((n) => !(n.priority === 'urgent' || n.pinned))
  const scheduled = shown.filter((n) => n.show_from > today).sort((a, b) => a.show_from.localeCompare(b.show_from))
  const newCount = newIds?.size ?? 0
  const filtering = !!(q || cat || pri || mine)

  const audienceText = (n: Notice) => (n.audience_everyone ? 'Everyone' : audienceOf(n.id).map(choices.nameOf).join(', ') || 'Chosen people')
  // Drawn inside the page's <Can permission="notices"> below.
  /* @rendered-inside-can */ const card = (n: Notice, layout: 'board' | 'list') => (
    <NoticeCard
      key={n.id}
      notice={n}
      me={me}
      layout={layout}
      audienceText={audienceText(n)}
      read={data.reads.find((r) => r.notice_id === n.id)}
      reactions={data.reactions.filter((r) => r.notice_id === n.id)}
      comments={data.comments.filter((c) => c.notice_id === n.id)}
      isNew={!!newIds?.has(n.id)}
      canManage={n.author_email === me || can('notices.manage', 'edit')}
      highlight={n.id === highlight}
      onEdit={() => setEditing(n)}
      onAcks={() => setAcks(n)}
      onChanged={load}
    />
  )
  const grid = 'grid grid-cols-1 items-start gap-6 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] md:gap-8'

  return (
    <Can permission="notices">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Notice Board</h1>
            <p className="mt-1 text-sm text-slate-600">
              {view === 'mine' ? 'Your own notes. Nobody else can see them.' : 'Notices for the team. Urgent and pinned notices stay at the top.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {view === 'team' && newCount > 0 && (
              <span className="rounded-full bg-blue-600 px-3 py-1 text-sm font-medium text-white">
                {newCount} new {newCount === 1 ? 'notice' : 'notices'}
              </span>
            )}
            <Can permission="notices.my_notes" level="edit">
              <div className="flex rounded-md border border-slate-300 bg-white p-0.5 text-sm" role="tablist" aria-label="Board">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'team'}
                  className={`rounded px-3 py-1.5 ${view === 'team' ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                  onClick={() => set({ view: null, note: null })}
                >
                  Team Board
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'mine'}
                  className={`rounded px-3 py-1.5 ${view === 'mine' ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                  onClick={() => set({ view: 'mine', notice: null })}
                >
                  My Notes
                </button>
              </div>
            </Can>
            {view === 'team' && (
              <Can anyOf={['notices.post.everyone', 'notices.post.department']} level="edit">
                <button type="button" className={buttonClass} onClick={() => setEditing('new')}>
                  Post Notice
                </button>
              </Can>
            )}
          </div>
        </div>

        {view === 'mine' ? (
          <Can permission="notices.my_notes" level="edit">
            <MyNotes highlightId={params.get('note')} />
          </Can>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Can permission="notices.archive">
                <div className="flex gap-1 text-sm" role="tablist" aria-label="Notices">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'board'}
                    className={`rounded-md px-3 py-1.5 ${tab === 'board' ? 'bg-white font-medium shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white'}`}
                    onClick={() => set({ tab: null })}
                  >
                    On the Board
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'archive'}
                    className={`rounded-md px-3 py-1.5 ${tab === 'archive' ? 'bg-white font-medium shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white'}`}
                    onClick={() => set({ tab: 'archive' })}
                  >
                    Archive
                  </button>
                </div>
              </Can>
              <Can permission="notices.filters">
                <div className="flex flex-1 flex-wrap items-center gap-2 sm:justify-end">
                  <label className="relative w-full sm:w-auto">
                    <span className="sr-only">Search notices</span>
                    <Icon name="search" className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                    <input
                      type="search"
                      className={`${narrowInputClass} w-full pl-8 sm:w-52`}
                      placeholder="Search notices…"
                      value={params.get('q') ?? ''}
                      onChange={(e) => set({ q: e.target.value || null })}
                    />
                  </label>
                  <select aria-label="Category" className={`${narrowInputClass} w-40`} value={cat} onChange={(e) => set({ cat: e.target.value || null })}>
                    <option value="">All categories</option>
                    {categories.options.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Priority" className={`${narrowInputClass} w-36`} value={pri} onChange={(e) => set({ pri: e.target.value || null })}>
                    <option value="">All priorities</option>
                    {(Object.keys(PRIORITY) as Priority[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY[p].label}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" className="h-4 w-4" checked={mine} onChange={(e) => set({ mydept: e.target.checked ? '1' : null })} />
                    For my department
                  </label>
                </div>
              </Can>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="min-w-0">
                {loading ? (
                  <p className="text-sm text-slate-500">Loading…</p>
                ) : tab === 'archive' ? (
                  <section aria-label="Archive" className="space-y-3">
                    {shown.length === 0 ? (
                      <p className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                        {filtering ? 'No archived notices match these filters.' : 'No notices in the archive.'}
                      </p>
                    ) : (
                      shown.map((n) => card(n, 'list'))
                    )}
                  </section>
                ) : (
                  /* The whiteboard */
                  <div
                    className="rounded-2xl border-[6px] border-slate-300 bg-[#fbfcfd] px-4 pb-10 pt-6 shadow-[inset_0_2px_12px_rgba(15,23,42,0.07),0_1px_2px_rgba(15,23,42,0.06)] md:border-[12px] md:px-8 md:pt-9"
                    style={{ backgroundImage: 'linear-gradient(160deg, rgba(255,255,255,0.9), rgba(241,245,249,0.6))' }}
                  >
                    {live.length === 0 && scheduled.length === 0 ? (
                      <p className="py-16 text-center text-sm text-slate-500">{filtering ? 'No notices match these filters.' : 'There are no notices on the board.'}</p>
                    ) : (
                      <div className="space-y-10">
                        {top.length > 0 && (
                          <section aria-label="Pinned notices">
                            <h2 className="mb-5 text-xs font-semibold uppercase tracking-wider text-slate-500">Pinned</h2>
                            <div className={grid}>{top.map((n) => card(n, 'board'))}</div>
                          </section>
                        )}
                        {rest.length > 0 && (
                          <section aria-label="Notices">
                            {top.length > 0 && <h2 className="mb-5 text-xs font-semibold uppercase tracking-wider text-slate-500">Notices</h2>}
                            <div className={grid}>{rest.map((n) => card(n, 'board'))}</div>
                          </section>
                        )}
                        {scheduled.length > 0 && (
                          <section aria-label="Scheduled notices" className="border-t border-dashed border-slate-300 pt-6">
                            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Scheduled</h2>
                            <p className="mb-5 text-xs text-slate-500">Only the poster and notice managers see these until their start date.</p>
                            <div className={grid}>{scheduled.map((n) => card(n, 'board'))}</div>
                          </section>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <Can permission="notices.holidays">
                <aside>
                  <HolidaysPanel />
                </aside>
              </Can>
            </div>
          </>
        )}

        {editing && (
          <NoticeDialog
            notice={editing === 'new' ? null : editing}
            audience={editing === 'new' ? [] : audienceOf(editing.id)}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              void load()
            }}
          />
        )}
        {acks && (
          <Can permission="notices.acks">
            <AckDialog notice={acks} onClose={() => setAcks(null)} />
          </Can>
        )}
      </div>
    </Can>
  )
}
