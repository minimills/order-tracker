// @permission-scope boards
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import NewBoardDialog from '../components/boards/NewBoardDialog'
import ClosedBoardsDialog from '../components/boards/ClosedBoardsDialog'
import { buttonClass, secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { boardNumberText, type Board } from '../lib/boards'
import { friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import PrintButton from '../components/print/PrintButton'
import { tr } from '../i18n'

type Row = Board & { board_shares: { id: string }[] }

/** /boards – boards you own, boards shared with you (admins: every board). */
export default function BoardsPage() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [boards, setBoards] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [closedOpen, setClosedOpen] = useState(false)

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

  // Closed boards (0050) are only under “Closed Boards”.
  const shown = boards.filter((b) => (showArchived || !b.archived) && !b.closed_at)
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
          {boardNumberText(b) && `${boardNumberText(b)} · `}
          {b.purpose === 'production' ? tr("Production") : b.owner_email === me ? tr("Yours") : tr("Owner: {{value}}", { value: b.owner_email ?? 'none' })}
          {b.board_shares.length > 0 && tr(" · shared")}
          {b.archived && tr(" · archived")}
        </div>
      </Link>
    </li>
  )

  return (
    <Can permission="boards">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold">{tr("Boards")}</h1>
              <Can permission="boards.print">
                <PrintButton title={tr("Boards")} />
              </Can>
            </div>
            <p className="text-sm text-slate-600">{tr("Your own boards and boards shared with you, with cards organised in stages.")}</p>
          </div>
          <div className="flex items-center gap-4">
            <Can permission="boards.show_archived">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                {tr("Show archived")}
              </label>
            </Can>
            <Can permission="boards.closed">
              <button type="button" className={secondaryButtonClass} onClick={() => setClosedOpen(true)}>
                {tr("Closed Boards")}{boards.some((b) => b.closed_at) ? ` (${boards.filter((b) => b.closed_at).length})` : ''}
              </button>
            </Can>
            <Can permission="boards.create" level="edit">
              <button type="button" className={buttonClass} onClick={() => setCreating(true)}>
                {tr("Create Board")}
              </button>
            </Can>
          </div>
        </div>

        {loading ? (
          <p className="text-center text-slate-500">{tr("Loading…")}</p>
        ) : (
          <>
            {production.length > 0 && (
              <section>
                <h2 className="mb-2 font-semibold">{tr("Production Boards")}</h2>
                <p className="mb-2 text-sm text-slate-600">{tr("One board per order in the shop queue, made automatically when the order is confirmed.")}</p>
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{production.map(tile)}</ul>
              </section>
            )}
            <section>
              <h2 className="mb-2 font-semibold">{tr("My Boards")}</h2>
              {mine.length === 0 ? (
                <p className="text-sm text-slate-500">{tr("You have not created any boards yet.")}</p>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{mine.map(tile)}</ul>
              )}
            </section>
            <section>
              <h2 className="mb-2 font-semibold">{tr("Shared with Me")}</h2>
              {others.length === 0 ? (
                <p className="text-sm text-slate-500">{tr("No boards have been shared with you yet.")}</p>
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
        {closedOpen && (
          <Can permission="boards.closed">
            <ClosedBoardsDialog onClose={() => setClosedOpen(false)} onChanged={load} />
          </Can>
        )}
      </div>
    </Can>
  )
}
