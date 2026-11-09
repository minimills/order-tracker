import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { narrowInputClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { countryFlag } from '../lib/country'
import { todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { loadServiceInfo, needsService, serviceDates, serviceState, useOutbox, type ServiceInfo, type ServiceState } from '../lib/service'

const LISTS: { state: ServiceState; title: string; permission: string; empty: string }[] = [
  { state: 'in_progress', title: 'In Progress', permission: 'service.list.in_progress', empty: 'No training is in progress.' },
  { state: 'upcoming', title: 'Upcoming', permission: 'service.list.upcoming', empty: 'No training is planned.' },
  { state: 'completed', title: 'Completed', permission: 'service.list.completed', empty: 'No training has been completed yet.' },
]

/** Service: on-site training and commissioning, one row per order. */
export default function ServicePage() {
  const [rows, setRows] = useState<ServiceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const mine = params.get('mine') === '1'
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const today = todayISO()
  const { items: waiting } = useOutbox()

  useEffect(() => {
    loadServiceInfo().then(({ data, error }) => {
      if (error) toast.error(friendlyError(error))
      setRows(data.filter(needsService))
      setLoading(false)
    })
  }, [])

  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace: true },
    )

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return rows.filter(
      (r) =>
        (!mine || r.technician_email === me) &&
        words.every((w) => [r.order_code, r.customer_name, r.customer_company, r.customer_country, r.technician_name].join(' ').toLowerCase().includes(w)),
    )
  }, [rows, q, mine, me])

  return (
    <Can permission="service">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Service</h1>
            <p className="text-sm text-slate-600">On-site training and commissioning. Open an order to log the days and create the certificate.</p>
          </div>
          <Can permission="service.filters">
            <div className="flex flex-wrap items-center gap-3">
              <input type="search" aria-label="Search" placeholder="Search order, customer, technician" className={`${narrowInputClass} w-64`} value={q} onChange={(e) => set('q', e.target.value)} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={mine} onChange={(e) => set('mine', e.target.checked ? '1' : '')} />
                Only mine
              </label>
            </div>
          </Can>
        </div>

        <Can permission="service.log">
          {waiting.length > 0 && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
              {waiting.length} day {waiting.length === 1 ? 'entry is' : 'entries are'} not yet saved. They are kept on this device and are sent automatically when the connection is back.
            </p>
          )}
        </Can>

        {loading && <p className="text-center text-slate-500">Loading…</p>}
        {!loading &&
          LISTS.map((list) => {
            const items = shown
              .filter((r) => serviceState(r, today) === list.state)
              .sort((a, b) => (list.state === 'completed' ? -1 : 1) * String(a.service_start ?? '9999').localeCompare(String(b.service_start ?? '9999')))
            return (
              <Can key={list.state} permission={list.permission}>
                <section className="rounded-lg border border-slate-200 bg-white">
                  <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">
                    {list.title} <span className="text-sm font-normal text-slate-500">({items.length})</span>
                  </h2>
                  {items.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-500">{list.empty}</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {items.map((r) => (
                        <li key={r.order_id}>
                          <Link to={`/service/${r.order_id}`} className="grid gap-1 px-4 py-3 text-sm hover:bg-slate-50 sm:grid-cols-[6rem_1fr_12rem_10rem] sm:items-center">
                            <span className="font-semibold">Order {r.order_code}</span>
                            <span>
                              {r.customer_name}
                              {r.customer_company ? <span className="text-slate-500"> · {r.customer_company}</span> : null}
                              {r.customer_country ? (
                                <span className="text-slate-500">
                                  {' '}
                                  · {countryFlag(r.customer_country)} {r.customer_country}
                                </span>
                              ) : null}
                            </span>
                            <span className="text-slate-700">{serviceDates(r.service_start, r.service_end) || <span className="text-slate-400">Dates not set</span>}</span>
                            <span className="text-slate-700">{r.technician_name ?? <span className="text-slate-400">No technician</span>}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </Can>
            )
          })}
      </div>
    </Can>
  )
}
