import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { buttonClass, secondaryButtonClass } from '../components/form'
import { dueText } from '../components/payments/dueText'
import PaymentStatus from '../components/payments/PaymentStatus'
import ReceivePaymentDialog from '../components/payments/ReceivePaymentDialog'
import { countryFlag } from '../lib/country'
import { showDate } from '../lib/dates'
import { fetchAll } from '../lib/fetchAll'
import { formatMoney, friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { PaymentRow } from '../lib/types'

type GroupKey = 'overdue' | 'week' | 'later'

const GROUPS: { key: GroupKey; title: string; tone: string }[] = [
  { key: 'overdue', title: 'Overdue', tone: 'border-red-300 bg-red-50 text-red-900' },
  { key: 'week', title: 'Due this week', tone: 'border-amber-300 bg-amber-50 text-amber-900' },
  { key: 'later', title: 'Later', tone: 'border-slate-200 bg-white text-slate-900' },
]

function groupOf(p: PaymentRow): GroupKey {
  if (p.days_until_due === null) return 'later'
  if (p.days_until_due < 0) return 'overdue'
  if (p.days_until_due <= 7) return 'week'
  return 'later'
}

/** {CAD: 1200, USD: 300} -> "CAD 1,200.00 · USD 300.00" */
function totalsText(rows: PaymentRow[]) {
  const sums: Record<string, number> = {}
  for (const p of rows) sums[p.currency] = (sums[p.currency] ?? 0) + Number(p.remaining)
  const parts = Object.entries(sums)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cur, n]) => formatMoney(n, cur))
  return parts.length ? parts.join(' · ') : '—'
}

/** Every payment still owed, across all orders, soonest first. */
export default function PaymentsPage() {
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [receiving, setReceiving] = useState<PaymentRow | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await fetchAll<PaymentRow>(() =>
      supabase!
        .from('payment_overview')
        .select('*')
        .gt('remaining', 0)
        .eq('order_archived', false)
        .neq('stage', 'Cancelled')
        .order('due_date', { nullsFirst: false })
        .order('order_number')
        .order('id'),
    )
    if (error) toast.error(friendlyError(error))
    setRows(data)
    setLoading(false)
  }, [])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const grouped = useMemo(() => {
    const g: Record<GroupKey, PaymentRow[]> = { overdue: [], week: [], later: [] }
    for (const p of rows) g[groupOf(p)].push(p)
    return g
  }, [rows])

  return (
    <Can permission="payments.page">
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Payments</h1>
          <p className="text-sm text-slate-600">
            Every payment still owed, soonest first. Cancelled and archived orders are left out.
          </p>
        </div>
        <Can permission="payments.page.refresh">
          <button type="button" className={secondaryButtonClass} onClick={load}>
            Refresh
          </button>
        </Can>
      </div>

      {/* Totals at a glance */}
      <div className="grid gap-3 sm:grid-cols-3">
        {GROUPS.map((g) => (
          <a key={g.key} href={`#group-${g.key}`} onClick={(e) => {
            e.preventDefault()
            document.getElementById(`group-${g.key}`)?.scrollIntoView({ behavior: 'smooth' })
          }} className={`rounded-lg border p-4 ${g.tone}`}>
            <div className="text-sm font-medium">
              {g.title} <span className="font-normal opacity-70">({grouped[g.key].length})</span>
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{totalsText(grouped[g.key])}</div>
          </a>
        ))}
      </div>
      <p className="text-sm text-slate-600">
        Total still owed: <strong>{totalsText(rows)}</strong>
      </p>

      {loading && <p className="text-center text-slate-500">Loading…</p>}
      {!loading && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
          Nothing is owed right now. 🎉
        </div>
      )}

      {!loading &&
        GROUPS.map((g) =>
          grouped[g.key].length === 0 ? null : (
            <section key={g.key} id={`group-${g.key}`} className="scroll-mt-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  {g.title} <span className="text-sm font-normal text-slate-500">({grouped[g.key].length})</span>
                </h2>
                <span className="text-sm font-medium tabular-nums">{totalsText(grouped[g.key])}</span>
              </div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                {grouped[g.key].map((p) => (
                  <li
                    key={p.id}
                    className="grid gap-x-4 gap-y-2 px-4 py-3 text-sm md:grid-cols-[8.5rem_minmax(0,1fr)_auto_auto_auto] md:items-center"
                  >
                    <div>
                      <div className="font-medium">{showDate(p.due_date)}</div>
                      <div className="text-xs text-slate-500">{p.due_date ? dueText(p) : 'No due date'}</div>
                    </div>
                    <div className="min-w-0">
                      <Can permission="order.page" fallback={<span className="font-medium">Order {p.order_code}</span>}>
                        <Link to={`/orders/${p.order_id}`} className="font-medium hover:underline">
                          Order {p.order_code}
                        </Link>
                      </Can>{' '}
                      <span className="text-slate-500">· {p.payment_type}</span>
                      <div className="truncate text-slate-600">
                        {p.customer_name}
                        {p.customer_company && <> · {p.customer_company}</>}
                        {p.customer_country && (
                          <span className="text-slate-500">
                            {' '}
                            · {countryFlag(p.customer_country)} {p.customer_country}
                          </span>
                        )}
                      </div>
                      {p.stage === 'Quote' && <div className="text-xs text-slate-500">Order is still a quote</div>}
                    </div>
                    <div className="tabular-nums md:text-right">
                      <div className="font-semibold">{formatMoney(p.remaining, p.currency)}</div>
                      {p.received_amount > 0 && (
                        <div className="text-xs text-slate-500">
                          of {formatMoney(p.amount, p.currency)} ({formatMoney(p.received_amount, p.currency)} received)
                        </div>
                      )}
                    </div>
                    <div>
                      <PaymentStatus payment={p} />
                    </div>
                    <div className="md:text-right">
                      <Can permission="payments.action.mark_received" level="edit">
                        <button type="button" className={buttonClass} onClick={() => setReceiving(p)}>
                          Mark received
                        </button>
                      </Can>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}

      {receiving && (
        <ReceivePaymentDialog
          payment={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            toast.success(`Order ${receiving.order_code}: ${receiving.payment_type} marked received.`)
            setReceiving(null)
            load()
          }}
        />
      )}
    </div>
    </Can>
  )
}
