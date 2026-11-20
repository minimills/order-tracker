// @permission-scope service.summary
/* Drawn only inside <Can permission="service.summary"> on the Service / Training page; the database checks it again (service_day_summary). */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { narrowInputClass } from '../form'
import { showDate, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Summary = {
  today: string
  travel_done: number
  travel_scheduled: number
  training_done: number
  training_scheduled: number
  training_unscheduled: number
  calls_done: number
  calls_scheduled: number
}

const days = (n: number) => {
  const v = Math.round(Number(n) * 10) / 10
  return `${v.toLocaleString('en-CA')} day${v === 1 ? '' : 's'}`
}

/** Travel, on-site training and service call days: so far (logged) and scheduled (planned from tomorrow), for the dates chosen. */
export default function ServiceSummary() {
  const [params, setParams] = useSearchParams()
  const year = todayISO().slice(0, 4)
  const from = params.get('sfrom') || `${year}-01-01`
  const to = params.get('sto') || `${year}-12-31`
  const [s, setS] = useState<Summary | null>(null)

  useEffect(() => {
    if (!supabase || !from || !to || to < from) return
    let off = false
    supabase.rpc('service_day_summary', { p_from: from, p_to: to }).then(({ data, error }) => {
      if (off) return
      if (error) return toast.error(friendlyError(error))
      setS(data as Summary)
    })
    return () => {
      off = true
    }
  }, [from, to])

  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace: true },
    )

  const boxes: { title: string; done: number; scheduled: number; note: string; extra?: string }[] = s
    ? [
        { title: 'Travel Days', done: s.travel_done, scheduled: s.travel_scheduled, note: 'Logged travel days; scheduled = travel entries on the calendar and the travel days of upcoming training visits.' },
        {
          title: 'On-site Training Days',
          done: s.training_done,
          scheduled: s.training_scheduled,
          note: 'Logged on-site days on training orders; scheduled = days of training visits not marked as done.',
          extra: s.training_unscheduled ? `${s.training_unscheduled} training order${s.training_unscheduled === 1 ? ' has' : 's have'} no dates yet.` : undefined,
        },
        { title: 'Service Call Days', done: s.calls_done, scheduled: s.calls_scheduled, note: 'Logged on-site days on service calls; scheduled = planned days of calls not done.' },
      ]
    : []

  return (
    <section aria-label="Summary" className="space-y-2" data-print-section="Summary">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">From</span>
          <input type="date" aria-label="Summary from" className={`${narrowInputClass} w-40`} value={from} onChange={(e) => set('sfrom', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-600">To</span>
          <input type="date" aria-label="Summary to" className={`${narrowInputClass} w-40`} value={to} min={from} onChange={(e) => set('sto', e.target.value)} />
        </label>
        {(params.get('sfrom') || params.get('sto')) && (
          <button
            type="button"
            className="pb-2 text-xs text-slate-600 underline"
            onClick={() => {
              set('sfrom', '')
              set('sto', '')
            }}
          >
            This Year
          </button>
        )}
        <span className="pb-2 text-xs text-slate-500">
          So far = up to today ({showDate(todayISO())}); scheduled = from tomorrow to {showDate(to)}.
        </span>
      </div>
      {to < from ? (
        <p className="text-sm text-slate-500">The end date must be on or after the start date.</p>
      ) : !s ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
          {boxes.map((b) => (
            <div key={b.title} className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-slate-700">{b.title}</h3>
              <dl className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <dt className="text-xs text-slate-500">So far</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{days(b.done)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Scheduled</dt>
                  <dd className="text-2xl font-semibold tabular-nums text-blue-800">{days(b.scheduled)}</dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-slate-500">{b.note}</p>
              {b.extra && <p className="mt-1 text-xs text-amber-800">{b.extra}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
