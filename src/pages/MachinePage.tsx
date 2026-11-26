import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import Icon, { type IconName } from '../components/Icon'
import SerialNumber from '../components/SerialNumber'
import { inputClass, narrowInputClass, secondaryButtonClass } from '../components/form'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { countryFlag } from '../lib/country'
import { showDate, todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { HOW_LABEL, KIND_LABEL, kindBadge, STOCK_LABEL, STOCK_TONE, type ItemKind, type StockStatus, type Warranty } from '../lib/machines'
import { richTextInline } from '../lib/richText'
import { supabase } from '../lib/supabase'
import { useStageLabels } from '../lib/stages'
import { useOptionList } from '../lib/useOptionList'
import CeIssueDialog from '../components/ce/CeIssueDialog'
import CeRegister from '../components/ce/CeRegister'
import PrintButton from '../components/print/PrintButton'
import { AddMachineDialog, BuyBackDialog, ChangeOwnerDialog, StartRefurbDialog, StockDialog } from '../components/machines/MachineDialogs'
import ImportMachinesDialog from '../components/machines/ImportMachinesDialog'

type Owner = {
  customer_id: string | null
  name: string
  company: string | null
  country: string | null
  from: string
  how: string
  order_id: string | null
  order_code: string | null
  notes: string | null
  found_out?: string | null
  company_stock?: boolean
  date_approx?: boolean
}
type Event = { day: string; at?: string; kind: string; title: string; detail?: string | null; link?: string | null }
type Details = {
  id: string
  serial: string | null
  machine_type: string
  code: string | null
  built: boolean
  order_id: string | null
  order_code: string | null
  original_order_id: string | null
  original_order_code: string | null
  stage: string | null
  origin: 'order' | 'existing'
  year_built: number | null
  year_approx: boolean
  voltage: string | null
  location: string | null
  condition: string | null
  notes: string | null
  item_kind: ItemKind
  stock_status: StockStatus | null
  refurb_count: number
  company_owned: boolean
  warranty: Warranty | null
  sale_price: number | null
  sale_currency: string | null
  current_owner: { id: string; name: string; company: string | null; country: string | null } | null
  owners: Owner[]
  old_serials: { serial: string; replaced_by: string; on: string; reason: string }[]
  refurb_jobs: { id: string; number: number; status: 'open' | 'completed' | 'cancelled'; opened_at: string; completed_at: string | null; old_serial: string | null; new_serial: string | null; board_id: string | null }[]
  buybacks: { id: string; date: string; from: string | null; price: number | null; currency: string | null; condition: string | null; reason: string | null; arranged_by: string | null }[]
  timeline: Event[]
}
/** One row of machine_list() (0057). */
type ListRow = {
  machine_id: string
  serial: string | null
  model: string
  code: string | null
  customer: string | null
  country: string | null
  order_id: string | null
  order_code: string | null
  order_number: number | null
  stage: string | null
  built: boolean
  check_signed: boolean
  origin: string
  item_kind: ItemKind
  stock_status: StockStatus | null
  condition: string | null
  location: string | null
  company_owned: boolean
  old_serials: string | null
  year_built: number | null
  machine_type_id: string
}

const KIND: Record<string, { icon: IconName; tone: string }> = {
  order: { icon: 'receipt', tone: 'bg-slate-500' },
  build: { icon: 'factory', tone: 'bg-blue-600' },
  built: { icon: 'check', tone: 'bg-green-600' },
  check: { icon: 'checklist', tone: 'bg-emerald-600' },
  crate: { icon: 'box', tone: 'bg-amber-600' },
  ship: { icon: 'truck', tone: 'bg-slate-800' },
  owner: { icon: 'users', tone: 'bg-violet-600' },
  service: { icon: 'cog', tone: 'bg-teal-600' },
  call: { icon: 'wrench', tone: 'bg-rose-600' },
  certificate: { icon: 'template', tone: 'bg-indigo-600' },
  refurb: { icon: 'wrench', tone: 'bg-violet-700' },
}
const ownerName = (o: { name: string; company: string | null }) => o.company || o.name
const smallBtn = 'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50'

/** Machines: every machine, the company's stock, and one machine's owners, details and whole history. */
export default function MachinePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const tab = params.get('tab') === 'stock' ? 'stock' : 'all'
  const setParam = (k: string, v: string) =>
    setParams(
      (p) => {
        if (v) p.set(k, v)
        else p.delete(k)
        return p
      },
      { replace: true },
    )
  const [all, setAll] = useState<ListRow[] | null>(null)
  const [listVersion, setListVersion] = useState(0)
  const label = useStageLabels()
  const [m, setM] = useState<Details | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | 'owner' | 'buyback' | 'stock' | 'edit' | 'refurb' | 'add' | 'import'>(null)
  const [ceOpen, setCeOpen] = useState(false)
  const [ceRefresh, setCeRefresh] = useState(0)
  const conditions = useOptionList('machine_condition').options

  const load = useCallback(async () => {
    if (!supabase || !id) return
    const { data, error: e } = await supabase.rpc('machine_details', { p_machine: id })
    if (e) return setError(friendlyError(e))
    setM(data as Details)
  }, [id])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  useEffect(() => {
    if (!supabase || id) return
    supabase.rpc('machine_list').then(({ data, error: e }) => {
      if (e) return void toast.error(friendlyError(e))
      setAll((data as ListRow[]) ?? [])
    })
  }, [id, listVersion])

  const statusOf = (r: ListRow) =>
    r.stock_status && r.stock_status !== 'sold'
      ? STOCK_LABEL[r.stock_status]
      : !r.stage
        ? 'Entered as existing'
        : r.stage === 'Shipped'
          ? label('Shipped')
          : r.stage === 'Cancelled'
            ? label('Cancelled')
            : r.check_signed
              ? 'Final check complete'
              : r.built
                ? 'Built'
                : `Not built · ${label(r.stage)}`
  const fStatus = params.get('status') ?? ''
  const fCond = params.get('cond') ?? ''
  const fType = params.get('type') ?? ''
  const fLoc = params.get('loc') ?? ''
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    let list = all ?? []
    if (tab === 'stock') {
      list = list.filter((r) => r.company_owned || r.stock_status === 'reserved' || (fStatus === 'sold' && r.stock_status === 'sold'))
      if (fStatus) list = list.filter((r) => r.stock_status === fStatus)
      else list = list.filter((r) => r.stock_status !== 'sold')
      if (fCond) list = list.filter((r) => r.condition === fCond)
      if (fType) list = list.filter((r) => r.machine_type_id === fType)
      if (fLoc) list = list.filter((r) => (r.location ?? '').toLowerCase().includes(fLoc.toLowerCase()))
    }
    if (words.length === 0) return list
    return list.filter((r) => {
      const text = [r.serial, r.old_serials, r.model, r.code, r.customer, r.country, r.order_code, r.location].join(' ').toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }, [all, q, tab, fStatus, fCond, fType, fLoc])
  const types = useMemo(() => [...new Map((all ?? []).map((r) => [r.machine_type_id, r.model])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all])
  useBreadcrumbs(id ? m && [{ label: 'Machines', to: '/machines' }, { label: [m.machine_type, m.serial].filter(Boolean).join(' ') }] : [{ label: 'Machines' }])

  function search(e: React.FormEvent) {
    e.preventDefault()
    if (id) return navigate(`/machines${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
    const t = q.trim().toLowerCase()
    const exact = shown.filter((r) => r.serial?.toLowerCase() === t || (r.old_serials ?? '').toLowerCase().split(' ').includes(t))
    if (exact.length === 1) navigate(`/machines/${exact[0].machine_id}`)
  }
  const openJob = m?.refurb_jobs.find((j) => j.status === 'open')
  const refurbFrom = m?.old_serials.filter((o) => o.reason === 'refurbished') ?? []
  const done = () => {
    setDialog(null)
    void load()
  }

  return (
    <Can permission="machines">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold">{m && id ? `${m.machine_type}` : 'Machines'}</h1>
              {m && id && kindBadge(m.item_kind) && (
                <span className="rounded bg-violet-600 px-1.5 py-0.5 text-xs font-bold text-white">{m.item_kind === 'refurbished' ? 'Refurbished' : 'Used'}</span>
              )}
              {m && id && m.stock_status && <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STOCK_TONE[m.stock_status]}`}>{STOCK_LABEL[m.stock_status]}</span>}
              <Can permission="machines.print">
                <PrintButton title={m && id ? `${m.machine_type}${m.serial ? ` ${m.serial}` : ''}` : 'Machines'} />
              </Can>
            </div>
            {m && id ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                {m.serial ? <SerialNumber serial={m.serial} /> : <span>No serial yet</span>}
                <span>· {m.built ? 'Built' : 'Not built'}</span>
                {m.original_order_id ? (
                  <span>
                    · first sold on{' '}
                    <Link to={`/orders/${m.original_order_id}`} className="underline">
                      order {m.original_order_code}
                    </Link>
                  </span>
                ) : (
                  <span>· entered as an existing machine</span>
                )}
                {m.order_id && m.order_id !== m.original_order_id && (
                  <span>
                    · now on{' '}
                    <Link to={`/orders/${m.order_id}`} className="underline">
                      order {m.order_code}
                    </Link>
                  </span>
                )}
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-600">Every machine, old and new. Type to narrow the list; open a machine to see its owners and its whole history.</p>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {!id && (
              <>
                <Can permission="machines.add_existing" level="edit">
                  <button type="button" className={secondaryButtonClass} onClick={() => setDialog('add')}>
                    Add Existing Machine
                  </button>
                </Can>
                <Can permission="machines.import" level="edit">
                  <button type="button" className={secondaryButtonClass} onClick={() => setDialog('import')}>
                    Import Machines
                  </button>
                </Can>
              </>
            )}
            <Can permission="machines.search">
              <form onSubmit={search} className="flex w-full gap-2 sm:w-auto" role="search">
                <input
                  type="search"
                  aria-label="Search machines"
                  className={`${inputClass} sm:w-72`}
                  placeholder="Serial (old or new), model, customer, country or order #"
                  value={q}
                  onChange={(e) => setParam('q', e.target.value)}
                />
                {id && (
                  <button type="submit" className={secondaryButtonClass}>
                    Find
                  </button>
                )}
              </form>
            </Can>
          </div>
        </div>

        {!id && (
          <Can permission="machines.stock">
            <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Machines">
              {(['all', 'stock'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setParam('tab', t === 'all' ? '' : t)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}
                >
                  {t === 'all' ? 'All Machines' : 'Stock'}
                </button>
              ))}
            </div>
            {tab === 'stock' && (
              <div className="flex flex-wrap items-end gap-2 text-sm">
                <label className="flex flex-col">
                  <span className="text-xs text-slate-600">Status</span>
                  <select className={narrowInputClass} value={fStatus} onChange={(e) => setParam('status', e.target.value)}>
                    <option value="">In stock (all but sold)</option>
                    {(Object.keys(STOCK_LABEL) as StockStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {STOCK_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col">
                  <span className="text-xs text-slate-600">Condition</span>
                  <select className={narrowInputClass} value={fCond} onChange={(e) => setParam('cond', e.target.value)}>
                    <option value="">Any</option>
                    {conditions.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col">
                  <span className="text-xs text-slate-600">Machine type</span>
                  <select className={narrowInputClass} value={fType} onChange={(e) => setParam('type', e.target.value)}>
                    <option value="">Any</option>
                    {types.map(([tid, name]) => (
                      <option key={tid} value={tid}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col">
                  <span className="text-xs text-slate-600">Location</span>
                  <input className={`${narrowInputClass} w-44`} value={fLoc} onChange={(e) => setParam('loc', e.target.value)} />
                </label>
              </div>
            )}
          </Can>
        )}

        {!id && (
          <section className="min-w-0 rounded-lg border border-slate-200 bg-white text-sm" aria-label="Machines" data-print-section="Machines">
            {all === null ? (
              <p className="p-4 text-slate-500">Loading…</p>
            ) : shown.length === 0 ? (
              <p className="p-4 text-slate-500">{tab === 'stock' ? 'No machines in stock match these filters.' : all.length === 0 ? 'No machines have been entered yet.' : `No machine matches “${q}”.`}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] border-collapse text-left">
                  <thead className="bg-slate-50 text-xs text-slate-600">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Serial number</th>
                      <th className="px-3 py-2 font-semibold">Model</th>
                      <th className="px-3 py-2 font-semibold">{tab === 'stock' ? 'Condition · location' : 'Owner'}</th>
                      <th className="px-3 py-2 font-semibold">Order</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.map((r) => (
                      <tr key={r.machine_id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/machines/${r.machine_id}`)}>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.serial ? <SerialNumber serial={r.serial} className="font-semibold" /> : <span className="text-slate-500">No serial yet</span>}
                          {r.old_serials && <div className="text-xs text-slate-500">was {r.old_serials}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <Link to={`/machines/${r.machine_id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                            {r.model}
                          </Link>
                          {kindBadge(r.item_kind) && <span className="ml-1.5 rounded bg-violet-600 px-1 text-[0.625rem] font-bold text-white">{kindBadge(r.item_kind)}</span>}
                        </td>
                        <td className="px-3 py-2">
                          {tab === 'stock' ? (
                            [r.condition, r.location].filter(Boolean).join(' · ') || '—'
                          ) : (
                            <>
                              {r.company_owned ? 'Company stock' : (r.customer ?? '—')}
                              {!r.company_owned && r.country && (
                                <span className="text-slate-500">
                                  {' '}
                                  · {countryFlag(r.country)} {r.country}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.order_code ?? '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={r.stage === 'Shipped' || r.check_signed || r.built ? 'text-green-700' : r.stage === 'Cancelled' ? 'text-slate-500' : 'text-slate-700'}>{statusOf(r)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                  {shown.length === all.length ? `${all.length} machines` : `${shown.length} of ${all.length} machines`}
                </p>
              </div>
            )}
          </section>
        )}

        {error && <p className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}</p>}

        {m && id && (
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-label="Machine details" data-print-section="Details">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Details</h2>
              <div className="flex flex-wrap gap-2" data-print="hide">
                <Can permission="machines.add_existing" level="edit">
                  <button type="button" className={smallBtn} onClick={() => setDialog('edit')}>
                    Edit Details
                  </button>
                </Can>
                {m.company_owned && (
                  <Can permission="machines.stock" level="edit">
                    <button type="button" className={smallBtn} onClick={() => setDialog('stock')}>
                      Stock Details
                    </button>
                  </Can>
                )}
                {!m.company_owned && !openJob && (
                  <Can permission="machines.buyback" level="edit">
                    <button type="button" className={smallBtn} onClick={() => setDialog('buyback')}>
                      Buy Back
                    </button>
                  </Can>
                )}
                {m.company_owned && !openJob && m.stock_status !== 'reserved' && (
                  <Can permission="refurb" level="edit">
                    <button type="button" className={smallBtn} onClick={() => setDialog('refurb')}>
                      Start Refurbishment
                    </button>
                  </Can>
                )}
              </div>
            </div>
            <dl className="grid gap-x-6 gap-y-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,13rem),1fr))]">
              <Detail label="Kind" value={KIND_LABEL[m.item_kind] + (m.refurb_count > 1 ? ` (refurbished ${m.refurb_count} times)` : '')} />
              <Detail label="Year built" value={m.year_built ? `${m.year_approx ? 'About ' : ''}${m.year_built}` : '—'} />
              <Detail label="Voltage" value={m.voltage ?? '—'} />
              <Detail label="Condition" value={m.condition ?? '—'} />
              <Detail label="Where it is" value={m.location ?? '—'} />
              <Detail label="Owner" value={m.company_owned ? 'Company stock' : m.current_owner ? ownerName(m.current_owner) : '—'} />
              <Can permission="refurb.costs">{m.company_owned && <Detail label="Asking price" value={m.sale_price != null ? `${m.sale_price} ${m.sale_currency ?? 'CAD'}` : '—'} />}</Can>
            </dl>
            {refurbFrom.length > 0 && (
              <p className="mt-3 rounded-md bg-violet-50 p-2 text-violet-900">
                Refurbished from {refurbFrom.map((o) => o.serial).join(', then ')} (
                {refurbFrom.map((o) => `${o.serial} → ${o.replaced_by} on ${showDate(o.on)}`).join('; ')}). Searching for an old serial finds this machine.
              </p>
            )}
            {m.notes && <p className="mt-3 text-slate-700">{m.notes}</p>}
            <Can permission="machines.warranty">
              <p className="mt-3">
                <span className="font-medium">Warranty: </span>
                {!m.warranty || m.warranty.months === 0
                  ? `No warranty (${KIND_LABEL[m.item_kind].toLowerCase()} machine)`
                  : `${m.warranty.months} months (${KIND_LABEL[m.warranty.kind].toLowerCase()})${m.warranty.end ? `, ends ${showDate(m.warranty.end)}` : ', starts when it ships'}${m.warranty.end && m.warranty.end < todayISO() ? ' (ended)' : ''}`}
              </p>
            </Can>
            <Can permission="machines.documents">
              <p className="mt-3 rounded-md border border-dashed border-slate-300 p-2 text-xs text-slate-500">Photos and documents of this machine: available in a future update.</p>
            </Can>
          </section>
        )}

        {m && id && (m.refurb_jobs.length > 0 || m.buybacks.length > 0) && (
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            {m.buybacks.length > 0 && (
              <Can permission="machines.buyback">
                <section className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-label="Buy-backs">
                  <h2 className="mb-2 font-semibold">Buy-backs</h2>
                  <ul className="space-y-2">
                    {m.buybacks.map((b) => (
                      <li key={b.id}>
                        <div className="font-medium">
                          {showDate(b.date)}
                          {b.from ? ` from ${b.from}` : ''}
                          <Can permission="refurb.costs">{b.price != null && ` · ${b.price} ${b.currency}`}</Can>
                        </div>
                        <div className="text-xs text-slate-600">{[b.condition && `Arrived: ${b.condition}`, b.reason, b.arranged_by && `Arranged by ${b.arranged_by}`].filter(Boolean).join(' · ')}</div>
                      </li>
                    ))}
                  </ul>
                </section>
              </Can>
            )}
            {m.refurb_jobs.length > 0 && (
              <Can permission="refurb">
                <section className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-label="Refurbishments">
                  <h2 className="mb-2 font-semibold">Refurbishments</h2>
                  <ul className="space-y-2">
                    {m.refurb_jobs.map((j) => (
                      <li key={j.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <Link to={`/machines/refurb/${j.id}`} className="font-medium underline">
                            Refurbishment {j.number}
                          </Link>{' '}
                          · started {showDate(j.opened_at.slice(0, 10))}
                          {j.status === 'completed' && ` · completed ${showDate(j.completed_at?.slice(0, 10))}: ${j.old_serial} → ${j.new_serial}`}
                          {j.status === 'cancelled' && ' · cancelled'}
                          {j.status === 'open' && ' · in progress'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              </Can>
            )}
          </div>
        )}

        {m && id && (
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 text-sm lg:w-80 lg:shrink-0" aria-label="Owners">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="font-semibold">Owners</h2>
                <Can permission="machines.transfer" level="edit">
                  <button type="button" className={secondaryButtonClass} onClick={() => setDialog('owner')}>
                    Change Owner
                  </button>
                </Can>
              </div>
              <ol className="space-y-3">
                {m.owners.map((o, i) => {
                  const current = i === m.owners.length - 1
                  return (
                    <li key={`${o.customer_id}-${o.from}-${i}`} className={`rounded-md p-2 ${current ? 'bg-blue-50 ring-1 ring-blue-200' : ''}`}>
                      <div className="font-medium">
                        {o.company_stock ? 'Company stock' : ownerName(o)} {o.country && <span title={o.country}>{countryFlag(o.country)}</span>}
                      </div>
                      {o.company && <div className="text-xs text-slate-500">{o.name}</div>}
                      <div className="text-xs text-slate-600">
                        From {o.date_approx ? 'about ' : ''}
                        {showDate(o.from)} · {HOW_LABEL[o.how] ?? o.how}
                        {current && ' · current owner'}
                      </div>
                      {o.order_id && (
                        <Link to={`/orders/${o.order_id}`} className="text-xs underline">
                          Order {o.order_code}
                        </Link>
                      )}
                      {o.found_out && <p className="mt-1 text-xs text-slate-700">We found out: {o.found_out}</p>}
                      {o.notes && <p className="mt-1 text-xs text-slate-700">{o.notes}</p>}
                    </li>
                  )
                })}
              </ol>
            </section>

            <section className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-label="History">
              <h2 className="mb-3 font-semibold">History</h2>
              {m.timeline.length === 0 ? (
                <p className="text-slate-500">Nothing recorded yet.</p>
              ) : (
                <ol className="relative space-y-4 border-l-2 border-slate-200 pl-6">
                  {m.timeline.map((t, i) => {
                    const k = KIND[t.kind] ?? KIND.order
                    return (
                      <li key={i} className="relative">
                        <span className={`absolute -left-[2.05rem] top-0 flex h-6 w-6 items-center justify-center rounded-full text-white ${k.tone}`}>
                          <Icon name={k.icon} className="h-3.5 w-3.5" />
                        </span>
                        <div className="text-xs text-slate-500">{showDate(t.day, 'EEE, MMM d, yyyy')}</div>
                        <div className="font-medium">
                          {t.link ? (
                            <Link to={t.link} className="underline">
                              {t.title}
                            </Link>
                          ) : (
                            t.title
                          )}
                        </div>
                        {t.detail && <div className="break-words text-slate-600">{richTextInline(t.detail)}</div>}
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          </div>
        )}

        {m && id && (
          <Can permission="ce">
            <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm" aria-label="CE declarations">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">CE Declarations of Conformity</h2>
                <Can permission="ce.issue" level="edit">
                  {m.serial && (
                    <button type="button" className={secondaryButtonClass} onClick={() => setCeOpen(true)}>
                      CE Certificate
                    </button>
                  )}
                </Can>
              </div>
              <CeRegister machineId={id} refreshKey={ceRefresh} />
            </section>
          </Can>
        )}
        {ceOpen && m && id && (
          <Can permission="ce.issue" level="edit">
            <CeIssueDialog orderId={m.order_id ?? ''} machineIds={[id]} onClose={() => setCeOpen(false)} onIssued={() => setCeRefresh((n) => n + 1)} />
          </Can>
        )}

        {dialog === 'owner' && m && <ChangeOwnerDialog machine={m} onClose={() => setDialog(null)} onDone={done} />}
        {dialog === 'buyback' && m && <BuyBackDialog machine={m} onClose={() => setDialog(null)} onDone={done} />}
        {dialog === 'stock' && m && <StockDialog machine={m} onClose={() => setDialog(null)} onDone={done} />}
        {dialog === 'refurb' && m && <StartRefurbDialog machine={m} onClose={() => setDialog(null)} onDone={(job) => navigate(`/machines/refurb/${job}`)} />}
        {dialog === 'edit' && m && (
          <AddMachineDialog
            edit={{ id: m.id, year_built: m.year_built, year_approx: m.year_approx, voltage: m.voltage, location: m.location, condition: m.condition, warranty_months: m.warranty?.custom ? m.warranty.months : null, warranty_start: m.warranty?.custom ? m.warranty.start : null }}
            onClose={() => setDialog(null)}
            onDone={done}
          />
        )}
        {dialog === 'add' && <AddMachineDialog onClose={() => setDialog(null)} onDone={(mid) => navigate(`/machines/${mid}`)} />}
        {dialog === 'import' && (
          <ImportMachinesDialog
            onClose={() => setDialog(null)}
            onDone={() => {
              setDialog(null)
              setListVersion((v) => v + 1)
            }}
          />
        )}
      </div>
    </Can>
  )
}

/* @layout-helper */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  )
}
