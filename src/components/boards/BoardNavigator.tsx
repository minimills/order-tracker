// @permission-scope boards.card.navigate
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadBoardChoices, type BoardChoice } from '../../lib/boards'
import { narrowInputClass } from '../form'

const small = 'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50 disabled:opacity-40'

/**
 * At the top of a board: ← Previous / Next → board (orders among the
 * production boards, other boards among the others) and "Go to an order or
 * board", so people switch boards without opening a card.
 */
export default function BoardNavigator({ boardId, production }: { boardId: string; production: boolean }) {
  const navigate = useNavigate()
  const [boards, setBoards] = useState<BoardChoice[] | null>(null)
  useEffect(() => {
    loadBoardChoices().then(setBoards)
  }, [])

  const orders = (boards ?? []).filter((b) => b.purpose === 'production')
  const others = (boards ?? []).filter((b) => b.purpose !== 'production')
  const group = production ? orders : others
  const pos = group.findIndex((b) => b.id === boardId)
  const prev = pos > 0 ? group[pos - 1] : null
  const next = pos >= 0 && pos < group.length - 1 ? group[pos + 1] : null
  const what = production ? 'order' : 'board'

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600" data-print="hide">
      <button type="button" className={small} disabled={!prev} title={prev?.name} onClick={() => prev && navigate(`/boards/${prev.id}`)} aria-label={`Previous ${what}`}>
        ← Previous
      </button>
      {pos >= 0 && (
        <span className="tabular-nums">
          {pos + 1} of {group.length} {production ? 'orders' : 'boards'}
        </span>
      )}
      <button type="button" className={small} disabled={!next} title={next?.name} onClick={() => next && navigate(`/boards/${next.id}`)} aria-label={`Next ${what}`}>
        Next →
      </button>
      <select
        aria-label="Go to an order or board"
        className={`${narrowInputClass} w-64 max-w-full py-1`}
        value=""
        onChange={(e) => e.target.value && navigate(`/boards/${e.target.value}`)}
      >
        <option value="">{boards === null ? 'Loading…' : 'Go to an order or board…'}</option>
        {orders.length > 0 && (
          <optgroup label="Orders (production boards)">
            {orders.map((b) => (
              <option key={b.id} value={b.id} disabled={b.id === boardId}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="Boards">
            {others.map((b) => (
              <option key={b.id} value={b.id} disabled={b.id === boardId}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  )
}
