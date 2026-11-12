// @permission-scope ce, admin.ce
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { activityTime } from '../../lib/activity'
import { declarationPdfs, printPdf, type CeDeclaration, type CeSend } from '../../lib/ce'
import { downloadPdf } from '../../lib/certificatePdf'
import { useCompany } from '../../lib/company'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import SerialNumber from '../SerialNumber'
import CeEmailDialog from './CeEmailDialog'

/**
 * The register of declarations of conformity for an order, a machine or (Admin)
 * all orders: number, machine, version, who issued it and when, who it was sent
 * to, with Download PDF / Print and Email for the selected ones.
 */
export default function CeRegister({ orderId, machineId, refreshKey = 0, limit = 500 }: { orderId?: string; machineId?: string; refreshKey?: number; limit?: number }) {
  const company = useCompany()
  const [rows, setRows] = useState<CeDeclaration[] | null>(null)
  const [sends, setSends] = useState<CeSend[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [emailing, setEmailing] = useState<CeDeclaration[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    let q = supabase.from('ce_declarations').select('*').order('issued_at', { ascending: false }).limit(limit)
    if (orderId) q = q.eq('order_id', orderId)
    if (machineId) q = q.eq('machine_id', machineId)
    const { data, error } = await q
    if (error) toast.error(friendlyError(error))
    const list = (data as CeDeclaration[]) ?? []
    setRows(list)
    const orderIds = [...new Set(list.map((d) => d.order_id))]
    const s = orderIds.length ? await supabase.from('ce_declaration_sends').select('*').in('order_id', orderIds).order('sent_at', { ascending: false }) : { data: [] }
    setSends((s.data as CeSend[]) ?? [])
  }, [orderId, machineId, limit])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load, refreshKey])

  async function pdf(list: CeDeclaration[], action: 'download' | 'print') {
    setBusy(action)
    try {
      const files = await declarationPdfs(list, company.logo, true)
      if (action === 'print') printPdf(files[0].bytes)
      else downloadPdf(files[0].bytes, files[0].file_name)
    } catch (e) {
      toast.error(friendlyError(e as Error))
    } finally {
      setBusy(null)
    }
  }

  if (!rows) return <p className="text-sm text-slate-500">Loading…</p>
  if (rows.length === 0) return <p className="text-sm text-slate-500">No declarations of conformity have been issued yet.</p>
  const chosen = rows.filter((r) => selected.has(r.id))
  const sendsOf = (id: string) => sends.filter((s) => s.declaration_ids.includes(id))
  // Email: the selected issued declarations of ONE order.
  const sameOrder = new Set(chosen.map((r) => r.order_id)).size === 1

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">{chosen.length ? `${chosen.length} selected` : 'Select declarations to download, print or email them together.'}</span>
        {chosen.length > 0 && (
          <>
            <button type="button" className="rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50" disabled={busy !== null} onClick={() => pdf(chosen, 'download')}>
              Download PDF
            </button>
            <button type="button" className="rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50" disabled={busy !== null} onClick={() => pdf(chosen, 'print')}>
              Print
            </button>
            <Can permission="ce.email" level="edit">
              <button
                type="button"
                className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                disabled={!sameOrder}
                title={sameOrder ? undefined : 'Email the declarations of one order at a time.'}
                onClick={() => setEmailing(chosen)}
              >
                Email
              </button>
            </Can>
            <button type="button" className="text-xs underline" onClick={() => setSelected(new Set())}>
              Clear Selection
            </button>
          </>
        )}
      </div>
      <div className="relative overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-2 py-1.5 font-normal">
                <span className="sr-only">Select</span>
              </th>
              <th className="px-2 py-1.5 font-normal">Number</th>
              <th className="px-2 py-1.5 font-normal">Machine</th>
              <th className="px-2 py-1.5 font-normal">Issued</th>
              <th className="px-2 py-1.5 font-normal">Sent to</th>
              <th className="px-2 py-1.5 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'superseded' ? 'text-slate-500' : ''}>
                <td className="px-2 py-1.5 align-top">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    aria-label={`Select ${r.number}`}
                    checked={selected.has(r.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s)
                        if (n.has(r.id)) n.delete(r.id)
                        else n.add(r.id)
                        return n
                      })
                    }
                  />
                </td>
                <td className="px-2 py-1.5 align-top">
                  <div className="font-mono text-xs font-semibold whitespace-nowrap">{r.number}</div>
                  <div className="text-xs">
                    {r.status === 'superseded' ? <span className="rounded bg-slate-100 px-1">Replaced by a newer version</span> : <span className="rounded bg-green-50 px-1 text-green-800">Issued</span>}{' '}
                    {r.kind === 'eu_2023' ? 'EU' : 'EC'}
                  </div>
                </td>
                <td className="px-2 py-1.5 align-top">
                  <div>{r.data.machine.type_name}</div>
                  {r.data.machine.serial_number && <SerialNumber serial={r.data.machine.serial_number} className="text-xs" />}
                  {!orderId && <div className="text-xs text-slate-500">Order {r.data.order_code} · {r.data.customer_company || r.data.customer_name}</div>}
                </td>
                <td className="px-2 py-1.5 align-top text-xs">
                  {activityTime.format(new Date(r.issued_at))}
                  <div>by {r.issued_by_name ?? '—'}</div>
                  <div className="text-slate-500">{r.signature_source === 'saved' ? `Saved signature, version ${r.signature_version ?? '?'}` : 'Drawn signature'}</div>
                </td>
                <td className="px-2 py-1.5 align-top text-xs">
                  {sendsOf(r.id).length === 0 ? (
                    <span className="text-slate-400">Not sent</span>
                  ) : (
                    sendsOf(r.id).map((s) => (
                      <div key={s.id} className={s.status === 'failed' ? 'text-red-700' : ''}>
                        {activityTime.format(new Date(s.sent_at))}: {[...s.to_emails, ...s.cc_emails].join(', ')}
                        {s.bcc_emails.length > 0 && ` (+${s.bcc_emails.length} BCC)`}
                        {s.status === 'failed' && ' – not sent'}
                      </div>
                    ))
                  )}
                </td>
                <td className="px-2 py-1.5 text-right align-top whitespace-nowrap">
                  <button type="button" className="text-xs underline" disabled={busy !== null} onClick={() => pdf([r], 'download')}>
                    Download PDF
                  </button>{' '}
                  <button type="button" className="ml-2 text-xs underline" disabled={busy !== null} onClick={() => pdf([r], 'print')}>
                    Print
                  </button>
                  <Can permission="ce.email" level="edit">
                    <button type="button" className="ml-2 text-xs underline" onClick={() => setEmailing([r])}>
                      Email
                    </button>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {emailing && (
        <Can permission="ce.email" level="edit">
          <CeEmailDialog
            declarations={emailing}
            onClose={() => setEmailing(null)}
            onSent={() => {
              setEmailing(null)
              setSelected(new Set())
              load()
            }}
          />
        </Can>
      )}
    </div>
  )
}
