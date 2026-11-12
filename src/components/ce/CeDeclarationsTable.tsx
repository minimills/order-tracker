// @permission-scope ce, admin.ce, ce.issue
import { useState } from 'react'
import { toast } from 'sonner'
import { activityTime } from '../../lib/activity'
import { downloadDeclarations, printDeclarations, type CeDeclaration, type CeSend } from '../../lib/ce'
import { useCompany } from '../../lib/company'
import { friendlyError } from '../../lib/format'
import Can from '../Can'
import SerialNumber from '../SerialNumber'
import CeEmailDialog from './CeEmailDialog'

const small = 'rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50'

/**
 * Declarations of conformity with a checkbox per row, "Select All", and the same
 * actions for one or for the selected ones: Download (one combined PDF or a ZIP
 * of separate PDFs), Print (one print job) and Email (one email, all attached).
 * Every PDF comes from renderDeclarations() (lib/ce.ts), the one renderer.
 */
export default function CeDeclarationsTable({
  rows,
  sends = [],
  showOrder = false,
  initiallySelected = [],
  onSent,
}: {
  rows: CeDeclaration[]
  sends?: CeSend[]
  showOrder?: boolean
  initiallySelected?: string[]
  onSent?: () => void
}) {
  const company = useCompany()
  const [selected, setSelected] = useState<Set<string>>(new Set(initiallySelected))
  const [mode, setMode] = useState<'combined' | 'zip'>('combined')
  const [emailing, setEmailing] = useState<CeDeclaration[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const chosen = rows.filter((r) => selected.has(r.id))
  const allOn = rows.length > 0 && chosen.length === rows.length
  const oneOrder = new Set(chosen.map((r) => r.order_id)).size === 1
  const sendsOf = (id: string) => sends.filter((s) => s.declaration_ids.includes(id))

  async function act(list: CeDeclaration[], action: 'download' | 'print', how: 'combined' | 'zip' = 'combined') {
    setBusy(action)
    try {
      if (action === 'print') await printDeclarations(list, company.logo)
      else await downloadDeclarations(list, company.logo, how)
    } catch (e) {
      toast.error(friendlyError(e as Error))
    } finally {
      setBusy(null)
    }
  }

  if (rows.length === 0) return <p className="text-sm text-slate-500">No declarations of conformity here yet.</p>

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={allOn}
            onChange={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))}
          />
          Select All
        </label>
        <span className="text-xs text-slate-500">{chosen.length ? `${chosen.length} selected` : 'Select declarations to act on several at once.'}</span>
        {chosen.length > 0 && (
          <>
            <select aria-label="Download as" className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs" value={mode} onChange={(e) => setMode(e.target.value as 'combined' | 'zip')}>
              <option value="combined">One combined PDF</option>
              <option value="zip">ZIP of separate PDFs</option>
            </select>
            <button type="button" className={small} disabled={busy !== null} onClick={() => act(chosen, 'download', mode)}>
              {busy === 'download' ? 'Preparing…' : `Download ${chosen.length}`}
            </button>
            <button type="button" className={small} disabled={busy !== null} onClick={() => act(chosen, 'print')}>
              {busy === 'print' ? 'Preparing…' : `Print ${chosen.length}`}
            </button>
            <Can permission="ce.email" level="edit">
              <button
                type="button"
                className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                disabled={!oneOrder}
                title={oneOrder ? undefined : 'Email the declarations of one order at a time.'}
                onClick={() => setEmailing(chosen)}
              >
                Email {chosen.length}
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
              <th className="w-8 px-2 py-1.5 font-normal">
                <span className="sr-only">Select</span>
              </th>
              <th className="px-2 py-1.5 font-normal">Machine</th>
              <th className="px-2 py-1.5 font-normal">Declaration</th>
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
                  <div className="font-medium">{r.data.machine.type_name}</div>
                  <div className="text-xs text-slate-600">
                    Model {r.data.machine.model} · serial {r.data.machine.serial}
                  </div>
                  {r.data.machine.serial_number && <SerialNumber serial={r.data.machine.serial_number} className="text-xs" />}
                  {showOrder && (
                    <div className="text-xs text-slate-500">
                      Order {r.data.order_code} · {r.data.customer_company || r.data.customer_name}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 align-top">
                  <div className="font-mono text-xs font-semibold whitespace-nowrap">{r.number}</div>
                  <div className="text-xs">
                    {r.status === 'superseded' ? <span className="rounded bg-slate-100 px-1">Replaced by a newer version</span> : <span className="rounded bg-green-50 px-1 text-green-800">Issued</span>}{' '}
                    {r.kind === 'eu_2023' ? 'EU' : 'EC'}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">{r.data.directives.length} directive{r.data.directives.length === 1 ? '' : 's'}</div>
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
                <td className="px-2 py-1.5 align-top">
                  <div className="flex flex-col items-end gap-1 text-xs whitespace-nowrap">
                    <button type="button" className="underline" disabled={busy !== null} onClick={() => act([r], 'download')}>
                      Download
                    </button>
                    <button type="button" className="underline" disabled={busy !== null} onClick={() => act([r], 'print')}>
                      Print
                    </button>
                    <Can permission="ce.email" level="edit">
                      <button type="button" className="underline" onClick={() => setEmailing([r])}>
                        Email
                      </button>
                    </Can>
                  </div>
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
              onSent?.()
            }}
          />
        </Can>
      )}
    </div>
  )
}
