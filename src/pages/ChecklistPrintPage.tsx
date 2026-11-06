import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Can from '../components/Can'
import RichText from '../components/RichText'
import { groupBySection, showDateTime, signatureUrl, type Checklist, type ChecklistItem, type ChecklistStatusRow } from '../lib/checklists'
import { useCompany } from '../lib/company'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { stageLabel } from '../lib/stages'
import { supabase } from '../lib/supabase'

type OrderInfo = { order_code: string; customer_name: string; customer_company: string | null; customer_country: string | null; stage: string }

/**
 * A signed final check, laid out for printing or "Save as PDF", with the
 * company letterhead. Made from the saved data each time (no file is stored).
 */
export default function ChecklistPrintPage() {
  const { machineId } = useParams()
  const company = useCompany()
  const [status, setStatus] = useState<ChecklistStatusRow | null>(null)
  const [order, setOrder] = useState<OrderInfo | null>(null)
  const [checklist, setChecklist] = useState<Checklist | null>(null)
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [sig, setSig] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase || !machineId) return
    let cancelled = false
    ;(async () => {
      const s = await supabase!.from('machine_checklist_status').select('*').eq('machine_id', machineId).maybeSingle()
      const st = s.data as ChecklistStatusRow | null
      if (!st) {
        if (!cancelled) setError(s.error ? friendlyError(s.error) : 'This machine could not be found.')
        return
      }
      const [o, c] = await Promise.all([
        supabase!.from('order_summary').select('order_code, customer_name, customer_company, customer_country, stage').eq('id', st.order_id).maybeSingle(),
        supabase!.from('machine_checklists').select('*').eq('machine_id', machineId).maybeSingle(),
      ])
      const cl = c.data as Checklist | null
      const it = cl
        ? await fetchAll<ChecklistItem>(() => supabase!.from('machine_checklist_items').select('*').eq('checklist_id', cl.id).order('sort_order').order('id'))
        : { data: [] as ChecklistItem[] }
      const url = cl?.signature_path ? await signatureUrl(cl.signature_path) : null
      if (cancelled) return
      setStatus(st)
      setOrder(o.data as OrderInfo | null)
      setChecklist(cl)
      setItems(it.data)
      setSig(url)
    })()
    return () => {
      cancelled = true
    }
  }, [machineId])

  const signed = Boolean(checklist?.signed_at)

  return (
    <Can permission="checklist.print">
      <div className="mx-auto min-h-full max-w-4xl bg-white p-6 text-slate-900 print:max-w-none print:p-0">
        <div className="mb-4 flex justify-end gap-2 print:hidden">
          <Link to={`/checklists/${machineId}`} className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
            ← Back to the Final Check
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!signed}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Print or Save as PDF
          </button>
        </div>

        {error && <p className="text-red-700">{error}</p>}
        {!error && !status && <p className="text-slate-500">Loading…</p>}
        {status && !signed && (
          <p className="rounded-md bg-amber-50 p-4 text-amber-900">This final check has not been signed. Only signed final checks can be printed.</p>
        )}

        {status && checklist && signed && (
          <article className="text-sm">
            {/* Letterhead */}
            <header className="flex items-start justify-between gap-6 border-b-2 border-slate-900 pb-3">
              <div>
                <div className="text-xl font-bold">{company.name}</div>
                {company.address && <div className="whitespace-pre-line text-slate-700">{company.address}</div>}
                <div className="text-slate-700">
                  {[company.phone, company.email, company.website].filter(Boolean).join(' · ')}
                </div>
              </div>
              {company.logo && <img src={company.logo} alt="" className="max-h-16" />}
            </header>

            <h1 className="mt-4 text-2xl font-bold">Final Check</h1>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4 print:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Machine</dt>
                <dd className="font-medium">{status.machine_type}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Serial number</dt>
                <dd className="font-mono font-medium">{status.serial_number ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Order</dt>
                <dd className="font-medium">{order?.order_code ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Customer</dt>
                <dd className="font-medium">
                  {order?.customer_name}
                  {order?.customer_company && ` · ${order.customer_company}`}
                  {order?.customer_country && ` · ${order.customer_country}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Started</dt>
                <dd>
                  {showDateTime(checklist.started_at)}
                  {checklist.started_by_name && ` by ${checklist.started_by_name}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Items</dt>
                <dd>
                  {items.filter((i) => i.status === 'done').length} completed · {items.filter((i) => i.status === 'na').length} not applicable ·{' '}
                  {items.length} in total
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Order stage when printed</dt>
                <dd>{order ? stageLabel(order.stage) : '—'}</dd>
              </div>
            </dl>

            <table className="mt-4 w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-400 text-xs text-slate-600">
                  <th className="w-28 py-1">Status</th>
                  <th className="py-1">Item</th>
                  <th className="py-1">Notes</th>
                  <th className="w-44 py-1">By / when</th>
                </tr>
              </thead>
              {groupBySection(items).map(({ section, items: list }) => (
                <tbody key={section} className="break-inside-avoid">
                  <tr>
                    <td colSpan={4} className="bg-slate-100 px-1 py-1 font-semibold print:bg-slate-100">
                      {section}
                    </td>
                  </tr>
                  {list.map((i) => (
                    <tr key={i.id} className="border-b border-slate-200 align-top">
                      <td className="py-1 font-semibold">{i.status === 'done' ? 'Completed' : i.status === 'na' ? 'Not applicable' : 'Open'}</td>
                      <td className="py-1 pr-2">
                        {i.item_text}
                        {i.is_one_off && <span className="text-xs text-slate-500"> (added for this machine)</span>}
                      </td>
                      <td className="py-1 pr-2 text-slate-700">{i.notes}</td>
                      <td className="py-1 text-xs text-slate-600">
                        {i.status_by_name}
                        {i.status_at && <div>{showDateTime(i.status_at)}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>

            {checklist.general_notes && (
              <section className="mt-4 break-inside-avoid">
                <h2 className="font-semibold">General Notes</h2>
                <RichText value={checklist.general_notes} className="text-slate-800" />
              </section>
            )}

            <section className="mt-6 break-inside-avoid border-t-2 border-slate-900 pt-3">
              <h2 className="font-semibold">Sign-Off</h2>
              <div className="mt-2 flex flex-wrap items-end gap-8">
                {sig && <img src={sig} alt={`Signature of ${checklist.signed_name}`} className="h-20" />}
                <div>
                  <div className="font-medium">{checklist.signed_name}</div>
                  <div className="text-slate-600">{showDateTime(checklist.signed_at)}</div>
                  <div className="text-xs text-slate-500">Signed in the app as {checklist.signed_by}</div>
                </div>
              </div>
            </section>
          </article>
        )}
      </div>
    </Can>
  )
}
