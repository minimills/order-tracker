import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Can from '../components/Can'
import RichText from '../components/RichText'
import { useCompany } from '../lib/company'
import { showDate } from '../lib/dates'
import { PRIORITY, showDay, type Notice } from '../lib/notices'
import { supabase } from '../lib/supabase'
import { ACTION } from '../lib/wording'

/**
 * One notice laid out for printing on a single page with the company
 * letterhead (for the shop wall). Made from the saved notice each time.
 */
export default function NoticePrintPage() {
  const { id } = useParams()
  const company = useCompany()
  const [notice, setNotice] = useState<Notice | null | undefined>(undefined)

  useEffect(() => {
    supabase
      ?.from('notices')
      .select('id, title, body, body_text, colour, category, priority, audience_everyone, show_from, show_until, pinned, comments_enabled, author_email, author_name, edited_at, edited_by, archived, archived_at, created_at')
      .eq('id', id!)
      .maybeSingle()
      .then(({ data }) => setNotice((data as Notice | null) ?? null))
  }, [id])

  return (
    <Can permission="notices.print">
      {/* One page: letter size with even margins; the screen buttons are not printed. */}
      <style>{'@page { size: letter; margin: 16mm; } @media print { html, body { background: #fff; } }'}</style>
      <div className="mx-auto min-h-full max-w-3xl bg-white p-6 text-slate-900 print:max-w-none print:p-0">
        <div className="mb-4 flex justify-end gap-2 print:hidden">
          <Link to={`/notices?notice=${id}`} className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
            Back to the Notice Board
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!notice}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {ACTION.print}
          </button>
        </div>

        {notice === undefined && <p className="text-slate-500">Loading…</p>}
        {notice === null && <p className="rounded-md bg-amber-50 p-4 text-amber-900">This notice could not be found, or it is not posted for you.</p>}
        {notice && (
          <article className="flex min-h-[calc(100vh-3rem)] flex-col break-inside-avoid print:min-h-0">
            <header className="flex items-start justify-between gap-6 border-b-2 border-slate-900 pb-3 text-sm">
              <div>
                <div className="text-xl font-bold">{company.name}</div>
                {company.address && <div className="whitespace-pre-line text-slate-700">{company.address}</div>}
                <div className="text-slate-700">{[company.phone, company.email, company.website].filter(Boolean).join(' · ')}</div>
              </div>
              {company.logo && <img src={company.logo} alt="" className="max-h-16" />}
            </header>

            <div className="mt-8 flex flex-wrap items-center gap-2 text-sm font-semibold uppercase tracking-wider">
              <span>Notice</span>
              {notice.priority !== 'normal' && (
                <span className={`rounded px-2 py-0.5 ${notice.priority === 'urgent' ? 'border-2 border-red-700 text-red-700' : 'border-2 border-slate-800'}`}>
                  {PRIORITY[notice.priority].label}
                </span>
              )}
              {notice.category && <span className="text-slate-600">· {notice.category}</span>}
            </div>
            <h1 className="mt-3 text-4xl font-bold leading-tight">{notice.title}</h1>
            <div className="mt-6 text-lg leading-relaxed [&_.rich-text]:text-lg">
              <RichText value={notice.body || null} />
            </div>

            <footer className="mt-auto border-t border-slate-300 pt-3 text-sm text-slate-600">
              Posted by {notice.author_name ?? 'the office'} on {showDay(notice.created_at)}
              {notice.edited_at && ` · updated ${showDay(notice.edited_at)}`}
              {notice.show_until && ` · valid until ${showDate(notice.show_until, 'MMMM d, yyyy')}`}
            </footer>
          </article>
        )}
      </div>
    </Can>
  )
}
