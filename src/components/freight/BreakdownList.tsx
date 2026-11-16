// @permission-scope freight.breakdowns
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { showDate } from '../../lib/dates'
import { fetchAll } from '../../lib/fetchAll'
import { formatMoney, friendlyError } from '../../lib/format'
import { FREIGHT_TYPES, type Breakdown } from '../../lib/freight'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import { buttonClass, inputClass, secondaryButtonClass } from '../form'
import FreightImportDialog from './FreightImportDialog'

type Row = Breakdown & { order_code?: string | null }

/** Every saved shipment cost breakdown, newest first, with search and filters. */
export default function BreakdownList() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const agent = params.get('agent') ?? ''
  const type = params.get('ftype') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const archived = params.get('archived') === '1'
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v) n.set(k, v)
        else n.delete(k)
        return n
      },
      { replace: true },
    )

  const load = useCallback(async () => {
    if (!supabase) return
    const r = await fetchAll<Row>(() => supabase!.from('freight_breakdowns').select('*').order('created_at', { ascending: false }))
    if (r.error) toast.error(friendlyError(r.error))
    // Order numbers for the links.
    const ids = [...new Set(r.data.map((b) => b.order_id).filter((x): x is string => !!x))]
    const codes = new Map<string, string>()
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from('order_summary').select('id, order_code').in('id', ids.slice(i, i + 200))
      for (const o of (data as { id: string; order_code: string }[] | null) ?? []) codes.set(o.id, o.order_code)
    }
    setRows(r.data.map((b) => ({ ...b, order_code: b.order_id ? (codes.get(b.order_id) ?? null) : null })))
    setLoading(false)
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const agents = useMemo(() => [...new Set(rows.map((r) => r.agent_name).filter((x): x is string => !!x))].sort(), [rows])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => r.archived === archived)
      .filter((r) => !agent || r.agent_name === agent)
      .filter((r) => !type || r.freight_type === type)
      .filter((r) => (!from || (r.ship_date ?? '') >= from) && (!to || (r.ship_date ?? '9999') <= to))
      .filter(
        (r) =>
          !needle ||
          [r.customer_name, r.agent_ref, r.invoice_number, r.quote_number, r.agent_name, r.carrier, r.sub_contractor, r.tracking_number, r.order_code]
            .some((v) => String(v ?? '').toLowerCase().includes(needle)),
      )
  }, [rows, q, agent, type, from, to, archived])
  const filtersOn = q || agent || type || from || to || archived

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">One cost breakdown per shipment. Amounts are shown in the currency they were entered in.</p>
        <div className="flex flex-wrap gap-2">
          <Can permission="freight.breakdowns.import" level="edit">
            <button type="button" className={secondaryButtonClass} onClick={() => setImporting(true)}>
              Import
            </button>
          </Can>
          <Can permission="freight.breakdowns" level="edit">
            <Link to="/freight/breakdowns/new" className={buttonClass}>
              New Cost Breakdown
            </Link>
          </Can>
        </div>
      </div>

      <Can permission="freight.breakdowns.filters">
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))] sm:items-end">
          <label className="text-sm [grid-column:1/-1] md:[grid-column:auto]">
            <span className="mb-1 block text-slate-600">Search</span>
            <input className={inputClass} value={q} placeholder="Customer, invoice #, quote #, ref #, carrier" onChange={(e) => set('q', e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Shipping agent</span>
            <select className={inputClass} value={agent} onChange={(e) => set('agent', e.target.value)}>
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Freight type</span>
            <select className={inputClass} value={type} onChange={(e) => set('ftype', e.target.value)}>
              <option value="">All types</option>
              {FREIGHT_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">Shipped from</span>
            <input type="date" className={inputClass} value={from} onChange={(e) => set('from', e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">to</span>
            <input type="date" className={inputClass} value={to} onChange={(e) => set('to', e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm sm:pb-2">
            <input type="checkbox" checked={archived} onChange={(e) => set('archived', e.target.checked ? '1' : '')} /> Show archived
          </label>
          {filtersOn && (
            <button type="button" className="text-left text-sm underline sm:pb-2" onClick={() => setParams({ tab: 'breakdowns' }, { replace: true })}>
              Clear Filters
            </button>
          )}
        </div>
      </Can>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-600">
              <tr>
                <th className="px-3 py-2 font-semibold">Ship date</th>
                <th className="px-3 py-2 font-semibold">Customer</th>
                <th className="px-3 py-2 font-semibold">Order #</th>
                <th className="px-3 py-2 font-semibold">Invoice #</th>
                <th className="px-3 py-2 font-semibold">Agent</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 text-right font-semibold">Invoice total</th>
                <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Breakdown cost</th>
                <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Price difference</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && shown.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-slate-500">
                    {rows.length === 0 ? 'No cost breakdowns have been saved yet.' : 'No cost breakdowns match these filters.'}
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 whitespace-nowrap">{showDate(r.ship_date)}</td>
                  <td className="px-3 py-2">{r.customer_name ?? '—'}</td>
                  <td className="px-3 py-2">
                    {r.order_id && r.order_code ? (
                      <Link to={`/orders/${r.order_id}`} className="text-blue-700 underline">
                        {r.order_code}
                      </Link>
                    ) : (
                      <span className="text-slate-500">Not linked</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{r.invoice_number ?? '—'}</td>
                  <td className="px-3 py-2">{r.agent_name ?? '—'}</td>
                  <td className="px-3 py-2">{r.freight_type}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{formatMoney(Number(r.invoice_total), r.currency)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{formatMoney(Number(r.breakdown_total), r.currency)}</td>
                  <td className={`px-3 py-2 text-right font-medium whitespace-nowrap tabular-nums ${Number(r.price_difference) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {formatMoney(Number(r.price_difference), r.currency)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link to={`/freight/breakdowns/${r.id}`} className="text-blue-700 underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && (
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            Showing {shown.length} of {rows.filter((r) => r.archived === archived).length}
          </p>
        )}
      </section>

      {importing && (
        <Can permission="freight.breakdowns.import" level="edit">
          <FreightImportDialog
            onClose={() => setImporting(false)}
            onDone={() => {
              setImporting(false)
              load()
            }}
          />
        </Can>
      )}
    </div>
  )
}
