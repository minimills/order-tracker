// @permission-scope notices.holidays
import { Link } from 'react-router-dom'
import { HOLIDAY_KIND, rangeText, useUpcomingHolidays, whenText } from '../../lib/notices'
import Can from '../Can'
import Icon from '../Icon'

/** This year's remaining company and statutory holidays and office closures, with the days remaining. */
export default function HolidaysPanel() {
  const { list, loading } = useUpcomingHolidays(true)
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Upcoming holidays">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
        <Icon name="calendar" /> Upcoming Holidays
      </h2>
      {loading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : list.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No more holidays or closures this year.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {list.map((h) => {
            const when = whenText(h.start_date, h.end_date)
            const soon = when === 'today' || when === 'tomorrow' || when.startsWith('now')
            return (
              <li key={h.id} className="py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-slate-900">{h.name}</span>
                  <span className={`shrink-0 text-xs font-semibold ${soon ? 'text-red-700' : 'text-slate-700'}`}>{when}</span>
                </div>
                <div className="text-xs text-slate-500">
                  {rangeText(h.start_date, h.end_date)} · {HOLIDAY_KIND[h.kind]}
                  {!h.day_off && ' · open as usual'}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <Can permission="admin.holidays" level="edit">
        <Link to="/admin/holidays" className="mt-2 inline-block text-xs text-slate-600 underline">
          Change Company Holidays
        </Link>
      </Can>
    </section>
  )
}
