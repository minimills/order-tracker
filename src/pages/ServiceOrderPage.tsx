import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../components/form'
import SerialNumber from '../components/SerialNumber'
import { countryFlag } from '../lib/country'
import { showDate, todayISO } from '../lib/dates'
import { confirmAction } from '../lib/confirm'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import {
  discardQueued,
  KIND_LABEL,
  newClientId,
  queueEntry,
  serviceDates,
  useOutbox,
  type Certificate,
  type EntryDraft,
  type SavedEntry,
  type ServiceInfo,
} from '../lib/service'
import { supabase } from '../lib/supabase'
import ServiceCallHeader from '../components/service/ServiceCallHeader'
import type { ServiceCallInfo } from '../lib/service'

type Machine = { id: string; serial_number: string | null; archived: boolean; machine_types: { name: string } | null }
type Tab = 'log' | 'machines' | 'certificate'
const TABS: { key: Tab; label: string; callLabel?: string; permission: string }[] = [
  { key: 'log', label: 'Day Log', permission: 'service.log' },
  { key: 'machines', label: 'By Machine', permission: 'service.log.by_machine' },
  { key: 'certificate', label: 'Certificate', callLabel: 'Service Report', permission: 'service.certificate' },
]

/** A day as shown in the timeline: saved, or still waiting on this phone. */
type Day = { draft: EntryDraft; saved: SavedEntry | null; waiting: boolean; error: string | null }

const machineName = (m: Machine | undefined) => (m ? (m.machine_types?.name ?? 'Machine') : 'Machine')
const blankDraft = (subject: { order_id: string | null; service_call_id: string | null }): EntryDraft => ({
  client_id: newClientId(),
  ...subject,
  entry_date: todayISO(),
  kind: 'onsite',
  hours: '',
  notes: '',
  machines: [],
})
const toDraft = (e: SavedEntry): EntryDraft => ({
  client_id: e.client_id,
  order_id: e.order_id,
  service_call_id: e.service_call_id,
  entry_date: e.entry_date,
  kind: e.kind,
  hours: e.hours === null ? '' : String(Number(e.hours)),
  notes: e.notes ?? '',
  machines: e.service_entry_machines.map((m) => ({ machine_id: m.machine_id, notes: m.notes ?? '' })),
})

/**
 * The service of one order (training: day log, notes per machine, commissioning
 * certificate) or of one service call (kind="call": same log, service report).
 */
export default function ServiceOrderPage({ kind = 'order' }: { kind?: 'order' | 'call' }) {
  const params0 = useParams()
  const isCall = kind === 'call'
  const orderId = isCall ? '' : (params0.orderId ?? '')
  const callId = isCall ? (params0.callId ?? '') : ''
  const subjectId = isCall ? callId : orderId
  const subjectCol = isCall ? 'service_call_id' : 'order_id'
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { can } = usePermissions()
  const tabs = TABS.filter((t) => can(t.permission))
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? tabs[0]?.key
  const [info, setInfo] = useState<ServiceInfo | null>(null)
  const [call, setCall] = useState<ServiceCallInfo | null>(null)
  const [machines, setMachines] = useState<Machine[]>([])
  const [entries, setEntries] = useState<SavedEntry[]>([])
  const [certs, setCerts] = useState<Pick<Certificate, 'id' | 'version' | 'status' | 'created_at' | 'locked_at'>[]>([])
  const [form, setForm] = useState<EntryDraft | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const [i, m, e, c] = await Promise.all([
      isCall
        ? supabase.from('service_call_info').select('*').eq('card_id', callId).maybeSingle()
        : supabase.from('order_service_info').select('*').eq('order_id', orderId).maybeSingle(),
      isCall
        ? Promise.resolve({ data: null, error: null })
        : supabase.from('order_machines').select('id, serial_number, archived, machine_types(name)').eq('order_id', orderId).order('serial_number'),
      can('service.log')
        ? supabase
            .from('service_entries')
            .select(
              'id, client_id, order_id, service_call_id, entry_date, kind, hours, notes, created_by_name, updated_by_name, created_at, service_entry_machines(machine_id, notes)',
            )
            .eq(subjectCol, subjectId)
            .eq('archived', false)
            .order('entry_date')
            .order('created_at')
        : Promise.resolve({ data: [], error: null }),
      can('service.certificate')
        ? supabase
            .from('service_certificates')
            .select('id, version, status, created_at, locked_at')
            .eq(subjectCol, subjectId)
            .order('version', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ])
    // No signal: keep what is already on screen (the phone keeps new days until it can send them).
    if (!i.error && isCall) {
      const ci = i.data as ServiceCallInfo | null
      setCall(ci)
      // The call's machines, in the same shape as an order's.
      setMachines((ci?.machines ?? []).map((x) => ({ id: x.machine_id, serial_number: x.serial, archived: false, machine_types: { name: x.machine } })))
    }
    if (!i.error && !isCall) setInfo((i.data as ServiceInfo | null) ?? null)
    if (!m.error && !isCall) setMachines((m.data as unknown as Machine[] | null) ?? [])
    if (!e.error) setEntries((e.data as SavedEntry[] | null) ?? [])
    if (!c.error) setCerts((c.data as typeof certs | null) ?? [])
    const err = i.error ?? m.error ?? e.error ?? c.error
    if (err && navigator.onLine) toast.error(friendlyError(err))
  }, [orderId, callId, isCall, subjectCol, subjectId, can])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  // Entries waiting on this phone: reload the log when they get saved.
  const { items: outbox } = useOutbox(load)

  const days: Day[] = useMemo(() => {
    const waiting = outbox.filter((o) => (isCall ? o.draft.service_call_id === callId : o.draft.order_id === orderId))
    const waitingIds = new Set(waiting.map((w) => w.draft.client_id))
    return [
      ...entries.filter((e) => !waitingIds.has(e.client_id)).map((e) => ({ draft: toDraft(e), saved: e, waiting: false, error: null })),
      ...waiting.map((w) => ({ draft: w.draft, saved: entries.find((e) => e.client_id === w.draft.client_id) ?? null, waiting: true, error: w.error })),
    ].sort((a, b) => a.draft.entry_date.localeCompare(b.draft.entry_date))
  }, [entries, outbox, orderId, callId, isCall])

  const machineById = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines])
  const liveMachines = machines.filter((m) => !m.archived)

  async function saveDay() {
    if (!form) return
    if (!form.entry_date) return toast.error('Enter the date.')
    if (form.hours.trim() !== '' && (!Number.isFinite(Number(form.hours)) || Number(form.hours) < 0 || Number(form.hours) > 24)) {
      return toast.error('Hours must be between 0 and 24.')
    }
    setSaving(true)
    const saved = await queueEntry(form)
    setSaving(false)
    setForm(null)
    if (saved) {
      toast.success('Day saved.')
      load()
    } else {
      toast.warning('Not yet saved: the entry is kept on this device and will be sent automatically when the connection is back.', { duration: 8000 })
    }
  }

  async function archiveDay(d: Day) {
    if (!supabase || !d.saved) return
    if (
      !(await confirmAction(`Archive the ${KIND_LABEL[d.draft.kind].toLowerCase()} on ${showDate(d.draft.entry_date)}?`, {
        confirmLabel: 'Archive',
        danger: true,
      }))
    )
      return
    const { error } = await supabase.rpc('archive_service_entry', { p_entry: d.saved.id })
    if (error) return toast.error(friendlyError(error))
    load()
  }

  async function createCertificate() {
    if (!supabase) return
    const { data, error } = isCall
      ? await supabase.rpc('create_service_report', { p_card: callId })
      : await supabase.rpc('create_certificate', { p_order: orderId })
    if (error) return toast.error(friendlyError(error))
    navigate(`/service/certificates/${data as string}`)
  }

  const toggleMachine = (id: string) =>
    form &&
    setForm({
      ...form,
      machines: form.machines.some((m) => m.machine_id === id)
        ? form.machines.filter((m) => m.machine_id !== id)
        : [...form.machines, { machine_id: id, notes: '' }],
    })

  if (isCall ? !call : !info)
    return (
      <Can permission="service">
        <p className="p-6 text-center text-slate-500">Loading…</p>
      </Can>
    )

  return (
    <Can permission="service">
      <div className="mx-auto max-w-3xl space-y-4">
        <div>
          <Link to="/service" className="text-sm text-slate-600 underline">
            ← Service
          </Link>
          {isCall && call ? (
            <ServiceCallHeader call={call} onChanged={load} />
          ) : info ? (
            <>
            <h1 className="mt-1 text-2xl font-semibold">Order {info.order_code}</h1>
            <p className="text-sm text-slate-700">
              {info.customer_name}
              {info.customer_company ? ` · ${info.customer_company}` : ''}
              {info.customer_country ? ` · ${countryFlag(info.customer_country)} ${info.customer_country}` : ''}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {serviceDates(info.service_start, info.service_end) || 'Dates not set'}
              {info.technician_name ? ` · Technician: ${info.technician_name}` : ''}
              {info.training_days !== null ? ` · ${Number(info.training_days)} on-site day${Number(info.training_days) === 1 ? '' : 's'}` : ''}
              {info.travel_days !== null ? ` · ${Number(info.travel_days)} travel day${Number(info.travel_days) === 1 ? '' : 's'}` : ''}
            </p>
            <Can permission="order.page">
              <Link to={`/orders/${orderId}`} className="text-sm text-blue-700 underline">
                Open the Order
              </Link>
            </Can>
            </>
          ) : null}
        </div>

        {tabs.length > 1 && (
          <div className="flex gap-1 border-b border-slate-200" role="tablist">
            {tabs.map((t) => (
              <Can key={t.key} permission={t.permission}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.key ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}
                  onClick={() => setParams({ tab: t.key }, { replace: true })}
                >
                  {isCall ? (t.callLabel ?? t.label) : t.label}
                </button>
              </Can>
            ))}
          </div>
        )}

        {/* ---------- Day log ---------- */}
        {tab === 'log' && (
          <Can permission="service.log">
            <div className="space-y-3">
              <Can permission="service.log" level="edit">
                {form ? (
                  <section className="space-y-3 rounded-lg border border-slate-300 bg-white p-4">
                    <h2 className="font-semibold">{entries.some((e) => e.client_id === form.client_id) ? 'Change Day' : 'Add a Day'}</h2>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Date" htmlFor="day-date">
                        <input
                          id="day-date"
                          type="date"
                          className={inputClass}
                          value={form.entry_date}
                          onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                        />
                      </Field>
                      <Field label="Hours" htmlFor="day-hours">
                        <input
                          id="day-hours"
                          inputMode="decimal"
                          className={inputClass}
                          value={form.hours}
                          placeholder="8"
                          onChange={(e) => setForm({ ...form, hours: e.target.value })}
                        />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Kind of day">
                      {(['onsite', 'travel'] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={form.kind === k}
                          className={`rounded-md border px-3 py-3 text-sm font-medium ${form.kind === k ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                          onClick={() => setForm({ ...form, kind: k })}
                        >
                          {KIND_LABEL[k]}
                        </button>
                      ))}
                    </div>
                    <Field label="General notes" htmlFor="day-notes">
                      <textarea
                        id="day-notes"
                        rows={3}
                        className={inputClass}
                        value={form.notes}
                        onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      />
                    </Field>
                    <div>
                      <p className="mb-1 text-sm font-medium text-slate-700">Machines worked on</p>
                      {liveMachines.length === 0 && <p className="text-sm text-slate-500">{isCall ? 'No machines are on this service call yet. Add them with Edit Details.' : 'This order has no machines.'}</p>}
                      <div className="flex flex-wrap gap-2">
                        {liveMachines.map((m) => {
                          const on = form.machines.some((x) => x.machine_id === m.id)
                          return (
                            <label
                              key={m.id}
                              className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm ${on ? 'border-blue-700 bg-blue-50 text-blue-900' : 'border-slate-300 bg-white'}`}
                            >
                              <input type="checkbox" className="h-4 w-4" checked={on} onChange={() => toggleMachine(m.id)} />
                              {machineName(m)}
                              {m.serial_number ? (
                                <SerialNumber serial={m.serial_number} className="text-xs" />
                              ) : (
                                <span className="text-xs text-slate-500">no serial</span>
                              )}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                    {form.machines.map((fm) => {
                      const m = machineById.get(fm.machine_id)
                      return (
                        <Field key={fm.machine_id} label={`Notes for ${machineName(m)} ${m?.serial_number ?? ''}`} htmlFor={`mn-${fm.machine_id}`}>
                          <textarea
                            id={`mn-${fm.machine_id}`}
                            rows={2}
                            className={inputClass}
                            value={fm.notes}
                            onChange={(e) =>
                              setForm({ ...form, machines: form.machines.map((x) => (x.machine_id === fm.machine_id ? { ...x, notes: e.target.value } : x)) })
                            }
                          />
                        </Field>
                      )
                    })}
                    <div className="flex justify-end gap-2">
                      <button type="button" className={secondaryButtonClass} onClick={() => setForm(null)} disabled={saving}>
                        Cancel
                      </button>
                      <button type="button" className={buttonClass} onClick={saveDay} disabled={saving}>
                        {saving ? 'Saving…' : 'Save Day'}
                      </button>
                    </div>
                  </section>
                ) : (
                  <button type="button" className={`${buttonClass} w-full py-3`} onClick={() => setForm(blankDraft({ order_id: isCall ? null : orderId, service_call_id: isCall ? callId : null }))}>
                    Add a Day
                  </button>
                )}
              </Can>

              {days.length === 0 && (
                <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
                  No days have been logged yet.
                </p>
              )}
              <ol className="relative space-y-3 border-l-2 border-slate-200 pl-4">
                {days.map((d) => (
                  <li
                    key={d.draft.client_id}
                    className={`relative rounded-lg border bg-white p-3 text-sm ${d.waiting ? 'border-amber-400' : 'border-slate-200'}`}
                  >
                    <span
                      className={`absolute top-4 -left-[1.4rem] h-3 w-3 rounded-full ring-2 ring-white ${d.draft.kind === 'travel' ? 'bg-slate-400' : 'bg-blue-600'}`}
                      aria-hidden="true"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{showDate(d.draft.entry_date)}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${d.draft.kind === 'travel' ? 'bg-slate-100 text-slate-700' : 'bg-blue-50 text-blue-800'}`}
                      >
                        {KIND_LABEL[d.draft.kind]}
                      </span>
                      {d.draft.hours && <span className="text-slate-600">{Number(d.draft.hours)} h</span>}
                      {d.waiting && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900" role="status">
                          Not yet saved
                        </span>
                      )}
                      <span className="ml-auto flex gap-3 text-xs">
                        <Can permission="service.log" level="edit">
                          <button type="button" className="underline" onClick={() => setForm(d.draft)}>
                            Edit
                          </button>
                        </Can>
                        {d.waiting && d.error && (
                          <Can permission="service.log" level="edit">
                            <button type="button" className="text-red-700 underline" onClick={() => discardQueued(d.draft.client_id)}>
                              Discard
                            </button>
                          </Can>
                        )}
                        {d.saved && !d.waiting && (
                          <Can permission="service.log.archive" level="edit">
                            <button type="button" className="text-red-700 underline" onClick={() => archiveDay(d)}>
                              Archive
                            </button>
                          </Can>
                        )}
                      </span>
                    </div>
                    {d.waiting && (
                      <p className="mt-1 text-xs text-amber-800">
                        {d.error ? `Could not be saved: ${d.error}` : 'Kept on this device. It is sent automatically when the connection is back.'}
                      </p>
                    )}
                    {d.draft.notes && <p className="mt-1 whitespace-pre-line text-slate-700">{d.draft.notes}</p>}
                    {d.draft.machines.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {d.draft.machines.map((dm) => {
                          const m = machineById.get(dm.machine_id)
                          return (
                            <li key={dm.machine_id} className="rounded bg-slate-50 px-2 py-1">
                              <span className="font-medium">{machineName(m)}</span>{' '}
                              {m?.serial_number && <SerialNumber serial={m.serial_number} className="text-xs" />}
                              {dm.notes && <p className="whitespace-pre-line text-slate-700">{dm.notes}</p>}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    {d.saved && <p className="mt-1 text-xs text-slate-500">By {d.saved.updated_by_name ?? d.saved.created_by_name ?? 'unknown'}</p>}
                  </li>
                ))}
              </ol>

              <Can permission="service.photos">
                <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500">
                  Photos for each day and machine will be available in a future update.
                </p>
              </Can>
            </div>
          </Can>
        )}

        {/* ---------- Per machine ---------- */}
        {tab === 'machines' && (
          <Can permission="service.log.by_machine">
            <div className="space-y-3">
              {liveMachines.length === 0 && <p className="text-sm text-slate-500">{isCall ? 'No machines are on this service call yet. Add them with Edit Details.' : 'This order has no machines.'}</p>}
              {liveMachines.map((m) => {
                const notes = days.filter((d) => d.draft.machines.some((x) => x.machine_id === m.id))
                return (
                  <section key={m.id} className="rounded-lg border border-slate-200 bg-white p-4">
                    <h2 className="font-semibold">
                      {machineName(m)} {m.serial_number && <SerialNumber serial={m.serial_number} className="text-sm font-normal" />}
                    </h2>
                    {notes.length === 0 ? (
                      <p className="mt-1 text-sm text-slate-500">No notes for this machine yet.</p>
                    ) : (
                      <ul className="mt-2 space-y-2 text-sm">
                        {notes.map((d) => {
                          const n = d.draft.machines.find((x) => x.machine_id === m.id)!
                          return (
                            <li key={d.draft.client_id} className="border-l-2 border-slate-200 pl-3">
                              <span className="font-medium">{showDate(d.draft.entry_date)}</span>{' '}
                              <span className="text-xs text-slate-500">{KIND_LABEL[d.draft.kind]}</span>
                              {d.waiting && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">Not yet saved</span>}
                              <p className="whitespace-pre-line text-slate-700">{n.notes || <span className="text-slate-400">Worked on, no notes.</span>}</p>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          </Can>
        )}

        {/* ---------- Certificate ---------- */}
        {tab === 'certificate' && (
          <Can permission="service.certificate">
            <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="font-semibold">{isCall ? 'Service Report' : 'Commissioning Certificate'}</h2>
              {certs.length === 0 && <p className="text-sm text-slate-500">{isCall ? 'No service report has been created for this call yet.' : 'No certificate has been created for this order yet.'}</p>}
              <ul className="divide-y divide-slate-100 text-sm">
                {certs.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link to={`/service/certificates/${c.id}`} className="font-medium text-blue-700 underline">
                      Version {c.version}
                    </Link>
                    <span className="text-slate-600">
                      {c.status === 'signed' ? `Signed ${showDate(c.locked_at)}` : c.status === 'superseded' ? 'Replaced by a corrected version' : 'Draft'}
                    </span>
                  </li>
                ))}
              </ul>
              {!certs.some((c) => c.status === 'draft') && (
                <Can permission="service.certificate.create" level="edit">
                  <button type="button" className={buttonClass} onClick={createCertificate}>
                    {isCall ? 'Create Service Report' : 'Create Certificate'}
                  </button>
                </Can>
              )}
            </section>
          </Can>
        )}
      </div>
    </Can>
  )
}
