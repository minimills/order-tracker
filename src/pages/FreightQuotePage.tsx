// @permission-scope freight.quote
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import SenderLine from '../components/email/SenderLine'
import Can from '../components/Can'
import { buttonClass, Field, inputClass, Section, secondaryButtonClass } from '../components/form'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { useCompany } from '../lib/company'
import { askText, confirmAction } from '../lib/confirm'
import { showDate } from '../lib/dates'
import { callFunction } from '../lib/edgeFunction'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import {
  BULK_TYPES,
  CONTAINER_SIZES,
  copyText,
  crateToItem,
  FREIGHT_DEFAULTS,
  GREETINGS,
  loadAgents,
  loadFreightSettings,
  orderFreightType,
  QUOTE_TYPES,
  quoteBody,
  quoteSubject,
  type CargoItem,
  type FreightAgent,
  type FreightOrderInfo,
  type FreightSettings,
  type QuoteForm,
} from '../lib/freight'
import { usePermissions } from '../lib/permissions'
import { usePreferences } from '../lib/preferences'
import { supabase } from '../lib/supabase'
import { tr } from '../i18n'

type OrderChoice = { id: string; order_code: string; customer_name: string | null }
type Sent = { id: string; agent_name: string | null; to_emails: string[]; subject: string; status: 'sent' | 'failed'; error: string | null; sent_by: string | null; sent_at: string }
const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
const newItem = (): CargoItem => ({ key: `n${Date.now()}${Math.random()}`, qty: '', pkg: '', desc: '', weight: '', l: '', w: '', h: '' })

/** Freight quote request email to a shipping agent, built from the order, the customer and the crating data. */
export default function FreightQuotePage() {
  const [params, setParams] = useSearchParams()
  const orderId = params.get('order') ?? ''
  const { can } = usePermissions()
  const { units } = usePreferences()
  const company = useCompany()
  const maySend = can('freight.quote', 'edit')
  const [settings, setSettings] = useState<FreightSettings>(FREIGHT_DEFAULTS)
  const [agents, setAgents] = useState<FreightAgent[]>([])
  const [orders, setOrders] = useState<OrderChoice[]>([])
  const [info, setInfo] = useState<FreightOrderInfo | null>(null)
  const [agentId, setAgentId] = useState('')
  const [pickupChoice, setPickupChoice] = useState('0')
  const [deliveryChoice, setDeliveryChoice] = useState('new')
  const [f, setF] = useState<QuoteForm>({
    agentName: '', greeting: 'Hi', shipmentType: 'LTL', origin: 'PE', destination: '', pickup: '', delivery: '', businessName: '', notABusiness: false,
    consigneeName: '', consigneePhone: '', consigneeEmail: '', weightUnit: units === 'imperial' ? 'lb' : 'kg', dimUnit: units === 'imperial' ? 'in' : 'cm',
    items: [newItem()], bulkCommodity: 'Fibre-processing machines', bulkItems: '', bulkSpace: '', bulkSpaceUnit: 'sq ft', bulkWeight: '', containerSize: CONTAINER_SIZES[1],
    liftgateOrigin: 'No', liftgateDestination: 'No',
  })
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  // Once the email text is changed by hand, the form no longer rewrites it.
  const [manual, setManual] = useState<{ subject: string; body: string } | null>(null)
  const [sent, setSent] = useState<Sent[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [myName, setMyName] = useState('')

  useBreadcrumbs([{ get label() {
    return tr("Freight")
  }, to: '/freight' }, { label: info ? `Quote Request – Order ${info.order_code}` : 'Freight Quote Request' }])

  const loadSent = useCallback(async () => {
    if (!supabase || !orderId) return setSent([])
    const { data } = await supabase.from('freight_quote_requests').select('id, agent_name, to_emails, subject, status, error, sent_by, sent_at').eq('order_id', orderId).order('sent_at', { ascending: false })
    setSent((data as Sent[] | null) ?? [])
  }, [orderId])

  useEffect(() => {
    if (!supabase) return
    Promise.all([loadFreightSettings(), loadAgents()]).then(([s, a]) => {
      setSettings(s)
      setAgents(a)
      const first = a.find((x) => !x.archived)
      if (first) {
        setAgentId(first.id)
        setTo(first.contact_email ?? '')
        setF((x) => ({ ...x, agentName: first.contact_name ?? '' }))
      }
      const loc = s.pickup_locations[0]
      if (loc) setF((x) => ({ ...x, pickup: `${loc.name} ${loc.address}`.trim() }))
      else setPickupChoice('new')
    })
    supabase.rpc('current_user_name').then(({ data }) => setMyName(typeof data === 'string' ? data : ''))
    fetchAll<OrderChoice>(() => supabase!.from('order_summary').select('id, order_code, customer_name').eq('archived', false).order('order_number', { ascending: false })).then((r) => setOrders(r.data))
  }, [])

  // The order: consignee, destination and crates.
  useEffect(() => {
    if (!supabase || !orderId) {
      // oxlint-disable-next-line react/set-state-in-effect
      setInfo(null)
      return
    }
    supabase.rpc('freight_order_info', { p_order: orderId }).then(({ data, error }) => {
      if (error) return toast.error(friendlyError(error))
      const o = data as FreightOrderInfo
      setInfo(o)
      setManual(null)
      setF((x) => ({
        ...x,
        shipmentType: orderFreightType(o.freight_type) || x.shipmentType,
        destination: o.state_province || o.country || '',
        delivery: [o.state_province, o.country].filter(Boolean).join(', '),
        businessName: o.customer_company ?? '',
        notABusiness: !o.customer_company,
        consigneeName: o.customer_name ?? '',
        consigneePhone: o.customer_phone ?? '',
        consigneeEmail: o.customer_emails?.[0] ?? '',
        items: o.crates.length ? o.crates.map((c) => crateToItem(c, x.weightUnit, x.dimUnit)) : [newItem()],
        bulkItems: o.crates.length ? String(o.crates.length) : '',
        bulkWeight: o.crates.length ? String(Math.round(o.crates.reduce((s, c) => s + Number(c.weight_kg ?? 0), 0) * (x.weightUnit === 'kg' ? 1 : 2.2046226218))) : '',
        liftgateDestination: o.delivery_equipment === 'Liftgate' ? 'Yes' : 'No',
      }))
    })
    // oxlint-disable-next-line react/set-state-in-effect
    loadSent()
  }, [orderId, loadSent])

  const up = (patch: Partial<QuoteForm>) => setF((x) => ({ ...x, ...patch }))
  const agent = agents.find((a) => a.id === agentId) ?? null
  const bulk = BULK_TYPES.includes(f.shipmentType)
  const generated = useMemo(() => ({ subject: quoteSubject(f, company.name || 'Belfast Mini Mills'), body: quoteBody(f, [myName, company.name || 'Belfast Mini Mills'].filter(Boolean).join('\n')) }), [f, company.name, myName])
  const email = manual ?? generated

  async function changeAgent(v: string) {
    if (v === 'new') {
      const name = await askText(tr("Name of the new shipping agent (the company)"), { get label() {
    return tr("Shipping agent")
  }, get confirmLabel() {
    return tr("Add Shipping Agent")
  } })
      if (!name?.trim() || !supabase) return
      const { data, error } = await supabase.rpc('add_freight_agent', { p_name: name.trim() })
      if (error) return toast.error(friendlyError(error))
      setAgents(await loadAgents())
      setAgentId(data as string)
      setTo('')
      return up({ agentName: '' })
    }
    const a = agents.find((x) => x.id === v)
    setAgentId(v)
    setTo(a?.contact_email ?? '')
    up({ agentName: a?.contact_name ?? '' })
  }

  /** kg / cm or lb / in: the crate lines are worked out again from the crating data. */
  function changeUnits(weightUnit: 'kg' | 'lb', dimUnit: 'cm' | 'in') {
    const crates = new Map((info?.crates ?? []).map((c) => [c.id, c]))
    up({
      weightUnit,
      dimUnit,
      items: f.items.map((i) => {
        const c = crates.get(i.key)
        return c ? { ...crateToItem(c, weightUnit, dimUnit), qty: i.qty, pkg: i.pkg, desc: i.desc } : i
      }),
    })
  }
  const setItem = (key: string, patch: Partial<CargoItem>) => up({ items: f.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) })

  const copy = async (what: 'subject' | 'body') => {
    if (await copyText(email[what])) {
      setCopied(what)
      window.setTimeout(() => setCopied(null), 1500)
    } else toast.error(tr("The text could not be copied. Select it and copy it by hand."))
  }

  async function send() {
    if (!split(to).length) return toast.error(tr("Enter the shipping agent’s email address in To."))
    if (!email.subject.trim() || !email.body.trim()) return toast.error(tr("The email needs a subject and a message."))
    if (!(await confirmAction(tr("Send this quote request to {{value}}?", { value: split(to).join(', ') }), { get confirmLabel() {
    return tr("Send Email")
  } }))) return
    setBusy(true)
    const r = await callFunction<{ message?: string }>('send-email', {
      action: 'freight_quote_send', order_id: orderId || null, agent_id: agentId || null, agent_name: agent?.name ?? null,
      to: split(to), cc: split(cc), subject: email.subject.trim(), body: email.body,
    })
    setBusy(false)
    if (!r.ok) return toast.error(r.message)
    toast.success(r.message || tr("Quote request sent."))
    loadSent()
  }

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <Link to="/freight" className="text-sm text-slate-600 underline">
          {tr("← Freight")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{tr("Freight Quote Request")}</h1>
        <p className="text-sm text-slate-600">{tr("Fill in the shipment; the email on the right is written as you go. Send it from here, or copy it into your own email.")}</p>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-4">
          <Section title={tr("Agent and Shipment")}>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label={tr("Order")} htmlFor="fq-order" hint={tr("Fills in the consignee and the crates.")}>
                <select id="fq-order" className={inputClass} value={orderId} onChange={(e) => setParams(e.target.value ? { order: e.target.value } : {}, { replace: true })}>
                  <option value="">{tr("No order")}</option>
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.order_code} · {o.customer_name ?? ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={tr("Shipping agent")} htmlFor="fq-agent">
                <select id="fq-agent" className={inputClass} value={agentId} onChange={(e) => changeAgent(e.target.value)}>
                  <option value="">{tr("Choose…")}</option>
                  {agents
                    .filter((a) => !a.archived)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  {can('freight.agents.add', 'edit') && <option value="new">{tr("Add new…")}</option>}
                </select>
              </Field>
              <Field label={tr("Contact name")} htmlFor="fq-contact" hint={tr("The email greets them by first name. Saved contacts are set in Admin → Freight Settings.")}>
                <input id="fq-contact" className={inputClass} value={f.agentName} onChange={(e) => up({ agentName: e.target.value })} />
              </Field>
              <Field label={tr("Greeting")} htmlFor="fq-greeting">
                <select id="fq-greeting" className={inputClass} value={f.greeting} onChange={(e) => up({ greeting: e.target.value })}>
                  {GREETINGS.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </Field>
              <Field label={tr("Shipment type")} htmlFor="fq-type">
                <select id="fq-type" className={inputClass} value={f.shipmentType} onChange={(e) => up({ shipmentType: e.target.value })}>
                  {QUOTE_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Field label={tr("Origin (province or state)")} htmlFor="fq-origin">
                <input id="fq-origin" className={inputClass} value={f.origin} placeholder={tr("For example PE")} onChange={(e) => up({ origin: e.target.value })} />
              </Field>
              <Field label={tr("Destination (province, state or country)")} htmlFor="fq-dest">
                <input id="fq-dest" className={inputClass} value={f.destination} placeholder={tr("For example NY")} onChange={(e) => up({ destination: e.target.value })} />
              </Field>
            </div>
          </Section>

          <Section title={tr("Pick-up and Delivery")}>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
              <Field label={tr("Pick-up")} htmlFor="fq-pickup-choice">
                <select
                  id="fq-pickup-choice"
                  className={inputClass}
                  value={pickupChoice}
                  onChange={(e) => {
                    setPickupChoice(e.target.value)
                    const loc = settings.pickup_locations[Number(e.target.value)]
                    up({ pickup: e.target.value === 'new' ? '' : `${loc?.name ?? ''} ${loc?.address ?? ''}`.trim() })
                  }}
                >
                  {settings.pickup_locations.map((l, i) => (
                    <option key={i} value={i}>
                      {l.name} — {l.address}
                    </option>
                  ))}
                  <option value="new">{tr("Type the pick-up address")}</option>
                </select>
              </Field>
              {pickupChoice === 'new' && (
                <Field label={tr("Pick-up address")} htmlFor="fq-pickup">
                  <input id="fq-pickup" className={inputClass} value={f.pickup} onChange={(e) => up({ pickup: e.target.value })} />
                </Field>
              )}
              <Field label={tr("Delivery")} htmlFor="fq-delivery-choice">
                <select
                  id="fq-delivery-choice"
                  className={inputClass}
                  value={deliveryChoice}
                  onChange={(e) => {
                    setDeliveryChoice(e.target.value)
                    const loc = settings.pickup_locations[Number(e.target.value)]
                    if (e.target.value !== 'new') up({ delivery: `${loc?.name ?? ''} ${loc?.address ?? ''}`.trim() })
                  }}
                >
                  <option value="new">{tr("Type the delivery address")}</option>
                  {settings.pickup_locations.map((l, i) => (
                    <option key={i} value={i}>
                      {l.name} — {l.address}
                    </option>
                  ))}
                </select>
              </Field>
              {deliveryChoice === 'new' && (
                <Field label={tr("Delivery address")} htmlFor="fq-delivery" hint={info ? tr("Customers have no street address saved: complete it here.") : undefined}>
                  <input id="fq-delivery" className={inputClass} value={f.delivery} placeholder={tr("Street, town, province or state, postal code, country")} onChange={(e) => up({ delivery: e.target.value })} />
                </Field>
              )}
            </div>
          </Section>

          <Section title={tr("Consignee")}>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label={tr("Business name")} htmlFor="fq-business">
                <input id="fq-business" className={inputClass} value={f.businessName} disabled={f.notABusiness} onChange={(e) => up({ businessName: e.target.value })} />
                <label className="mt-1 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.notABusiness} onChange={(e) => up({ notABusiness: e.target.checked })} /> {tr("Not a business")}
                </label>
              </Field>
              <Field label={tr("Consignee name")} htmlFor="fq-cname">
                <input id="fq-cname" className={inputClass} value={f.consigneeName} onChange={(e) => up({ consigneeName: e.target.value })} />
              </Field>
              <Field label={tr("Consignee phone")} htmlFor="fq-cphone">
                <input id="fq-cphone" className={inputClass} value={f.consigneePhone} onChange={(e) => up({ consigneePhone: e.target.value })} />
              </Field>
              <Field label={tr("Consignee email")} htmlFor="fq-cemail">
                <input id="fq-cemail" className={inputClass} value={f.consigneeEmail} onChange={(e) => up({ consigneeEmail: e.target.value })} />
              </Field>
            </div>
          </Section>

          <Section
            title={tr("Cargo")}
            aside={
              <div className="flex rounded-md border border-slate-300 bg-white p-0.5 text-sm" role="radiogroup" aria-label={tr("Units")}>
                {(
                  [
                    ['kg', 'cm', 'kg / cm'],
                    ['lb', 'in', 'lb / in'],
                  ] as const
                ).map(([w, d, label]) => (
                  <button key={w} type="button" role="radio" aria-checked={f.weightUnit === w} className={`rounded px-3 py-1 ${f.weightUnit === w ? 'bg-slate-900 text-white' : ''}`} onClick={() => changeUnits(w, d)}>
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            {bulk ? (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]">
                <Field label={tr("Commodity")} htmlFor="fq-commodity">
                  <input id="fq-commodity" className={inputClass} value={f.bulkCommodity} onChange={(e) => up({ bulkCommodity: e.target.value })} />
                </Field>
                <Field label={tr("Total number of items")} htmlFor="fq-bitems">
                  <input id="fq-bitems" inputMode="numeric" className={inputClass} value={f.bulkItems} onChange={(e) => up({ bulkItems: e.target.value })} />
                </Field>
                <Field label={tr("Space")} htmlFor="fq-space">
                  <input id="fq-space" inputMode="decimal" className={inputClass} value={f.bulkSpace} onChange={(e) => up({ bulkSpace: e.target.value })} />
                </Field>
                <Field label={tr("Space unit")} htmlFor="fq-spaceunit">
                  <select id="fq-spaceunit" className={inputClass} value={f.bulkSpaceUnit} onChange={(e) => up({ bulkSpaceUnit: e.target.value })}>
                    <option value="sq ft">{tr("sq ft")}</option>
                    <option value="m³">{tr("cubic metres (m³)")}</option>
                  </select>
                </Field>
                <Field label={tr("Total weight ({{weightUnit}})", { weightUnit: f.weightUnit })} htmlFor="fq-bweight">
                  <input id="fq-bweight" inputMode="decimal" className={inputClass} value={f.bulkWeight} onChange={(e) => up({ bulkWeight: e.target.value })} />
                </Field>
                {f.shipmentType === 'FCL' && (
                  <Field label={tr("Container size required")} htmlFor="fq-container">
                    <select id="fq-container" className={inputClass} value={f.containerSize} onChange={(e) => up({ containerSize: e.target.value })}>
                      {CONTAINER_SIZES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            ) : (
              <>
                {info && (
                  <p className="mb-2 text-xs text-slate-600">
                    {info.crates.length ? tr("{{length}} {{value}} from the crating data of order {{order_code}}. Lines can be changed.", { length: info.crates.length, value: info.crates.length === 1 ? 'crate' : 'crates', order_code: info.order_code }) : tr("No crates have been entered on order {{order_code}} yet: type the cargo.", { order_code: info.order_code })}
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs text-slate-600">
                      <tr>
                        <th className="py-1 pr-2 font-semibold">{tr("Qty")}</th>
                        <th className="py-1 pr-2 font-semibold">{tr("Packaging")}</th>
                        <th className="py-1 pr-2 font-semibold">{tr("Description")}</th>
                        <th className="py-1 pr-2 font-semibold">{tr("Weight (")}{f.weightUnit})</th>
                        <th className="py-1 pr-2 font-semibold">L ({f.dimUnit})</th>
                        <th className="py-1 pr-2 font-semibold">W</th>
                        <th className="py-1 pr-2 font-semibold">H</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {f.items.map((i, n) => (
                        <tr key={i.key}>
                          {(['qty', 'pkg', 'desc', 'weight', 'l', 'w', 'h'] as const).map((k) => (
                            <td key={k} className="py-1 pr-2">
                              <input
                                aria-label={tr("Item {{value}} {{k}}", { value: n + 1, k: k })}
                                className={`${inputClass} ${k === 'desc' ? 'min-w-40' : k === 'pkg' ? 'min-w-24' : 'min-w-16'}`}
                                inputMode={k === 'pkg' || k === 'desc' ? 'text' : 'decimal'}
                                value={i[k]}
                                onChange={(e) => setItem(i.key, { [k]: e.target.value })}
                              />
                            </td>
                          ))}
                          <td className="py-1">
                            <button type="button" className="px-2 text-lg text-slate-500" aria-label={tr("Remove item {{value}}", { value: n + 1 })} onClick={() => up({ items: f.items.length > 1 ? f.items.filter((x) => x.key !== i.key) : [newItem()] })}>
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button type="button" className={`${secondaryButtonClass} mt-2`} onClick={() => up({ items: [...f.items, newItem()] })}>
                  {tr("Add Cargo Item")}
                </button>
              </>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label={tr("Lift-gate at origin")} htmlFor="fq-lo">
                <select id="fq-lo" className={inputClass} value={f.liftgateOrigin} onChange={(e) => up({ liftgateOrigin: e.target.value as 'Yes' | 'No' })}>
                  <option>{tr("No")}</option>
                  <option>{tr("Yes")}</option>
                </select>
              </Field>
              <Field label={tr("Lift-gate at destination")} htmlFor="fq-ld">
                <select id="fq-ld" className={inputClass} value={f.liftgateDestination} onChange={(e) => up({ liftgateDestination: e.target.value as 'Yes' | 'No' })}>
                  <option>{tr("No")}</option>
                  <option>{tr("Yes")}</option>
                </select>
              </Field>
            </div>
          </Section>
        </div>

        <aside className="w-full shrink-0 space-y-4 xl:sticky xl:top-4 xl:w-[30rem]">
          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm md:p-6" aria-label={tr("Email")}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold">{tr("Email")}</h2>
              {manual && (
                <button type="button" className="text-xs underline" onClick={() => setManual(null)}>
                  {tr("Write Again From the Form")}
                </button>
              )}
            </div>
            {manual && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">{tr("You changed the text by hand, so the form no longer rewrites it.")}</p>}
            <Can permission="freight.quote" level="edit">
              <Field label={tr("To")} htmlFor="fq-to" hint={tr("Separate several addresses with commas.")}>
                <input id="fq-to" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label="CC" htmlFor="fq-cc">
                <input id="fq-cc" className={inputClass} value={cc} onChange={(e) => setCc(e.target.value)} />
              </Field>
            </Can>
            <Field label={tr("Subject")} htmlFor="fq-subject">
              <div className="flex gap-2">
                <input id="fq-subject" className={inputClass} value={email.subject} onChange={(e) => setManual({ ...email, subject: e.target.value })} />
                <button type="button" className={secondaryButtonClass} onClick={() => copy('subject')}>
                  {copied === 'subject' ? tr("Copied") : tr("Copy")}
                </button>
              </div>
            </Field>
            <Field label={tr("Message")} htmlFor="fq-body">
              <textarea id="fq-body" rows={18} className={`${inputClass} font-mono text-xs`} value={email.body} onChange={(e) => setManual({ ...email, body: e.target.value })} />
            </Field>
            {maySend && <SenderLine />}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryButtonClass} onClick={() => copy('body')}>
                {copied === 'body' ? tr("Copied") : tr("Copy Message")}
              </button>
              {maySend && (
                <button type="button" className={buttonClass} onClick={send} disabled={busy}>
                  {busy ? tr("Sending…") : tr("Send Email")}
                </button>
              )}
            </div>
          </section>

          {sent.length > 0 && (
            <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <h2 className="mb-2 font-semibold">{tr("Quote Requests Sent for This Order")}</h2>
              <ul className="divide-y divide-slate-100">
                {sent.map((s) => (
                  <li key={s.id} className="py-2">
                    <span className={s.status === 'sent' ? 'text-green-800' : 'text-red-700'}>{s.status === 'sent' ? tr("Sent") : tr("Not sent")}</span> {showDate(s.sent_at.slice(0, 10))} {tr("to")} {s.to_emails.join(', ')}
                    {s.agent_name ? ` (${s.agent_name})` : ''}
                    <span className="block text-xs text-slate-500">
                      {s.subject}
                      {s.sent_by ? tr(" · by {{sent_by}}", { sent_by: s.sent_by }) : ''}
                    </span>
                    {s.error && <span className="block text-xs text-red-700">{s.error}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
