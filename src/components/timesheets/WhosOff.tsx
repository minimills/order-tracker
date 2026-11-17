// @permission-scope dashboard.whos_off, notices.whos_off
import { useEffect, useState } from 'react'
import { showDate, todayISO } from '../../lib/dates'
import { supabase } from '../../lib/supabase'
import { showHours, timeOffLabel } from '../../lib/timesheets'
import Icon from '../Icon'

type Off = { employee_id: string; name: string; kind: string | null; start_date: string; end_date: string; back_on: string | null; hours: number | null }

/** Who's off today (approved time off and leave in the timesheets). The reason shows only for people who see the Absence Calendar. */
export default function WhosOff() {
  const [list, setList] = useState<Off[] | null>(null)
  useEffect(() => {
    supabase?.rpc('whos_off', { p_day: todayISO() }).then(({ data }) => setList((data as Off[]) ?? []))
  }, [])
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Who is off today">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
        <Icon name="user" /> Who’s Off Today
      </h2>
      {list === null ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : list.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Everyone is in today.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {list.map((o) => (
            <li key={o.employee_id} className="py-1.5">
              <span className="font-medium">{o.name}</span>
              {o.kind && <span className="text-slate-600"> · {timeOffLabel(o.kind)}</span>}
              {o.hours != null && Number(o.hours) < 7 && <span className="text-slate-600"> · {showHours(Number(o.hours))} hours</span>}
              <div className="text-xs text-slate-500">{o.back_on ? `Back ${showDate(o.back_on, 'EEE, MMM d')}` : ''}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
