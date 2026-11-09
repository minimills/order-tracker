// @permission-scope boards
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import NewBoardDialog from '../components/boards/NewBoardDialog'
import { buttonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import type { Board } from '../lib/boards'
import { friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'

type Row = Board & { board_shares: { id: string }[] }

/** /boards – boards you own, boards shared with you (admins: every board). */
export default function BoardsPage() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [boards, setBoards] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('boards').select('*, board_shares(id)').order('name')
    if (error) toast.error(friendlyError(error))
    setBoards((data as Row[]) ?? [])
    setLoading(false)
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const shown = boards.filter((b) => showArchived || !b.archived)
  const production = shown.filter((b) => b.purpose === 'production')
  const mine = shown.filter((b) => b.purpose !== 'production' && b.owner_email === me)
  const others = shown.filter((b) => b.purpose !== 'production' && b.owner_email !== me)

  const tile = (b: Row) => (
    <li key={b.id}>
      <Link
        to={`/boards/${b.id}`}
        className={`block h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:shadow ${b.archived ? 'opacity-60' : ''}`}
        style={{ borderTop: `6px solid ${b.colour}` }}
      >
        <div className="font-semibold">{b.name}</div>
        {b.description && <div className="mt-0.5 line-clamp-2 text-sm text-slate-600">{b.description}</div>}
        <div className="mt-2 text-xs text-slate-500">
          {b.purpose === 'production' ? 'Production' : b.owner_email === me ? 'Yours' : `Owner: ${b.owner_email ?? 'none'}`}
          {b.board_shares.length > 0 && ' · shared'}
          {b.archived && ' · archived'}
        </div>
      </Link>
    </li>
  )

  return (
    <Can permission="boards">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Boards</h1>
            <p className="text-sm text-slate-600">Your own boards and boards shared with you, with cards organised in stages.</p>
          </div>
          <div className="flex items-center gap-4">
            <Can permission="boards.show_archived">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived
              </label>
            </Can>
            <Can permission="boards.create" level="edit">
              <button type="button" className={buttonClass} onClick={() => setCreating(true)}>
                Create Board
              </button>
            </Can>
          </div>
        </div>

        {loading ? (
          <p className="text-center text-slate-500">Loading…</p>
        ) : (
          <>
            {production.length > 0 && (
              <section>
                <h2 className="mb-2 font-semibold">Production Boards</h2>
                <p className="mb-2 text-sm text-slate-600">One board per order in the shop queue, made automatically when the order is confirmed.</p>
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{production.map(tile)}</ul>
              </section>
            )}
            <section>
              <h2 className="mb-2 font-semibold">My Boards</h2>
              {mine.length === 0 ? (
                <p className="text-sm text-slate-500">You have not created any boards yet.</p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{mine.map(tile)}</ul>
              )}
            </section>
            <section>
              <h2 className="mb-2 font-semibold">Shared with Me</h2>
              {others.length === 0 ? (
                <p className="text-sm text-slate-500">No boards have been shared with you yet.</p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{others.map(tile)}</ul>
              )}
            </section>
          </>
        )}
        {creating && (
          <Can permission="boards.create" level="edit">
            <NewBoardDialog onClose={() => setCreating(false)} />
          </Can>
        )}
      </div>
    </Can>
  )
}
