// @permission-scope ce, admin.ce
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { CeDeclaration, CeSend } from '../../lib/ce'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { inputClass } from '../form'
import CeDeclarationsTable from './CeDeclarationsTable'

/**
 * Declarations of conformity for an order or a machine (the latest version of
 * each machine, older versions under "History"), or – without orderId /
 * machineId – the full register with filters (Admin).
 */
export default function CeRegister({ orderId, machineId, refreshKey = 0 }: { orderId?: string; machineId?: string; refreshKey?: number }) {
  const full = !orderId && !machineId
  const [rows, setRows] = useState<CeDeclaration[] | null>(null)
  const [sends, setSends] = useState<CeSend[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [f, setF] = useState({ customer: '', order: '', type: '', from: '', to: '', older: false })

  const load = useCallback(async () => {
    if (!supabase) return
    let q = supabase.from('ce_declarations').select('*').order('issued_at', { ascending: false }).limit(full ? 1000 : 300)
    if (orderId) q = q.eq('order_id', orderId)
    if (machineId) q = q.eq('machine_id', machineId)
    const { data, error } = await q
    if (error) toast.error(friendlyError(error))
    const list = (data as CeDeclaration[]) ?? []
    setRows(list)
    const orderIds = [...new Set(list.map((d) => d.order_id))]
    const s = orderIds.length ? await supabase.from('ce_declaration_sends').select('*').in('order_id', orderIds.slice(0, 300)).order('sent_at', { ascending: false }) : { data: [] }
    setSends((s.data as CeSend[]) ?? [])
  }, [orderId, machineId, full])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load, refreshKey])

  const types = useMemo(() => [...new Set((rows ?? []).map((r) => r.data.machine.type_name))].sort(), [rows])
  if (!rows) return <p className="text-sm text-slate-500">Loading…</p>

  if (!full) {
    const latest = rows.filter((r) => r.status === 'issued')
    const older = rows.filter((r) => r.status !== 'issued')
    return (
      <div className="space-y-3">
        {latest.length === 0 && older.length === 0 ? (
          <p className="text-sm text-slate-500">No declarations of conformity have been issued yet.</p>
        ) : (
          <CeDeclarationsTable rows={latest} sends={sends} onSent={load} />
        )}
        {older.length > 0 && (
          <div>
            <button type="button" className="text-sm text-slate-700 underline" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
              {showHistory ? '▾' : '▸'} History ({older.length} older version{older.length === 1 ? '' : 's'})
            </button>
            {showHistory && (
              <div className="mt-2">
                <CeDeclarationsTable rows={older} sends={sends} onSent={load} />
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Admin: everything, with filters.
  const words = (v: string) => v.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = rows.filter((r) => {
    if (!f.older && r.status !== 'issued') return false
    const customer = `${r.data.customer_company ?? ''} ${r.data.customer_name}`.toLowerCase()
    if (!words(f.customer).every((w) => customer.includes(w))) return false
    if (f.order.trim() && r.data.order_code.toLowerCase() !== f.order.trim().toLowerCase()) return false
    if (f.type && r.data.machine.type_name !== f.type) return false
    const day = r.issued_at.slice(0, 10)
    if (f.from && day < f.from) return false
    if (f.to && day > f.to) return false
    return true
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="space-y-3">
      <div className="grid gap-2 text-sm [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]">
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">Customer</span>
          <input className={inputClass} value={f.customer} placeholder="Name or company" onChange={set('customer')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">Order #</span>
          <input className={inputClass} value={f.order} placeholder="For example 87" onChange={set('order')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">Machine type</span>
          <select className={inputClass} value={f.type} onChange={set('type')}>
            <option value="">All machine types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">Issued from</span>
          <input type="date" className={inputClass} value={f.from} onChange={set('from')} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">Issued to</span>
          <input type="date" className={inputClass} value={f.to} onChange={set('to')} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.older} onChange={(e) => setF({ ...f, older: e.target.checked })} /> Include older versions
        </label>
        <span className="text-xs text-slate-500">
          Showing {shown.length} of {rows.length}
        </span>
        <button type="button" className="text-xs underline" onClick={() => setF({ customer: '', order: '', type: '', from: '', to: '', older: false })}>
          Clear Filters
        </button>
      </div>
      <CeDeclarationsTable key={JSON.stringify(f)} rows={shown} sends={sends} showOrder onSent={load} />
    </div>
  )
}
