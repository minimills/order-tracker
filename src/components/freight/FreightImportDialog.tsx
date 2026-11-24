// @permission-scope freight.breakdowns.import
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { fetchAll } from '../../lib/fetchAll'
import { formatMoney, friendlyError } from '../../lib/format'
import { readImport, type ImportRow } from '../../lib/freight'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import { buttonClass, Modal, secondaryButtonClass } from '../form'
import { tr } from '../../i18n'

type OrderRef = { id: string; order_code: string; invoice_number: string | null; quote_number: string | null; customer_name: string | null }
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Import of the old Freight Multitool data: the Google Sheet saved as CSV.
 * Each row is matched to an order by its invoice #, else its quote #; the
 * match can be changed before importing. Rows imported before are left out.
 */
export default function FreightImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [orders, setOrders] = useState<OrderRef[]>([])
  const [rows, setRows] = useState<ImportRow[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supabase) return
    fetchAll<OrderRef>(() => supabase!.from('order_summary').select('id, order_code, invoice_number, quote_number, customer_name').eq('archived', false).order('id')).then((r) =>
      setOrders(r.data),
    )
  }, [])

  const match = useMemo(
    () => (r: ImportRow) => {
      const byInvoice = orders.filter((o) => same(o.invoice_number, r.invoiceNumber))
      if (byInvoice.length === 1) return byInvoice[0].id
      const byQuote = orders.filter((o) => same(o.quote_number, r.quoteNumber))
      return byQuote.length === 1 ? byQuote[0].id : ''
    },
    [orders],
  )

  async function pick(file: File | undefined) {
    if (!file) return
    setProblem(null)
    setFileName(file.name)
    const { rows: read, missing } = readImport(await file.text())
    if (missing.length) {
      setRows(null)
      return setProblem(
        tr("This file does not look like the Freight Multitool sheet: the columns {{value}} are missing. In Google Sheets choose File → Download → Comma Separated Values (.csv) and keep the first row with the column names.", { value: missing.join(', ') }),
      )
    }
    if (!read.length) {
      setRows(null)
      return setProblem(tr("No records were found in this file."))
    }
    setRows(read.map((r) => ({ ...r, order_id: match(r) })))
  }

  async function run() {
    if (!supabase || !rows) return
    setBusy(true)
    const { data, error } = await supabase.rpc('import_freight_breakdowns', { p_rows: rows.map((r) => ({ ...r, order_id: r.order_id || null })) })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    const res = data as { imported: number; skipped: number; matched: number }
    toast.success(tr("{{imported}} imported ({{matched}} linked to an order){{value}}.", { imported: res.imported, matched: res.matched, value: res.skipped ? tr(", {{skipped}} already imported before and left out", { skipped: res.skipped }) : '' }))
    onDone()
  }

  const linked = rows?.filter((r) => r.order_id).length ?? 0

  return (
    <Modal
      title={tr("Import Freight Multitool Data")}
      onClose={onClose}
      busy={busy}
      wide
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={run} disabled={busy || !rows}>
            {busy ? tr("Importing…") : rows ? tr("Import {{length}} {{value}}", { length: rows.length, value: rows.length === 1 ? tr("Record") : tr("Records") }) : tr("Import")}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-slate-700">
          <li>{tr("Open the Freight Multitool Google Sheet and choose File → Download → Comma Separated Values (.csv).")}</li>
          <li>{tr("Choose that file below. Nothing is saved until you click Import.")}</li>
          <li>{tr("Check which order each record is linked to. Records imported before are left out, so importing the same file twice is safe.")}</li>
        </ol>
        <label className="block">
          <span className="mb-1 block font-medium">{tr("CSV file")}</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {problem && (
          <p className="rounded bg-red-50 p-2 text-red-800" role="alert">
            {problem}
          </p>
        )}
        {rows && (
          <>
            <p className="text-slate-700">
              {fileName}: {rows.length} {rows.length === 1 ? tr("record") : tr("records")}, {linked} {tr("linked to an order,")} {rows.length - linked} {tr("not linked (they are imported without an order and can be linked later). Amounts in the sheet are in CAD.")}
            </p>
            <div className="max-h-80 overflow-auto rounded border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">{tr("Ship date")}</th>
                    <th className="px-2 py-1.5 font-semibold">{tr("Customer")}</th>
                    <th className="px-2 py-1.5 font-semibold">{tr("Invoice #")}</th>
                    <th className="px-2 py-1.5 font-semibold">{tr("Quote #")}</th>
                    <th className="px-2 py-1.5 font-semibold">{tr("Agent")}</th>
                    <th className="px-2 py-1.5 text-right font-semibold">{tr("Invoice total")}</th>
                    <th className="px-2 py-1.5 font-semibold">{tr("Order")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <tr key={i} className={r.order_id ? '' : 'bg-amber-50'}>
                      <td className="px-2 py-1 whitespace-nowrap">{r.shipDate || '—'}</td>
                      <td className="px-2 py-1">{r.customerName || '—'}</td>
                      <td className="px-2 py-1">{r.invoiceNumber || '—'}</td>
                      <td className="px-2 py-1">{r.quoteNumber || '—'}</td>
                      <td className="px-2 py-1">{r.carrier || '—'}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{formatMoney(Number(r.invoiceTotal) || 0, 'CAD')}</td>
                      <td className="px-2 py-1">
                        <select
                          aria-label={tr("Order for {{value}} {{value2}}", { value: r.customerName || 'record', value2: r.invoiceNumber || '' })}
                          className="w-44 rounded border border-slate-300 bg-white px-1 py-0.5"
                          value={r.order_id ?? ''}
                          onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, order_id: e.target.value } : x)))}
                        >
                          <option value="">{tr("Not linked")}</option>
                          {orders.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.order_code} · {o.customer_name ?? ''}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
