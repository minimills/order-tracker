// @permission-scope boards.card.navigate
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BoardData, Card } from '../../lib/boards'
import { supabase } from '../../lib/supabase'
import { narrowInputClass } from '../form'

type BoardRow = { id: string; name: string; purpose: string }

const small = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-40'

/** Inside a card: Previous / Next card in the same stage, and "Go to" any order (production board) or board. */
export default function CardNavigator({ card, data, onOpenCard }: { card: Card; data: BoardData; onOpenCard: (id: string) => void }) {
  const navigate = useNavigate()
  const [boards, setBoards] = useState<BoardRow[] | null>(null)
  const inStage = data.cards.filter((c) => c.stage_id === card.stage_id).sort((a, b) => a.sort_order - b.sort_order)
  const pos = inStage.findIndex((c) => c.id === card.id)
  const prev = pos > 0 ? inStage[pos - 1] : null
  const next = pos >= 0 && pos < inStage.length - 1 ? inStage[pos + 1] : null

  // The boards this person can open (production boards are the orders).
  useEffect(() => {
    if (!supabase) return
    supabase
      .from('boards')
      .select('id, name, purpose')
      .eq('archived', false)
      .order('name')
      .then(({ data: rows }) => setBoards((rows as BoardRow[]) ?? []))
  }, [])

  const orders = (boards ?? []).filter((b) => b.purpose === 'production').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const others = (boards ?? []).filter((b) => b.purpose !== 'production')

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <button type="button" className={small} disabled={!prev} onClick={() => prev && onOpenCard(prev.id)} aria-label="Previous card in this stage">
        ← Previous
      </button>
      <span className="tabular-nums">
        {pos + 1} of {inStage.length} in this stage
      </span>
      <button type="button" className={small} disabled={!next} onClick={() => next && onOpenCard(next.id)} aria-label="Next card in this stage">
        Next →
      </button>
      <select
        aria-label="Go to an order or board"
        className={`${narrowInputClass} w-56 max-w-full py-1 text-xs`}
        value=""
        onChange={(e) => e.target.value && navigate(`/boards/${e.target.value}`)}
      >
        <option value="">{boards === null ? 'Loading…' : 'Go to an order or board…'}</option>
        {orders.length > 0 && (
          <optgroup label="Orders (production boards)">
            {orders.map((b) => (
              <option key={b.id} value={b.id} disabled={b.id === data.board?.id}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="Boards">
            {others.map((b) => (
              <option key={b.id} value={b.id} disabled={b.id === data.board?.id}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  )
}
