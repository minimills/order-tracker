// @permission-scope boards.closed
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { boardNumberText, type Board } from '../../lib/boards'
import { showDate } from '../../lib/dates'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import Can from '../Can'
import { inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'
import ReopenBoardDialog from './ReopenBoardDialog'
import { tr } from '../../i18n'

/**
 * "Closed Boards": every closed board the person can open (production boards
 * close when their order is shipped; any board can be closed early). Search,
 * filters, Open (view only) and Reopen.
 */
export default function ClosedBoardsDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Board[] | null>(null)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'all' | 'production' | 'other'>('all')
  const [reason, setReason] = useState<'all' | 'shipped' | 'manual'>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reopen, setReopen] = useState<Board | null>(null)
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    supabase
      ?.from('boards')
      .select('*')
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false })
      .then(({ data }) => setRows((data as Board[]) ?? []))
  }, [reloads])

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (rows ?? []).filter((b) => {
      const text = `${b.name} ${b.description ?? ''} ${boardNumberText(b)}`.toLowerCase()
      if (words.length && !words.every((w) => text.includes(w))) return false
      if (kind === 'production' && b.purpose !== 'production') return false
      if (kind === 'other' && b.purpose === 'production') return false
      if (reason !== 'all' && b.close_reason !== reason) return false
      const day = b.closed_at?.slice(0, 10) ?? ''
      if (from && day < from) return false
      if (to && day > to) return false
      return true
    })
  }, [rows, q, kind, reason, from, to])

  return (
    <Modal
      title={tr("Closed Boards")}
      wide
      onClose={onClose}
      footer={
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          {ACTION.close}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]">
          <input aria-label={tr("Search closed boards")} className={inputClass} placeholder={tr("Search name or board number")} value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label={tr("Kind of board")} className={narrowInputClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">{tr("All boards")}</option>
            <option value="production">{tr("Orders (production boards)")}</option>
            <option value="other">{tr("Other boards")}</option>
          </select>
          <select aria-label={tr("Why it was closed")} className={narrowInputClass} value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            <option value="all">{tr("Closed for any reason")}</option>
            <option value="shipped">{tr("Order shipped")}</option>
            <option value="manual">{tr("Closed by hand")}</option>
          </select>
          <input type="date" aria-label={tr("Closed from")} className={narrowInputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" aria-label={tr("Closed until")} className={narrowInputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {rows === null ? (
          <p className="text-slate-500">{tr("Loading…")}</p>
        ) : shown.length === 0 ? (
          <p className="text-slate-500">{rows.length === 0 ? tr("No boards are closed.") : tr("No closed boards match these filters.")}</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
            {shown.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="inline-block h-3 w-3 shrink-0 rounded" style={{ backgroundColor: b.colour }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{b.name}</span>
                  <span className="block text-xs text-slate-500">
                    {boardNumberText(b)} {tr("· closed")} {b.closed_at ? showDate(b.closed_at.slice(0, 10)) : ''}
                    {b.close_reason === 'shipped' ? tr(" (order shipped)") : b.closed_by_name ? tr(" by {{closed_by_name}}", { closed_by_name: b.closed_by_name }) : ''}
                  </span>
                </span>
                <Link to={`/boards/${b.id}`} className="text-blue-700 underline" onClick={onClose}>
                  {tr("Open")}
                </Link>
                <Can permission="boards.reopen" level="edit">
                  <button type="button" className="underline" onClick={() => setReopen(b)}>
                    {tr("Reopen")}
                  </button>
                </Can>
              </li>
            ))}
          </ul>
        )}
      </div>
      {reopen && (
        <Can permission="boards.reopen" level="edit">
          <ReopenBoardDialog
            board={reopen}
            onClose={() => setReopen(null)}
            onDone={() => {
              setReopen(null)
              setReloads((n) => n + 1)
              onChanged()
            }}
          />
        </Can>
      )}
    </Modal>
  )
}
