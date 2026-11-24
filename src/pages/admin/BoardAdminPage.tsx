// @permission-scope admin.board
import { stageLabel } from '../../lib/stages'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import ChangeList, { type PositionChange, type SerialChange } from '../../components/admin/ChangeList'
import { buttonClass, Modal, secondaryButtonClass } from '../../components/form'
import { useAlerts } from '../../lib/alerts'
import { fetchAll } from '../../lib/fetchAll'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { tr } from '../../i18n'

type Row = { id: string; order_code: string; board_position: number; stage: string; customer_name: string; machines_list: string | null }
type Diff = { positions: PositionChange[]; serials: SerialChange[] }

export default function BoardAdminPage() {
  const { refresh: refreshAlerts } = useAlerts()
  const [rows, setRows] = useState<Row[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<{ orderId: string | null; position: number | null; title: string; diff: Diff } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await fetchAll<Row>(() =>
      supabase!
        .from('order_summary')
        .select('id, order_code, board_position, stage, customer_name, machines_list')
        .not('board_position', 'is', null)
        .order('board_position'),
    )
    if (error) toast.error(friendlyError(error))
    setRows(data)
    setDrafts({})
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function ask(orderId: string | null, position: number | null, title: string) {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('admin_board_change', { p_order_id: orderId, p_position: position, p_apply: false })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setPending({ orderId, position, title, diff: data as Diff })
  }

  async function apply() {
    if (!supabase || !pending) return
    setBusy(true)
    const { error } = await supabase.rpc('admin_board_change', {
      p_order_id: pending.orderId,
      p_position: pending.position,
      p_apply: true,
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Board saved."))
    setPending(null)
    refreshAlerts()
    load()
  }

  const nothing = pending && pending.diff.positions.length === 0 && pending.diff.serials.length === 0

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title={tr("Shop Queue")}
        aside={
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => ask(null, null, 'Renumber All')}>
            {tr("Renumber All")}
          </button>
        }
      >
        {tr("To move an order, type the place you want it in the queue (1 = built first) and press Set. Everyone in between moves one place, and unbuilt serials follow the new order.")} <strong>{tr("Renumber All")}</strong> {tr("tidies the queue and re-checks every unbuilt serial. You always see the changes before they are saved. The normal")}{' '}
        <Link to="/board" className="underline">
          {tr("Orders Board")}
        </Link>{' '}
        {tr("does the same by dragging.")}
      </AdminPageHeader>

      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {rows.length === 0 && <p className="p-4 text-sm text-slate-500">{tr("The board is empty.")}</p>}
        {rows.map((r) => {
          const draft = drafts[r.id] ?? String(r.board_position)
          const n = Number(draft)
          const valid = Number.isInteger(n) && n >= 1 && n !== r.board_position
          return (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <input
                aria-label={tr("Place in queue for order {{order_code}}", { order_code: r.order_code })}
                inputMode="numeric"
                className="w-16 rounded-md border border-slate-300 px-2 py-1 text-center font-semibold"
                value={draft}
                onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && valid && ask(r.id, n, tr("Move order {{order_code}} to place {{n}} in the queue", { order_code: r.order_code, n: n }))}
              />
              <div className="min-w-0 flex-1">
                <Link to={`/orders/${r.id}`} className="font-medium hover:underline">
                  {tr("Order")} {r.order_code}
                </Link>{' '}
                <span className="text-slate-600">· {r.customer_name}</span>
                <div className="truncate text-xs text-slate-500">
                  {stageLabel(r.stage)}
                  {r.machines_list && ` · ${r.machines_list}`}
                </div>
              </div>
              {valid && (
                <button type="button" className={buttonClass} disabled={busy} onClick={() => ask(r.id, n, tr("Move order {{order_code}} to place {{n}} in the queue", { order_code: r.order_code, n: n }))}>
                  {tr("Set")}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {pending && (
        <Modal
          title={pending.title}
          onClose={() => setPending(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setPending(null)} disabled={busy}>
                {tr("Cancel")}
              </button>
              <button type="button" className={buttonClass} onClick={apply} disabled={busy || !!nothing}>
                {busy ? tr("Saving…") : tr("Save These Changes")}
              </button>
            </>
          }
        >
          {nothing ? (
            <p className="text-sm text-slate-600">{tr("The queue is already in order. No changes would be made.")}</p>
          ) : (
            <ChangeList positions={pending.diff.positions} serials={pending.diff.serials} />
          )}
        </Modal>
      )}
    </div>
  )
}
