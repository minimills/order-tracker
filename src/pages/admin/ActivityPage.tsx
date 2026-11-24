// @permission-scope admin.activity
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { activityTime, activityWho, describeActivity, type ActivityEntry } from '../../lib/activity'
import { addDaysISO, todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import Can from '../../components/Can'
import PrintButton from '../../components/print/PrintButton'
import { tr } from '../../i18n'

type Entry = ActivityEntry & { order_id: string | null }

const PAGE = 100
const AREAS: { value: string; label: string }[] = [
  { value: '', get label() {
    return tr("Everything")
  } },
  { value: 'orders', get label() {
    return tr("Orders")
  } },
  { value: 'order_machines', get label() {
    return tr("Machines")
  } },
  { value: 'payments', get label() {
    return tr("Payments")
  } },
  { value: 'customers', get label() {
    return tr("Customers")
  } },
  { value: 'machine_types', get label() {
    return tr("Machine types")
  } },
  { value: 'option_lists', get label() {
    return tr("Dropdown lists")
  } },
  { value: 'allowed_users', get label() {
    return tr("Users")
  } },
  { value: 'departments', get label() {
    return tr("Departments")
  } },
  { value: 'user_departments', get label() {
    return tr("Department memberships")
  } },
  { value: 'app_settings', get label() {
    return tr("Settings")
  } },
]

/** Midnight at the start of a day in Halifax, for example "2026-11-03T00:00:00-04:00". */
function halifaxStart(iso: string) {
  // Ask the browser for Halifax's UTC offset at noon that day (handles summer time).
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Halifax', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${iso}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value
  const offset = part?.replace('GMT', '') || '-04:00'
  return `${iso}T00:00:00${offset}`
}

export default function ActivityPage() {
  const [people, setPeople] = useState<string[]>([])
  const [typeNames, setTypeNames] = useState(new Map<string, string>())
  const [person, setPerson] = useState('')
  const [orderCode, setOrderCode] = useState('')
  const [area, setArea] = useState('')
  const [department, setDepartment] = useState('')
  const [departmentNames, setDepartmentNames] = useState<string[]>([])
  const [from, setFrom] = useState(addDaysISO(todayISO(), -30))
  const [to, setTo] = useState(todayISO())
  const [entries, setEntries] = useState<Entry[]>([])
  const [orderCodes, setOrderCodes] = useState(new Map<string, string>())
  const [loading, setLoading] = useState(false)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('allowed_users')
      .select('email')
      .order('email')
      .then(({ data }) => setPeople(((data as { email: string }[]) ?? []).map((u) => u.email)))
    Promise.all([supabase.from('machine_types').select('id, name'), supabase.from('departments').select('id, name, sort_order').order('sort_order')]).then(
      ([t, d]) => {
        const depts = (d.data as { id: string; name: string }[]) ?? []
        setDepartmentNames(depts.map((x) => x.name))
        setTypeNames(new Map([...((t.data as { id: string; name: string }[]) ?? []), ...depts].map((x) => [x.id, x.name])))
      },
    )
  }, [])

  const search = useCallback(
    async (offset: number) => {
      if (!supabase) return
      setLoading(true)
      setError(null)
      let orderIds: string[] | null = null
      if (orderCode.trim()) {
        const code = orderCode.trim().replace(/^#/, '')
        const { data } = await supabase.from('orders').select('id').or(`order_code.eq.${code},order_number.eq.${/^\d+$/.test(code) ? code : -1}`)
        orderIds = ((data as { id: string }[]) ?? []).map((o) => o.id)
        if (orderIds.length === 0) {
          setEntries([])
          setMore(false)
          setLoading(false)
          setError(tr("There is no order {{code}}. (Permanently deleted orders can still be found by leaving this empty.)", { code: code }))
          return
        }
      }
      let q = supabase
        .from('activity_feed')
        .select('id, at, user_email, user_departments, table_name, record_id, order_id, action, changes')
        .order('at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + PAGE - 1)
      if (person === '__auto') q = q.is('user_email', null)
      else if (person) q = q.eq('user_email', person)
      if (area) q = q.eq('table_name', area)
      if (department) q = q.contains('user_departments', [department])
      if (orderIds) q = q.in('order_id', orderIds)
      if (from) q = q.gte('at', halifaxStart(from))
      if (to) q = q.lt('at', halifaxStart(addDaysISO(to, 1)))
      const { data, error: e } = await q
      if (e) {
        toast.error(friendlyError(e))
        setLoading(false)
        return
      }
      const rows = (data as Entry[]) ?? []
      setEntries((prev) => (offset === 0 ? rows : [...prev, ...rows]))
      setMore(rows.length === PAGE)
      // Look up order numbers for display.
      const ids = [...new Set(rows.map((r) => r.order_id).filter((x): x is string => !!x))]
      if (ids.length) {
        const { data: os } = await supabase.from('orders').select('id, order_code').in('id', ids)
        setOrderCodes((m) => {
          const next = new Map(m)
          for (const o of (os as { id: string; order_code: string }[]) ?? []) next.set(o.id, o.order_code)
          return next
        })
      }
      setLoading(false)
    },
    [person, area, department, orderCode, from, to],
  )

  useEffect(() => {
    // search() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    search(0)
    // Run once on open; afterwards the Search button runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title={tr("Activity")}
        print={
          <Can permission="admin.activity.print">
            <PrintButton title={tr("Activity")} />
          </Can>
        }
      >{tr("Every change anyone made, newest first. Times are Halifax time.")}</AdminPageHeader>

      <form
        className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-[1.4fr_0.8fr_1fr_1.2fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault()
          search(0)
        }}
      >
        <Field label={tr("Person")} htmlFor="ac-person">
          <select id="ac-person" className={inputClass} value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">{tr("Everyone")}</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="__auto">{tr("Automatic / database")}</option>
          </select>
        </Field>
        <Field label={tr("Order #")} htmlFor="ac-order">
          <input id="ac-order" className={inputClass} placeholder={tr("for example 76")} value={orderCode} onChange={(e) => setOrderCode(e.target.value)} />
        </Field>
        <Field label={tr("Area")} htmlFor="ac-area">
          <select id="ac-area" className={inputClass} value={area} onChange={(e) => setArea(e.target.value)}>
            {AREAS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr("Department")} htmlFor="ac-dept">
          <select id="ac-dept" className={inputClass} value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">{tr("All departments")}</option>
            {departmentNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label={tr("From")} htmlFor="ac-from">
          <input id="ac-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={tr("To")} htmlFor="ac-to">
          <input id="ac-to" type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <button type="submit" className={buttonClass} disabled={loading}>
            {tr("Search")}
          </button>
        </div>
      </form>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <ol className="space-y-2">
        {entries.map((e) => {
          const d = describeActivity(e, typeNames)
          if (d.lines.length === 0 && e.action === 'update') return null
          const code = e.order_id ? orderCodes.get(e.order_id) : null
          return (
            <li key={e.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {e.order_id &&
                    (code ? (
                      <Link to={`/orders/${e.order_id}`} className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs hover:underline">
                        {tr("Order")} {code}
                      </Link>
                    ) : (
                      <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{tr("deleted order")}</span>
                    ))}
                  {d.title}
                </span>
                <span className="text-xs text-slate-500">
                  {activityTime.format(new Date(e.at))} · {activityWho(e)}
                </span>
              </div>
              {d.lines.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-slate-700">
                  {d.lines.slice(0, 12).map((l, i) => (
                    <li key={i} className="break-words">
                      {l}
                    </li>
                  ))}
                  {d.lines.length > 12 && <li className="text-slate-500">{tr("…and")} {d.lines.length - 12} {tr("more")}</li>}
                </ul>
              )}
            </li>
          )
        })}
      </ol>
      {!loading && entries.length === 0 && !error && <p className="text-center text-sm text-slate-500">{tr("No changes match these filters.")}</p>}
      {loading && <p className="text-center text-sm text-slate-500">{tr("Loading…")}</p>}
      {more && !loading && (
        <div className="text-center">
          <button type="button" className={secondaryButtonClass} onClick={() => search(entries.length)}>
            {tr("Load More")}
          </button>
        </div>
      )}
    </div>
  )
}
