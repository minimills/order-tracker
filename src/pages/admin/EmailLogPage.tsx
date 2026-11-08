// @permission-scope admin.email_log
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import Can from '../../components/Can'
import { narrowInputClass, secondaryButtonClass } from '../../components/form'
import { activityTime } from '../../lib/activity'
import { confirmAction } from '../../lib/confirm'
import { callFunction } from '../../lib/edgeFunction'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type LogRow = {
  id: string
  to_email: string
  subject: string
  html: string | null
  kind: 'notification' | 'digest' | 'test' | 'resend'
  status: 'sent' | 'failed'
  error: string | null
  saved_to_sent: boolean | null
  created_at: string
  created_by: string | null
}
const KIND: Record<LogRow['kind'], string> = { notification: 'Notification', digest: 'Daily summary', test: 'Test', resend: 'Resent' }
const PAGE = 100

/** Admin → Email Log: every email sent, with Resend. */
export default function EmailLogPage() {
  const [rows, setRows] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<LogRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    let query = supabase.from('email_log').select('id, to_email, subject, html, kind, status, error, saved_to_sent, created_at, created_by').order('created_at', { ascending: false }).limit(limit)
    if (status) query = query.eq('status', status)
    if (q.trim()) query = query.or(`to_email.ilike.%${q.trim().replace(/[%,()]/g, '')}%,subject.ilike.%${q.trim().replace(/[%,()]/g, '')}%`)
    const { data, error } = await query
    if (error) toast.error(friendlyError(error))
    setRows((data as LogRow[]) ?? [])
    setLoading(false)
  }, [status, q, limit])
  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  async function resend(r: LogRow) {
    if (!(await confirmAction(`Send “${r.subject}” to ${r.to_email} again?`, { confirmLabel: 'Resend' }))) return
    setBusy(r.id)
    const res = await callFunction('send-email', { action: 'resend', id: r.id })
    setBusy(null)
    if (res.ok) toast.success(res.message)
    else toast.error(res.message, { duration: 10000 })
    load()
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <AdminPageHeader title="Email Log">Every email the Order Tracker has sent, newest first.</AdminPageHeader>
      <div className="flex flex-wrap gap-2">
        <input aria-label="Search" className={`${narrowInputClass} w-72`} placeholder="Search by recipient or subject" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" className={`${narrowInputClass} w-40`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-normal">Sent</th>
              <th className="px-3 py-2 font-normal">To</th>
              <th className="px-3 py-2 font-normal">Subject</th>
              <th className="px-3 py-2 font-normal">Type</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap">{activityTime.format(new Date(r.created_at))}</td>
                <td className="px-3 py-2">{r.to_email}</td>
                <td className="px-3 py-2">
                  <button type="button" className="text-left text-blue-700 underline" onClick={() => setOpen(r)}>
                    {r.subject}
                  </button>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{KIND[r.kind]}</td>
                <td className="px-3 py-2">
                  {r.status === 'sent' ? (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800">Sent</span>
                  ) : (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800" title={r.error ?? ''}>
                      Failed
                    </span>
                  )}
                  {r.status === 'failed' && r.error && <div className="mt-0.5 max-w-xs text-xs text-red-700">{r.error}</div>}
                  {r.saved_to_sent === false && <div className="mt-0.5 text-xs text-amber-800">Not saved in Sent folder</div>}
                </td>
                <td className="px-3 py-2">
                  <Can permission="admin.email_log" level="edit">
                    <button type="button" className={secondaryButtonClass} disabled={busy === r.id} onClick={() => resend(r)}>
                      {busy === r.id ? 'Sending…' : 'Resend'}
                    </button>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <p className="p-4 text-sm text-slate-500">No emails match these filters.</p>}
        {loading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
      </div>
      {rows.length === limit && (
        <button type="button" className={secondaryButtonClass} onClick={() => setLimit(limit + PAGE)}>
          Load More
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={open.subject}>
          <div className="flex max-h-[90vh] w-full flex-col rounded-t-lg bg-white shadow-xl sm:max-w-2xl sm:rounded-lg">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
              <div className="text-sm">
                <div className="font-semibold">{open.subject}</div>
                <div className="text-slate-600">
                  To {open.to_email} · {activityTime.format(new Date(open.created_at))}
                </div>
              </div>
              <button type="button" aria-label="Close" className="rounded px-2 text-xl leading-none text-slate-500 hover:bg-slate-100" onClick={() => setOpen(null)}>
                ×
              </button>
            </div>
            {/* The stored email, shown without running anything in it. */}
            <iframe title="Email preview" sandbox="" className="h-[60vh] w-full" srcDoc={open.html ?? ''} />
          </div>
        </div>
      )}
    </div>
  )
}
