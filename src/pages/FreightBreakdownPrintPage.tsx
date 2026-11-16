// @permission-scope freight.breakdowns.print
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Can from '../components/Can'
import { useCompany } from '../lib/company'
import { showDate, todayISO } from '../lib/dates'
import { formatMoney } from '../lib/format'
import { handlingText, type Breakdown } from '../lib/freight'
import { supabase } from '../lib/supabase'

/** A saved shipment cost breakdown on one page with the letterhead, for printing or "Save as PDF". Nothing is stored. */
export default function FreightBreakdownPrintPage() {
  const { id } = useParams()
  const company = useCompany()
  const [b, setB] = useState<Breakdown | null>(null)
  const [orderCode, setOrderCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase || !id) return
    supabase
      .from('freight_breakdowns')
      .select('*')
      .eq('id', id)
      .maybeSingle()
      .then(async ({ data }) => {
        if (!data) return setError('That cost breakdown could not be found.')
        setB(data as Breakdown)
        if (data.order_id) {
          const { data: o } = await supabase!.from('order_summary').select('order_code').eq('id', data.order_id).maybeSingle()
          setOrderCode((o?.order_code as string | undefined) ?? null)
        }
      })
  }, [id])

  const money = (n: number) => formatMoney(Number(n), b?.currency ?? 'CAD')
  const details: [string, string | null | undefined][] = b
    ? [
        ['Customer', b.customer_name],
        ['Order #', orderCode],
        ['Quote #', b.quote_number],
        ['Invoice #', b.invoice_number],
        ['Ship date (picked up)', b.ship_date ? showDate(b.ship_date) : null],
        ['Freight type', b.freight_type],
        ['Shipping agent', b.agent_name],
        ['Agent ref #', b.agent_ref],
        ['Sub-contractor carrier', b.sub_contractor],
        ['Carrier', b.carrier],
        ['Carrier tracking number', b.tracking_number],
        ['Currency', b.currency === 'USD' ? `USD (exchange rate ${Number(b.exchange_rate)} to CAD)` : 'CAD'],
      ]
    : []
  const line = (label: string, value: number, strong = false, note?: string) => (
    <tr className={strong ? 'font-semibold' : ''}>
      <td className="border-b border-slate-200 py-1.5 pr-4">
        {label}
        {note && <span className="block text-xs font-normal text-slate-600">{note}</span>}
      </td>
      <td className="border-b border-slate-200 py-1.5 text-right whitespace-nowrap tabular-nums">{money(value)}</td>
    </tr>
  )

  return (
    <Can permission="freight.breakdowns.print">
      <div className="keep-light mx-auto min-h-full max-w-3xl bg-white p-4 text-slate-900 sm:p-6 print:max-w-none print:p-0">
        <div className="mb-4 flex justify-end gap-2 print:hidden">
          <Link to={`/freight/breakdowns/${id}`} className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
            ← Back to the Cost Breakdown
          </Link>
          <button type="button" onClick={() => window.print()} disabled={!b} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
            Print or Save as PDF
          </button>
        </div>
        {error && <p className="text-red-700">{error}</p>}
        {!error && !b && <p className="text-slate-500">Loading…</p>}
        {b && (
          <article className="text-sm">
            <header className="flex items-start justify-between gap-6 border-b-2 border-slate-900 pb-3">
              <div>
                <div className="text-xl font-bold">{company.name}</div>
                {company.address && <div className="whitespace-pre-line text-slate-700">{company.address}</div>}
                <div className="text-slate-700">{[company.phone, company.email, company.website].filter(Boolean).join(' · ')}</div>
              </div>
              {company.logo && <img src={company.logo} alt="" className="max-h-16" />}
            </header>

            <h1 className="mt-4 text-2xl font-bold">Shipment Cost Breakdown – {b.freight_type}</h1>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 print:grid-cols-3">
              {details
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-slate-500">{k}</dt>
                    <dd className="font-medium break-words">{v}</dd>
                  </div>
                ))}
            </dl>

            <table className="mt-5 w-full border-collapse text-left">
              <tbody>
                {line('Total amount on invoice', b.invoice_total, true, b.currency === 'USD' ? `${formatMoney(Number(b.invoice_total_cad), 'CAD')} in CAD` : undefined)}
                {line('Cargo value', b.cargo_value)}
                {line('Freight (per carrier’s quote)', b.freight)}
                {line('Insurance', b.insurance)}
                {line('Broker fees', b.broker_fees)}
                {line('Handling', b.handling, false, handlingText(b) || undefined)}
                {line('Subtotal', b.subtotal, true)}
                {line('Freight subtotal (without cargo value)', b.freight_subtotal)}
                {line('Total breakdown cost', b.breakdown_total, true, b.currency === 'USD' ? `${formatMoney(Number(b.breakdown_total_cad), 'CAD')} in CAD` : undefined)}
                {line(`Total with margin (${Number(b.margin_pct)}%)`, b.total_with_margin, true)}
                {line(`Freight subtotal with margin (${Number(b.margin_pct)}%)`, b.freight_with_margin)}
              </tbody>
            </table>

            <div className="mt-4 flex items-center justify-between gap-4 border-2 border-slate-900 px-3 py-2 text-base font-bold">
              <span>Price difference (invoice − breakdown cost): {Number(b.price_difference) >= 0 ? 'profit' : 'loss'}</span>
              <span className="tabular-nums">{money(b.price_difference)}</span>
            </div>
            {b.notes && <p className="mt-4 whitespace-pre-line">Notes: {b.notes}</p>}
            <p className="mt-6 text-xs text-slate-500">
              Printed {showDate(todayISO())}
              {b.updated_by_name ? ` · last saved by ${b.updated_by_name}` : ''}
            </p>
          </article>
        )}
      </div>
    </Can>
  )
}
