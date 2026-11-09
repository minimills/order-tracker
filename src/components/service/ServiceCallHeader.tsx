// @permission-scope service.calls
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'
import RichText from '../RichText'
import SerialNumber from '../SerialNumber'
import { countryFlag } from '../../lib/country'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { serviceDates, type ServiceCallInfo } from '../../lib/service'
import { supabase } from '../../lib/supabase'

type Stage = { id: string; name: string; sort_order: number }

/** Top of a service call page: problem, customer, machines, technician, dates, stage. */
export default function ServiceCallHeader({ call, onChanged }: { call: ServiceCallInfo; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [stages, setStages] = useState<Stage[]>([])

  useEffect(() => {
    supabase
      ?.from('board_stages')
      .select('id, name, sort_order')
      .eq('board_id', call.board_id)
      .eq('archived', false)
      .order('sort_order')
      .then(({ data }) => setStages((data as Stage[] | null) ?? []))
  }, [call.board_id])

  async function moveTo(stageId: string) {
    if (!supabase || stageId === call.stage_id) return
    const { error } = await supabase.rpc('move_board_card', { p_card: call.card_id, p_stage: stageId, p_index: 0 })
    if (error) return toast.error(friendlyError(error))
    toast.success('Stage changed.')
    onChanged()
  }

  return (
    <div className="space-y-2">
      <h1 className="mt-1 text-2xl font-semibold">
        Service Call {call.call_code}
        <span className="ml-2 rounded bg-violet-100 px-2 py-0.5 align-middle text-sm font-medium text-violet-900">{call.stage_name}</span>
      </h1>
      <p className="font-medium">{call.title}</p>
      <p className="text-sm text-slate-700">
        {call.customer_name ?? <span className="text-amber-800">No customer chosen yet</span>}
        {call.customer_company ? ` · ${call.customer_company}` : ''}
        {call.customer_country ? ` · ${countryFlag(call.customer_country)} ${call.customer_country}` : ''}
      </p>
      <p className="text-sm text-slate-600">
        {serviceDates(call.planned_start, call.planned_end) || 'Dates not set'}
        {call.technician_name ? ` · Technician: ${call.technician_name}` : ' · No technician'}
      </p>
      {call.machines.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-sm">
          {call.machines.map((m) => (
            <li key={m.machine_id} className="rounded-full border border-slate-300 bg-white px-3 py-1">
              {m.machine} {m.serial && <SerialNumber serial={m.serial} className="text-xs" />}
              <span className="text-xs text-slate-500"> · Order {m.order_code}</span>
            </li>
          ))}
        </ul>
      )}
      <Can permission="boards.card.description">
        {call.description && (
          <div className="rounded-md border border-slate-200 bg-white p-3">
            <p className="mb-1 text-xs text-slate-500">Problem description</p>
            <RichText value={call.description} className="text-sm" />
          </div>
        )}
      </Can>
      <div className="flex flex-wrap items-center gap-2">
        <Can permission="service.calls.edit" level="edit">
          <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)}>
            Edit Details
          </button>
        </Can>
        {stages.length > 0 && (
          <Can permission="boards.card.move" level="edit">
            <select aria-label="Stage" className={`${narrowInputClass} w-48`} value={call.stage_id} onChange={(e) => moveTo(e.target.value)}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Can>
        )}
        <Can permission="boards.card.open">
          <Link to={`/boards/${call.board_id}?card=${call.card_id}`} className="text-sm text-blue-700 underline">
            Open the Board Card
          </Link>
        </Can>
      </div>
      {editing && (
        <ServiceCallDialog
          call={call}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

type CustomerHit = { id: string; name: string; company: string | null; country: string | null }
type CustomerMachine = { machine_id: string; machine: string; serial: string | null; order_id: string; order_code: string; order_date: string | null }

/** Customer (search), machines from that customer's past orders, technician, planned dates. */
function ServiceCallDialog({ call, onClose, onSaved }: { call: ServiceCallInfo; onClose: () => void; onSaved: () => void }) {
  const [customer, setCustomer] = useState<CustomerHit | null>(
    call.customer_id ? { id: call.customer_id, name: call.customer_name ?? '', company: call.customer_company, country: call.customer_country } : null,
  )
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<CustomerHit[]>([])
  const [machines, setMachines] = useState<CustomerMachine[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set(call.machines.map((m) => m.machine_id)))
  const [tech, setTech] = useState(call.technician_email ?? '')
  const [start, setStart] = useState(call.planned_start ?? '')
  const [end, setEnd] = useState(call.planned_end ?? '')
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase?.rpc('technician_choices').then(({ data }) => setPeople((data as { email: string; name: string }[] | null) ?? []))
  }, [])

  const cleaned = query.replace(/[,()%*\\]/g, ' ').trim()
  useEffect(() => {
    if (!supabase || !cleaned) return
    const timer = setTimeout(async () => {
      const { data } = await supabase!
        .from('customer_list')
        .select('id, name, company, country')
        .eq('archived', false)
        .or(`name.ilike.%${cleaned}%,company.ilike.%${cleaned}%`)
        .order('name')
        .limit(8)
      setHits((data as CustomerHit[] | null) ?? [])
    }, 250)
    return () => clearTimeout(timer)
  }, [cleaned])

  useEffect(() => {
    if (!supabase || !customer) return
    supabase.rpc('customer_machines', { p_customer: customer.id }).then(({ data }) => setMachines((data as CustomerMachine[] | null) ?? []))
  }, [customer])

  const shownMachines = customer ? machines : []
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  async function save() {
    if (!supabase) return
    if (start && end && end < start) return toast.error('The end date must be on or after the start date.')
    setSaving(true)
    const { error } = await supabase.rpc('update_service_call', {
      p_card: call.card_id,
      p: {
        customer_id: customer?.id ?? null,
        technician_email: tech || null,
        planned_start: start || null,
        planned_end: end || null,
        machines: shownMachines.filter((m) => picked.has(m.machine_id)).map((m) => m.machine_id),
      },
    })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Service call saved.')
    onSaved()
  }

  return (
    <Modal
      title={`Service Call ${call.call_code}`}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Customer" htmlFor="sc-customer">
          {customer ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm">
              <span>
                {customer.name}
                {customer.company ? ` · ${customer.company}` : ''}
                {customer.country ? ` · ${countryFlag(customer.country)} ${customer.country}` : ''}
              </span>
              <button
                type="button"
                className="text-xs underline"
                onClick={() => {
                  setCustomer(null)
                  setPicked(new Set())
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                id="sc-customer"
                type="search"
                className={inputClass}
                placeholder="Type a name or company"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {cleaned && (
                <ul className="mt-1 divide-y divide-slate-100 rounded-md border border-slate-200 text-sm">
                  {hits.length === 0 && <li className="px-3 py-2 text-slate-500">No customers match.</li>}
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button type="button" className="w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => setCustomer(h)}>
                        {h.name}
                        {h.company ? <span className="text-slate-500"> · {h.company}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Field>
        {customer && (
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700">Machines involved (from this customer’s orders)</p>
            {shownMachines.length === 0 && <p className="text-sm text-slate-500">This customer has no machines on their orders.</p>}
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {shownMachines.map((m) => (
                <li key={m.machine_id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={picked.has(m.machine_id)} onChange={() => toggle(m.machine_id)} />
                    {m.machine} {m.serial ? <SerialNumber serial={m.serial} className="text-xs" /> : <span className="text-xs text-slate-500">no serial</span>}
                    <span className="text-xs text-slate-500">
                      · Order {m.order_code}
                      {m.order_date ? ` · ${showDate(m.order_date)}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Technician" htmlFor="sc-tech">
          <select id="sc-tech" className={inputClass} value={tech} onChange={(e) => setTech(e.target.value)}>
            <option value="">Not assigned</option>
            {tech && !people.some((p) => p.email === tech) && <option value={tech}>{call.technician_name ?? tech}</option>}
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Planned start" htmlFor="sc-start">
            <input id="sc-start" type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Planned end" htmlFor="sc-end">
            <input id="sc-end" type="date" className={inputClass} value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
