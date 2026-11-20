// @permission-scope freight.incoming
/* Shown only inside <Can permission="freight.incoming">; the table's row security and save_incoming_shipment check it again. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import { confirmAction } from '../../lib/confirm'
import { downloadCsv } from '../../lib/csv'
import { showDate, todayISO } from '../../lib/dates'
import { fetchAll } from '../../lib/fetchAll'
import { formatMoney, friendlyError } from '../../lib/format'
import { FREIGHT_DEFAULTS, loadFreightSettings } from '../../lib/freight'
import { parseMoney } from '../../lib/money'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import { useOptionList } from '../../lib/useOptionList'
import { ACTION } from '../../lib/wording'

export type Incoming = {
  id: string
  supplier: string
  description: string | null
  reference: string | null
  product_cost: number
  shipping_cost: number
  broker_fees: number
  taxes: number
  customs: number
  delivery_type: string | null
  carrier: string | null
  tracking_number: string | null
  received_on: string | null
  notes: string | null
  currency: 'CAD' | 'USD'
  exchange_rate: number
  total: number
  total_cad: number
  freight_cad: number
  created_by_name: string | null
  archived: boolean
}
const MONEY = ['product_cost', 'shipping_cost', 'broker_fees', 'taxes', 'customs'] as const
const MONEY_LABEL: Record<(typeof MONEY)[number], string> = {
  product_cost: 'Product cost',
  shipping_cost: 'Shipping cost',
  broker_fees: 'Broker fees',
  taxes: 'Taxes',
  customs: 'Customs and duties',
}
const cad = (n: number) => formatMoney(n, 'CAD')

/** Incoming freight: shipments received from suppliers, what they cost to bring in, with filters, totals and CSV. */
export default function IncomingShipments() {
  const { can } = usePermissions()
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = useState<Incoming[] | null>(null)
  const [editing, setEditing] = useState<Incoming | 'new' | null>(null)
  const today = todayISO()
  const q = params.get('iq') ?? ''
  const type = params.get('itype') ?? ''
  const from = params.get('ifrom2') ?? `${today.slice(0, 4)}-01-01`
  const to = params.get('ito2') ?? today
  const showArchived = params.get('iarch') === '1'
  const { options: types } = useOptionList('incoming_delivery_type')
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
    const r = await fetchAll<Incoming>(() => supabase!.from('incoming_shipments').select('*').order('received_on', { ascending: false, nullsFirst: true }).order('id'))
    if (r.error) toast.error(friendlyError(r.error))
    setRows(r.data)
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (rows ?? []).filter(
      (r) =>
        (showArchived || !r.archived) &&
        (!type || r.delivery_type === type) &&
        (!r.received_on || (r.received_on >= from && r.received_on <= to)) &&
        words.every((w) => [r.supplier, r.description, r.reference, r.carrier, r.tracking_number, r.notes].join(' ').toLowerCase().includes(w)),
    )
  }, [rows, q, type, from, to, showArchived])
  const sum = (k: keyof Incoming) => shown.reduce((a, r) => a + Number(r[k]) * Number(r.exchange_rate), 0)

  function exportCsv() {
    downloadCsv(
      `incoming-freight-${from}-to-${to}.csv`,
      ['Received', 'Supplier', 'Description', 'Reference', 'Delivery', 'Carrier', 'Tracking', 'Currency', 'Exchange rate', ...MONEY.map((k) => MONEY_LABEL[k]), 'Total', 'Total CAD', 'Shipping, fees, taxes and customs CAD', 'Notes', 'Archived'],
      shown.map((r) => [
        r.received_on ?? '',
        r.supplier,
        r.description ?? '',
        r.reference ?? '',
        r.delivery_type ?? '',
        r.carrier ?? '',
        r.tracking_number ?? '',
        r.currency,
        Number(r.exchange_rate),
        ...MONEY.map((k) => Number(r[k])),
        Number(r.total),
        Number(r.total_cad),
        Number(r.freight_cad),
        r.notes ?? '',
        r.archived ? 'Archived' : '',
      ]),
    )
  }

  async function archive(r: Incoming) {
    if (!supabase) return
    if (!r.archived && !(await confirmAction(`Archive the shipment from ${r.supplier}? It leaves the list and the totals; Show archived brings it back.`, { confirmLabel: ACTION.archive })))
      return
    const { error } = await supabase.rpc('archive_incoming_shipment', { p_id: r.id, p_archived: !r.archived })
    if (error) return toast.error(friendlyError(error))
    toast.success(r.archived ? 'Shipment restored.' : 'Shipment archived.')
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
          <span className="text-xs text-slate-600">Search</span>
          <input type="search" className={inputClass} placeholder="Supplier, carrier, tracking number, notes" value={q} onChange={(e) => set('iq', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">Type of delivery</span>
          <select className={`${inputClass} w-40`} value={type} onChange={(e) => set('itype', e.target.value)}>
            <option value="">Every type</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">Received from</span>
          <input type="date" className={`${inputClass} w-40`} value={from} onChange={(e) => set('ifrom2', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">To</span>
          <input type="date" className={`${inputClass} w-40`} value={to} min={from} onChange={(e) => set('ito2', e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" checked={showArchived} onChange={(e) => set('iarch', e.target.checked ? '1' : '')} />
          {ACTION.showArchived}
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          <Can permission="freight.incoming.export">
            <button type="button" className={secondaryButtonClass} disabled={!shown.length} onClick={exportCsv}>
              Export CSV
            </button>
          </Can>
          <Can permission="freight.incoming" level="edit">
            <button type="button" className={buttonClass} onClick={() => setEditing('new')}>
              Add Incoming Shipment
            </button>
          </Can>
        </div>
      </div>

      {rows && (
        <section aria-label="Incoming freight totals" data-print-section="Totals" className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]">
          {(
            [
              ['Shipments', String(shown.length)],
              ['Product cost', cad(sum('product_cost'))],
              ['Shipping', cad(sum('shipping_cost'))],
              ['Broker fees', cad(sum('broker_fees'))],
              ['Taxes', cad(sum('taxes'))],
              ['Customs', cad(sum('customs'))],
              ['Total landed cost', cad(shown.reduce((a, r) => a + Number(r.total_cad), 0))],
            ] as const
          ).map(([l, v]) => (
            <div key={l} className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">{l}</p>
              <p className="text-lg font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </section>
      )}
      <p className="text-xs text-slate-500">Totals in CAD (USD amounts × their exchange rate). Shipments without a received date are always listed.</p>

      {!rows ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">No incoming shipments match.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-600">
              <tr>
                <th className="px-3 py-2 font-semibold">Received</th>
                <th className="px-3 py-2 font-semibold">Supplier</th>
                <th className="px-3 py-2 font-semibold">Delivery</th>
                <th className="px-3 py-2 font-semibold">Carrier and tracking</th>
                <th className="px-3 py-2 text-right font-semibold">Product</th>
                <th className="px-3 py-2 text-right font-semibold">Shipping, fees, taxes, customs</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((r) => (
                <tr key={r.id} className={r.archived ? 'opacity-60' : ''}>
                  <td className="px-3 py-2 whitespace-nowrap">{r.received_on ? showDate(r.received_on) : <span className="text-slate-400">Not received</span>}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.supplier}</span>
                    {(r.description || r.reference) && <span className="block text-xs text-slate-500">{[r.description, r.reference].filter(Boolean).join(' · ')}</span>}
                  </td>
                  <td className="px-3 py-2">{r.delivery_type ?? '—'}</td>
                  <td className="px-3 py-2">
                    {r.carrier ?? '—'}
                    {r.tracking_number && <span className="block font-mono text-xs text-slate-600">{r.tracking_number}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(Number(r.product_cost), r.currency)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(Number(r.total) - Number(r.product_cost), r.currency)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="font-medium">{formatMoney(Number(r.total), r.currency)}</span>
                    {r.currency !== 'CAD' && <span className="block text-xs text-slate-500">{cad(Number(r.total_cad))}</span>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Can permission="freight.incoming" level="edit" fallback={<button type="button" className="text-xs underline" onClick={() => setEditing(r)}>Open</button>}>
                      <button type="button" className="text-xs underline" onClick={() => setEditing(r)}>
                        {ACTION.edit}
                      </button>
                      <button type="button" className="ml-3 text-xs text-slate-600 underline" onClick={() => archive(r)}>
                        {r.archived ? ACTION.restore : ACTION.archive}
                      </button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <IncomingDialog
          shipment={editing === 'new' ? null : editing}
          types={types}
          readOnly={!can('freight.incoming', 'edit')}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

/** Add or change one incoming shipment. */
function IncomingDialog({ shipment, types, readOnly, onClose, onSaved }: { shipment: Incoming | null; types: string[]; readOnly: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(() => ({
    supplier: shipment?.supplier ?? '',
    description: shipment?.description ?? '',
    reference: shipment?.reference ?? '',
    delivery_type: shipment?.delivery_type ?? '',
    carrier: shipment?.carrier ?? '',
    tracking_number: shipment?.tracking_number ?? '',
    received_on: shipment?.received_on ?? todayISO(),
    notes: shipment?.notes ?? '',
    currency: shipment?.currency ?? ('CAD' as 'CAD' | 'USD'),
    exchange_rate: String(shipment?.exchange_rate ?? FREIGHT_DEFAULTS.exchange_rate),
    ...Object.fromEntries(MONEY.map((k) => [k, shipment ? String(shipment[k]) : ''])),
  }) as Record<string, string>)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    // A new USD shipment starts with the usual exchange rate from Admin → Freight Settings.
    if (!shipment) loadFreightSettings().then((s) => setF((x) => ({ ...x, exchange_rate: String(s.exchange_rate) })))
  }, [shipment])
  const amounts = MONEY.map((k) => parseMoney(f[k] ?? ''))
  const total = amounts.reduce<number>((a, n) => a + (n && !Number.isNaN(n) ? n : 0), 0)
  const rate = f.currency === 'CAD' ? 1 : Number(f.exchange_rate) || 0

  async function save() {
    if (!supabase) return
    if (!f.supplier.trim()) return toast.error('Enter the supplier.')
    if (amounts.some((n) => Number.isNaN(n))) return toast.error('Enter the amounts as numbers, for example 1250.50.')
    if (f.currency === 'USD' && !(rate > 0)) return toast.error('Enter the exchange rate (USD to CAD).')
    setBusy(true)
    const { error } = await supabase.rpc('save_incoming_shipment', {
      p: { ...f, id: shipment?.id ?? null, exchange_rate: f.currency === 'CAD' ? '1' : f.exchange_rate, ...Object.fromEntries(MONEY.map((k, i) => [k, amounts[i] ?? 0])) },
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Incoming shipment saved.')
    onSaved()
  }

  const text = (k: string, label: string, hint?: string) => (
    <Field label={label} htmlFor={`inc-${k}`} hint={hint}>
      <input id={`inc-${k}`} className={inputClass} disabled={readOnly} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  )
  return (
    <Modal
      title={shipment ? (readOnly ? 'Incoming Shipment' : 'Edit Incoming Shipment') : 'Add Incoming Shipment'}
      onClose={onClose}
      busy={busy}
      wide
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {readOnly ? ACTION.close : ACTION.cancel}
          </button>
          {!readOnly && (
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              {busy ? ACTION.saving : ACTION.save}
            </button>
          )}
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {text('supplier', 'Supplier')}
        {text('description', 'What was shipped', 'Optional, for example “Steel tube, 40 lengths”.')}
        {text('reference', 'Purchase order or reference')}
        <Field label="Date received" htmlFor="inc-received">
          <input id="inc-received" type="date" className={inputClass} disabled={readOnly} value={f.received_on} onChange={(e) => setF({ ...f, received_on: e.target.value })} />
        </Field>
        <Field label="Type of delivery" htmlFor="inc-type">
          <select id="inc-type" className={inputClass} disabled={readOnly} value={f.delivery_type} onChange={(e) => setF({ ...f, delivery_type: e.target.value })}>
            <option value="">Not set</option>
            {f.delivery_type && !types.includes(f.delivery_type) && <option value={f.delivery_type}>{f.delivery_type}</option>}
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        {text('carrier', 'Carrier')}
        {text('tracking_number', 'Tracking number')}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Currency" htmlFor="inc-cur">
            <select id="inc-cur" className={inputClass} disabled={readOnly} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              <option value="CAD">CAD</option>
              <option value="USD">USD</option>
            </select>
          </Field>
          {f.currency === 'USD' && (
            <Field label="Exchange rate" htmlFor="inc-rate" hint="USD to CAD">
              <input id="inc-rate" inputMode="decimal" className={inputClass} disabled={readOnly} value={f.exchange_rate} onChange={(e) => setF({ ...f, exchange_rate: e.target.value })} />
            </Field>
          )}
        </div>
        {MONEY.map((k) => (
          <Field key={k} label={`${MONEY_LABEL[k]} (${f.currency})`} htmlFor={`inc-${k}`}>
            <input id={`inc-${k}`} inputMode="decimal" className={inputClass} disabled={readOnly} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
        <div className="rounded-md bg-slate-50 p-3 text-sm sm:col-span-2">
          Total landed cost: <span className="font-semibold tabular-nums">{formatMoney(total, f.currency)}</span>
          {f.currency === 'USD' && rate > 0 && <span className="text-slate-600"> · {cad(total * rate)}</span>}
        </div>
        <div className="sm:col-span-2">
          <Field label="Notes" htmlFor="inc-notes">
            <textarea id="inc-notes" rows={3} maxLength={4000} className={inputClass} disabled={readOnly} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
