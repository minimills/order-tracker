import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import Icon, { type IconName } from '../components/Icon'
import SerialNumber from '../components/SerialNumber'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../components/form'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { countryFlag } from '../lib/country'
import { showDate, todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import { ACTION } from '../lib/wording'
import CeIssueDialog from '../components/ce/CeIssueDialog'
import CeRegister from '../components/ce/CeRegister'

type Owner = {
  customer_id: string
  name: string
  company: string | null
  country: string | null
  from: string
  how: string
  order_id: string | null
  order_code: string | null
  notes: string | null
}
type Event = { day: string; at?: string; kind: string; title: string; detail?: string | null; link?: string | null }
type Details = {
  id: string
  serial: string | null
  machine_type: string
  code: string | null
  built: boolean
  order_id: string
  order_code: string
  stage: string
  current_owner: { id: string; name: string; company: string | null; country: string | null } | null
  owners: Owner[]
  timeline: Event[]
}
type Found = { machine_id: string; serial: string | null; machine: string; order_code: string; owner: string | null }

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
}
const ownerName = (o: { name: string; company: string | null }) => o.company || o.name

/** Machine page: find a machine by serial number, then see who owns it and everything that happened to it. */
export default function MachinePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Found[] | null>(null)
  const [m, setM] = useState<Details | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transfer, setTransfer] = useState(false)
  const [ceOpen, setCeOpen] = useState(false)
  const [ceRefresh, setCeRefresh] = useState(0)

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
  useBreadcrumbs(id ? m && [{ label: 'Machines', to: '/machines' }, { label: [m.machine_type, m.serial].filter(Boolean).join(' ') }] : [{ label: 'Machines' }])

  async function search(e?: React.FormEvent) {
    e?.preventDefault()
    if (!supabase || q.trim().length < 2) return
    const { data, error: err } = await supabase.rpc('find_machines', { p_query: q.trim() })
    if (err) return toast.error(friendlyError(err))
    const list = (data as Found[]) ?? []
    setFound(list)
    if (list.length === 1 && list[0].serial?.toLowerCase() === q.trim().toLowerCase()) navigate(`/machines/${list[0].machine_id}`)
  }

  return (
    <Can permission="machines">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{m && id ? `${m.machine_type}` : 'Machines'}</h1>
            {m && id ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                {m.serial ? <SerialNumber serial={m.serial} /> : <span>No serial yet</span>}
                <span>· {m.built ? 'Built' : 'Not built'}</span>
                <span>
                  · first sold on{' '}
                  <Link to={`/orders/${m.order_id}`} className="underline">
                    order {m.order_code}
                  </Link>
                </span>
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-600">Find a machine by its serial number to see its owners and its whole history.</p>
            )}
          </div>
          <Can permission="machines.search">
            <form onSubmit={search} className="flex w-full gap-2 sm:w-auto" role="search">
              <input
                aria-label="Serial number"
                className={`${inputClass} sm:w-56`}
                placeholder="Serial number, for example LCR-2073"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button type="submit" className={buttonClass}>
                Find
              </button>
            </form>
          </Can>
        </div>

        {found && (
          <section className="rounded-lg border border-slate-200 bg-white text-sm" aria-label="Search results">
            {found.length === 0 ? (
              <p className="p-4 text-slate-500">No machine matches “{q}”.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {found.map((f) => (
                  <li key={f.machine_id}>
                    <Link
                      to={`/machines/${f.machine_id}`}
                      onClick={() => setFound(null)}
                      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 hover:bg-slate-50"
                    >
                      <span className="font-mono font-semibold">{f.serial ?? 'No serial'}</span>
                      <span>{f.machine}</span>
                      <span className="text-slate-500">
                        order {f.order_code}
                        {f.owner && ` · owner ${f.owner}`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {error && <p className="rounded-md bg-red-50 p-4 text-sm text-red-800">{error}</p>}

        {m && id && (
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 text-sm lg:w-80 lg:shrink-0" aria-label="Owners">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="font-semibold">Owners</h2>
                <Can permission="machines.transfer" level="edit">
                  <button type="button" className={secondaryButtonClass} onClick={() => setTransfer(true)}>
                    Transfer / Resold
                  </button>
                </Can>
              </div>
              <ol className="space-y-3">
                {m.owners.map((o, i) => {
                  const current = i === m.owners.length - 1
                  return (
                    <li key={`${o.customer_id}-${o.from}-${i}`} className={`rounded-md p-2 ${current ? 'bg-blue-50 ring-1 ring-blue-200' : ''}`}>
                      <div className="font-medium">
                        {ownerName(o)} {o.country && <span title={o.country}>{countryFlag(o.country)}</span>}
                      </div>
                      {o.company && <div className="text-xs text-slate-500">{o.name}</div>}
                      <div className="text-xs text-slate-600">
                        From {showDate(o.from)} · {o.how}
                        {current && ' · current owner'}
                      </div>
                      {o.order_id && (
                        <Link to={`/orders/${o.order_id}`} className="text-xs underline">
                          Order {o.order_code}
                        </Link>
                      )}
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
                        {t.detail && <div className="break-words text-slate-600">{t.detail}</div>}
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
            <CeIssueDialog
              orderId={m.order_id}
              machineIds={[id]}
              onClose={() => setCeOpen(false)}
              onIssued={() => setCeRefresh((n) => n + 1)}
            />
          </Can>
        )}

        {transfer && m && (
          <TransferDialog
            machine={m}
            onClose={() => setTransfer(false)}
            onDone={() => {
              setTransfer(false)
              void load()
            }}
          />
        )}
      </div>
    </Can>
  )
}

type CustomerRow = { id: string; name: string; company: string | null; country: string | null }

/** Give the machine a new owner: an existing customer or a new one, date, notes, optional order. */
function TransferDialog({ machine, onClose, onDone }: { machine: Details; onClose: () => void; onDone: () => void }) {
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  const [find, setFind] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [isNew, setIsNew] = useState(false)
  const [nw, setNw] = useState({ name: '', company: '', country: '', email: '' })
  const [date, setDate] = useState(todayISO())
  const [notes, setNotes] = useState('')
  const [orderCode, setOrderCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase
      ?.from('customer_list')
      .select('id, name, company, country')
      .eq('archived', false)
      .order('name')
      .limit(1000)
      .then(({ data }) => setCustomers((data as CustomerRow[]) ?? []))
  }, [])
  const shown = customers.filter((c) => `${c.name} ${c.company ?? ''} ${c.country ?? ''}`.toLowerCase().includes(find.toLowerCase())).slice(0, 50)

  async function save() {
    if (!supabase) return
    setError(null)
    if (!isNew && !customerId) return setError('Choose the new owner.')
    if (isNew && !nw.name.trim()) return setError('Enter the new owner’s name.')
    let orderId: string | null = null
    if (orderCode.trim()) {
      const { data } = await supabase.from('order_summary').select('id').eq('order_code', orderCode.trim()).maybeSingle()
      if (!data) return setError(`There is no order ${orderCode.trim()}.`)
      orderId = (data as { id: string }).id
    }
    setBusy(true)
    const { error: e } = await supabase.rpc('transfer_machine', {
      p: {
        machine_id: machine.id,
        customer_id: isNew ? null : customerId,
        new_customer: isNew ? { name: nw.name, company: nw.company, country: nw.country, emails: nw.email ? [nw.email] : [] } : null,
        date,
        notes,
        order_id: orderId,
      },
    })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success('New owner saved. Service calls for that customer now list this machine.')
    onDone()
  }

  return (
    <Can permission="machines.transfer" level="edit">
      <Modal
        title={`Transfer / Resold: ${machine.serial ?? machine.machine_type}`}
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
              {ACTION.cancel}
            </button>
            <Can permission="machines.transfer" level="edit">
              <button type="button" className={buttonClass} onClick={save} disabled={busy}>
                {busy ? ACTION.saving : 'Save New Owner'}
              </button>
            </Can>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-slate-600">Current owner: {machine.current_owner ? ownerName(machine.current_owner) : '—'}</p>
          <div className="flex gap-4">
            <label className="flex items-center gap-2">
              <input type="radio" name="tr-who" className="h-4 w-4" checked={!isNew} onChange={() => setIsNew(false)} /> An existing customer
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="tr-who" className="h-4 w-4" checked={isNew} onChange={() => setIsNew(true)} /> A new customer
            </label>
          </div>
          {isNew ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="tr-name">
                <input id="tr-name" className={inputClass} value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
              </Field>
              <Field label="Company (optional)" htmlFor="tr-company">
                <input id="tr-company" className={inputClass} value={nw.company} onChange={(e) => setNw({ ...nw, company: e.target.value })} />
              </Field>
              <Field label="Country" htmlFor="tr-country">
                <input id="tr-country" className={inputClass} value={nw.country} onChange={(e) => setNw({ ...nw, country: e.target.value })} />
              </Field>
              <Field label="Email (optional)" htmlFor="tr-email">
                <input id="tr-email" type="email" className={inputClass} value={nw.email} onChange={(e) => setNw({ ...nw, email: e.target.value })} />
              </Field>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                aria-label="Find a customer"
                className={inputClass}
                placeholder="Find a customer…"
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
              <select aria-label="New owner" size={6} className={inputClass} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                {shown.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.id === machine.current_owner?.id}>
                    {ownerName(c)}
                    {c.company ? ` (${c.name})` : ''}
                    {c.country ? ` · ${c.country}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date" htmlFor="tr-date">
              <input id="tr-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="New order # (optional)" htmlFor="tr-order" hint="If the resale went through an order of ours.">
              <input id="tr-order" className={inputClass} value={orderCode} onChange={(e) => setOrderCode(e.target.value)} />
            </Field>
          </div>
          <Field label="Notes (optional)" htmlFor="tr-notes">
            <textarea id="tr-notes" rows={3} className={inputClass} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {error && <p className="font-medium text-red-600">{error}</p>}
        </div>
      </Modal>
    </Can>
  )
}
