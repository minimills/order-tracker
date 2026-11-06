// @permission-scope admin.archive
import { stageLabel } from '../../lib/stages'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { Field, inputClass, Modal, secondaryButtonClass } from '../../components/form'
import { useAlerts } from '../../lib/alerts'
import { showDate } from '../../lib/dates'
import { fetchAll } from '../../lib/fetchAll'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Item = {
  table: 'orders' | 'customers' | 'order_machines'
  id: string
  label: string
  detail: string
  archived_at: string | null
  archived_by: string | null
}

const KIND: Record<Item['table'], string> = { orders: 'Order', customers: 'Customer', order_machines: 'Machine' }

export default function ArchivePage() {
  const { refresh: refreshAlerts } = useAlerts()
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | Item['table']>('all')
  const [deleting, setDeleting] = useState<Item | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const [o, c, m] = await Promise.all([
      fetchAll<{ id: string; order_code: string; customer_name: string; stage: string; archived_at: string | null; archived_by: string | null }>(
        () =>
          supabase!.from('order_summary').select('id, order_code, customer_name, stage, archived_at, archived_by').eq('archived', true).order('id'),
      ),
      fetchAll<{ id: string; name: string; company: string | null; archived_at: string | null; archived_by: string | null }>(() =>
        supabase!.from('customers').select('id, name, company, archived_at, archived_by').eq('archived', true).order('id'),
      ),
      fetchAll<{
        id: string
        serial_number: string | null
        archived_at: string | null
        archived_by: string | null
        orders: { order_code: string } | null
        machine_types: { name: string } | null
      }>(() =>
        supabase!
          .from('order_machines')
          .select('id, serial_number, archived_at, archived_by, orders(order_code), machine_types(name)')
          .eq('archived', true)
          .order('id'),
      ),
    ])
    const error = o.error ?? c.error ?? m.error
    if (error) toast.error(friendlyError(error))
    const all: Item[] = [
      ...o.data.map((x) => ({ table: 'orders' as const, id: x.id, label: `Order ${x.order_code}`, detail: `${x.customer_name} · ${stageLabel(x.stage)}`, archived_at: x.archived_at, archived_by: x.archived_by })),
      ...c.data.map((x) => ({ table: 'customers' as const, id: x.id, label: x.name, detail: x.company ?? '', archived_at: x.archived_at, archived_by: x.archived_by })),
      ...m.data.map((x) => ({
        table: 'order_machines' as const,
        id: x.id,
        label: `${x.machine_types?.name ?? 'Machine'} ${x.serial_number ?? ''}`.trim(),
        detail: `on order ${x.orders?.order_code ?? '?'}`,
        archived_at: x.archived_at,
        archived_by: x.archived_by,
      })),
    ].sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''))
    setItems(all)
    setLoading(false)
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function restore(item: Item) {
    if (!supabase) return
    const { error } = await supabase.from(item.table).update({ archived: false }).eq('id', item.id)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${item.label} restored.${item.table === 'orders' ? ' If it is a confirmed order, it is added at the end of the shop queue.' : ''}`)
    refreshAlerts()
    load()
  }

  async function remove() {
    if (!supabase || !deleting) return
    setBusy(true)
    const { error } = await supabase.rpc('admin_delete_record', { p_table: deleting.table, p_id: deleting.id, p_confirm: typed })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${deleting.label} deleted permanently.`)
    setDeleting(null)
    load()
  }

  const shown = items.filter((i) => filter === 'all' || i.table === filter)

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <AdminPageHeader title="Archive">
        Archived records are hidden from normal screens. <strong>Restore</strong> restores one.{' '}
        <strong>Permanently Delete</strong> removes it permanently (an order takes its machines and payments with it); this
        cannot be undone.
      </AdminPageHeader>

      <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-sm" role="tablist">
        {(['all', 'orders', 'customers', 'order_machines'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={filter === t}
            onClick={() => setFilter(t)}
            className={`rounded px-3 py-1.5 font-medium ${filter === t ? 'bg-white shadow-sm' : 'text-slate-600'}`}
          >
            {t === 'all' ? 'All' : `${KIND[t]}s`}
          </button>
        ))}
      </div>

      <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {loading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {!loading && shown.length === 0 && <p className="p-6 text-center text-sm text-slate-500">There are no archived records.</p>}
        {shown.map((i) => (
          <div key={`${i.table}-${i.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div>
                <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{KIND[i.table]}</span>
                <span className="font-medium">{i.label}</span>
                {i.detail && <span className="text-slate-500"> · {i.detail}</span>}
              </div>
              <div className="text-xs text-slate-500">
                Archived {showDate(i.archived_at?.slice(0, 10))}
                {i.archived_by && ` by ${i.archived_by}`}
              </div>
            </div>
            <button type="button" className={secondaryButtonClass} onClick={() => restore(i)}>
              Restore
            </button>
            <button
              type="button"
              className="text-sm text-red-700 underline"
              onClick={() => {
                setDeleting(i)
                setTyped('')
              }}
            >
              Permanently Delete
            </button>
          </div>
        ))}
      </div>

      {deleting && (
        <Modal
          title={`Permanently Delete ${deleting.label}?`}
          onClose={() => setDeleting(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setDeleting(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-40"
                onClick={remove}
                disabled={busy || typed !== 'DELETE'}
              >
                {busy ? 'Deleting…' : 'Permanently Delete'}
              </button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            This cannot be undone.
            {deleting.table === 'orders' && ' The order’s machines and payments are permanently deleted as well.'}
            {deleting.table === 'customers' && ' A customer can only be permanently deleted once they have no orders.'} The activity
            log keeps a record that it was deleted.
          </p>
          <Field label="Enter DELETE to confirm" htmlFor="confirm-delete" className="mt-4">
            <input
              id="confirm-delete"
              className={inputClass}
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
        </Modal>
      )}
    </div>
  )
}
