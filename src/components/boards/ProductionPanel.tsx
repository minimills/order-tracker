// @permission-scope boards.card.open
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { activityTime } from '../../lib/activity'
import { formatDuration, secondsBetween, type BoardData, type Card, type StageTime } from '../../lib/boards'
import { supabase } from '../../lib/supabase'
import { useDepartments } from '../../lib/useDepartments'
import Can from '../Can'
import SerialNumber from '../SerialNumber'
import { secondaryButtonClass } from '../form'

/**
 * Production details on a machine or leftover card: the machine, the order,
 * the stage's department, the final check, leftovers and stage times.
 */
export default function ProductionPanel({ card, data, onOpenCard }: { card: Card; data: BoardData; onOpenCard?: (id: string) => void }) {
  const { departments } = useDepartments()
  const [times, setTimes] = useState<StageTime[]>([])
  const stage = data.stages.find((s) => s.id === card.stage_id)
  const machine = data.machines.find((m) => m.id === card.machine_id) ?? null
  const machineCard = card.card_kind === 'leftover' ? data.cards.find((c) => c.id === card.leftover_of) : null
  const leftovers = card.card_kind === 'machine' ? data.cards.filter((c) => c.leftover_of === card.id) : []

  useEffect(() => {
    if (!supabase || card.card_kind !== 'machine') return
    supabase
      .from('board_card_stage_times')
      .select('*')
      .eq('card_id', card.id)
      .order('entered_at')
      .then(({ data: rows }) => setTimes((rows as StageTime[]) ?? []))
  }, [card.id, card.card_kind, card.stage_id, card.started_at, card.finished_at])

  return (
    <section className="rounded-md border border-teal-200 bg-teal-50/50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{machine?.machine_type ?? 'Machine'}</span>
        {machine?.serial_number && <SerialNumber serial={machine.serial_number} />}
        {card.card_kind === 'leftover' && <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold text-amber-900">Leftover items</span>}
        <Can permission="order.page">
          {card.order_id && (
            <Link to={`/orders/${card.order_id}`} className="text-blue-700 underline">
              Open the Order
            </Link>
          )}
        </Can>
      </div>
      {stage && (
        <p className="mt-1 text-slate-700">
          Stage: <strong>{stage.name}</strong>
          {stage.department_id && <> · {departments.find((d) => d.id === stage.department_id)?.name}</>}
        </p>
      )}

      {card.card_kind === 'machine' && stage?.step === 'final_check' && card.machine_id && (
        <Can permission="checklist">
          <Link to={`/checklists/${card.machine_id}`} className={`${secondaryButtonClass} mt-2 inline-block`}>
            Open Final Check
          </Link>
        </Can>
      )}

      {machineCard && (
        <p className="mt-2 text-slate-700">
          These items were not finished when the machine moved on. They merge back into the machine card as completed when
          they are all done, or when this card is moved to the machine’s stage.{' '}
          {onOpenCard && (
            <button type="button" className="text-blue-700 underline" onClick={() => onOpenCard(machineCard.id)}>
              Open the Machine Card
            </button>
          )}
        </p>
      )}
      {leftovers.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-amber-900">Leftover items still open</div>
          <ul className="mt-0.5 space-y-0.5">
            {leftovers.map((l) => (
              <li key={l.id}>
                {onOpenCard ? (
                  <button type="button" className="text-left text-blue-700 underline" onClick={() => onOpenCard(l.id)}>
                    {l.title}
                  </button>
                ) : (
                  l.title
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {card.card_kind === 'machine' && (
        <Can permission="production.stage_times">
          {times.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium text-slate-500">Time per stage</div>
              <table className="mt-1 w-full text-xs">
                <tbody className="divide-y divide-teal-100">
                  {times.map((t) => {
                    const start = t.started_at ?? null
                    const end = t.finished_at ?? null
                    return (
                      <tr key={t.id}>
                        <td className="py-1 pr-2 font-medium">{t.stage_name}</td>
                        <td className="py-1 pr-2 text-slate-600">
                          {start ? activityTime.format(new Date(start)) : `arrived ${activityTime.format(new Date(t.entered_at))}`}
                          {start && t.auto_started && ' (arrival)'}
                        </td>
                        <td className="py-1 pr-2 text-slate-600">
                          {end ? <>to {activityTime.format(new Date(end))}{t.auto_finished && ' (when it moved on)'}</> : t.left_at ? '' : 'in progress'}
                        </td>
                        <td className="py-1 text-right font-medium">{start && end ? formatDuration(secondsBetween(start, end)) : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-slate-500">
                Start and Finish are filled in automatically from when the card arrived and left if nobody pressed the buttons.
              </p>
            </div>
          )}
        </Can>
      )}
    </section>
  )
}
