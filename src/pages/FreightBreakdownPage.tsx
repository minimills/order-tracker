// @permission-scope freight.breakdowns
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import { buttonClass, Field, inputClass, narrowInputClass, Section, secondaryButtonClass } from '../components/form'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { askText, confirmAction } from '../lib/confirm'
import { fetchAll } from '../lib/fetchAll'
import { formatMoney, friendlyError } from '../lib/format'
import {
  calcBreakdown,
  copyText,
  evaluateExpression,
  FREIGHT_DEFAULTS,
  FREIGHT_TYPES,
  insuranceFor,
  loadAgents,
  loadFreightSettings,
  orderFreightType,
  type Breakdown,
  type FreightAgent,
  type FreightCurrency,
  type FreightOrderInfo,
  type FreightSettings,
  type FreightType,
} from '../lib/freight'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { ACTION } from '../lib/wording'
import PrintButton from '../components/print/PrintButton'
import { tr } from '../i18n'

type Form = {
  order_id: string
  customer_name: string
  quote_number: string
  invoice_number: string
  ship_date: string
  freight_type: FreightType
  currency: FreightCurrency
  exchange_rate: string
  invoice_total: string
  agent_id: string
  agent_ref: string
  sub_contractor: string
  carrier: string
  tracking_number: string
  cargo_value: string
  freight: string
  insurance: string
  insurance_auto: boolean
  broker_fees: string
  broker_standard: boolean
  hourly_rate: string
  hours: string
  plywood_rate: string
  plywood_sheets: string
  margin_pct: string
  notes: string
}

const num = (v: string) => {
  const n = parseFloat(v.replace(/[,$\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const str = (v: number | null | undefined) => (v == null || Number(v) === 0 ? '' : String(Number(v)))
type OrderChoice = { id: string; order_code: string; customer_name: string | null }

function blank(s: FreightSettings, agents: FreightAgent[]): Form {
  const first = agents.find((a) => !a.archived)
  return {
    order_id: '', customer_name: '', quote_number: '', invoice_number: '', ship_date: '', freight_type: 'LTL', currency: 'CAD',
    exchange_rate: String(s.exchange_rate), invoice_total: '', agent_id: first?.id ?? '', agent_ref: '', sub_contractor: '', carrier: '', tracking_number: '',
    cargo_value: '', freight: '', insurance: '', insurance_auto: !!first?.auto_insurance, broker_fees: '', broker_standard: false,
    hourly_rate: String(s.rates.CAD.hourly), hours: '', plywood_rate: String(s.rates.CAD.plywood), plywood_sheets: '', margin_pct: '', notes: '',
  }
}

/** One shipment cost breakdown: details from the order, costs, results, save, print. */
export default function FreightBreakdownPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { can } = usePermissions()
  const mayEdit = can('freight.breakdowns', 'edit')
  const [settings, setSettings] = useState<FreightSettings>(FREIGHT_DEFAULTS)
  const [agents, setAgents] = useState<FreightAgent[]>([])
  const [orders, setOrders] = useState<OrderChoice[]>([])
  const [f, setF] = useState<Form | null>(null)
  const [saved, setSaved] = useState<Breakdown | null>(null)
  const [orderCode, setOrderCode] = useState<string | null>(null)
  const [filled, setFilled] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useBreadcrumbs([
    { get label() {
    return tr("Freight")
  }, to: '/freight?tab=breakdowns' },
    { label: id ? `Cost Breakdown${saved?.customer_name ? ` – ${saved.customer_name}` : ''}` : 'New Cost Breakdown' },
  ])

  /** Fills the form from an order (new breakdowns, or after choosing another order). */
  const fillFromOrder = useCallback(async (orderId: string, base: Form, s: FreightSettings): Promise<Form> => {
    if (!supabase || !orderId) return { ...base, order_id: '' }
    const { data, error } = await supabase.rpc('freight_order_info', { p_order: orderId })
    if (error) {
      toast.error(friendlyError(error))
      return base
    }
    const o = data as FreightOrderInfo
    const cur: FreightCurrency = o.currency === 'USD' ? 'USD' : 'CAD'
    setOrderCode(o.order_code)
    const got = ['customer', 'currency']
    if (o.quote_number) got.push('quote #')
    if (o.invoice_number) got.push('invoice #')
    if (o.order_total != null) got.push('invoice total')
    if (orderFreightType(o.freight_type)) got.push('freight type')
    if (o.actual_ship_date) got.push('ship date')
    if (o.crating_hours != null) got.push('crating hours and plywood sheets')
    setFilled(got)
    return {
      ...base,
      order_id: o.order_id,
      customer_name: o.customer_company || o.customer_name || '',
      quote_number: o.quote_number ?? '',
      invoice_number: o.invoice_number ?? '',
      ship_date: o.actual_ship_date ?? '',
      freight_type: orderFreightType(o.freight_type) || base.freight_type,
      currency: cur,
      exchange_rate: cur === 'USD' ? base.exchange_rate || String(s.exchange_rate) : base.exchange_rate,
      invoice_total: o.order_total != null ? String(Number(o.order_total)) : base.invoice_total,
      hourly_rate: String(s.rates[cur].hourly),
      plywood_rate: String(s.rates[cur].plywood),
      hours: str(o.crating_hours),
      plywood_sheets: str(o.plywood_sheets),
    }
  }, [])

  useEffect(() => {
    if (!supabase) return
    let off = false
    ;(async () => {
      const [s, a] = await Promise.all([loadFreightSettings(), loadAgents()])
      if (off) return
      setSettings(s)
      setAgents(a)
      if (id) {
        const { data } = await supabase.from('freight_breakdowns').select('*').eq('id', id).maybeSingle()
        if (off) return
        const b = data as Breakdown | null
        if (!b) return setMissing(true)
        setSaved(b)
        setF({
          order_id: b.order_id ?? '', customer_name: b.customer_name ?? '', quote_number: b.quote_number ?? '', invoice_number: b.invoice_number ?? '',
          ship_date: b.ship_date ?? '', freight_type: b.freight_type, currency: b.currency, exchange_rate: b.currency === 'USD' ? String(Number(b.exchange_rate)) : String(s.exchange_rate),
          invoice_total: str(b.invoice_total), agent_id: b.agent_id ?? '', agent_ref: b.agent_ref ?? '', sub_contractor: b.sub_contractor ?? '', carrier: b.carrier ?? '',
          tracking_number: b.tracking_number ?? '', cargo_value: str(b.cargo_value), freight: str(b.freight), insurance: str(b.insurance), insurance_auto: b.insurance_auto,
          broker_fees: str(b.broker_fees), broker_standard: b.broker_standard, hourly_rate: String(Number(b.hourly_rate)), hours: str(b.hours),
          plywood_rate: String(Number(b.plywood_rate)), plywood_sheets: str(b.plywood_sheets), margin_pct: str(b.margin_pct), notes: b.notes ?? '',
        })
        if (b.order_id) {
          const { data: o } = await supabase.from('order_summary').select('order_code').eq('id', b.order_id).maybeSingle()
          if (!off) setOrderCode((o?.order_code as string | undefined) ?? null)
        }
      } else {
        const start = blank(s, a)
        const order = params.get('order') ?? ''
        setF(order ? await fillFromOrder(order, start, s) : start)
      }
    })()
    fetchAll<OrderChoice>(() => supabase!.from('order_summary').select('id, order_code, customer_name').eq('archived', false).order('order_number', { ascending: false })).then(
      (r) => !off && setOrders(r.data),
    )
    return () => {
      off = true
    }
    // Loads once per breakdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const agent = agents.find((a) => a.id === f?.agent_id) ?? null
  const invoice = f ? evaluateExpression(f.invoice_total) : 0
  const isSum = !!f && /[+\-*/]/.test(f.invoice_total.trim().slice(1))
  const insurance = f ? (f.insurance_auto ? insuranceFor(num(f.cargo_value), num(f.freight), settings) : num(f.insurance)) : 0
  const numbers = useMemo(
    () =>
      f
        ? {
            invoice_total: invoice ?? 0, cargo_value: num(f.cargo_value), freight: num(f.freight), insurance, broker_fees: num(f.broker_fees),
            hourly_rate: num(f.hourly_rate), hours: num(f.hours), plywood_rate: num(f.plywood_rate), plywood_sheets: num(f.plywood_sheets), margin_pct: num(f.margin_pct),
          }
        : null,
    [f, invoice, insurance],
  )
  const r = numbers ? calcBreakdown(numbers) : null

  if (missing) return <p className="rounded-md bg-amber-50 p-4 text-sm text-amber-900">{tr("That cost breakdown could not be found. It may have been removed.")}</p>
  if (!f || !numbers || !r) return <p className="py-8 text-center text-slate-500">{tr("Loading…")}</p>

  const up = (patch: Partial<Form>) => setF({ ...f, ...patch })
  const money = (n: number) => formatMoney(n, f.currency)
  const fx = f.currency === 'USD' ? num(f.exchange_rate) : 1
  const ro = !mayEdit

  function changeCurrency(c: FreightCurrency) {
    // Handling rates follow the currency (they can still be changed afterwards).
    up({ currency: c, hourly_rate: String(settings.rates[c].hourly), plywood_rate: String(settings.rates[c].plywood), broker_fees: f!.broker_standard ? String(settings.broker_fee) : f!.broker_fees })
  }

  async function changeAgent(v: string) {
    if (v !== 'new') {
      const a = agents.find((x) => x.id === v)
      return up({ agent_id: v, insurance_auto: !!a?.auto_insurance, sub_contractor: a?.sub_contractor ? f!.sub_contractor : '' })
    }
    const name = await askText(tr("Name of the new shipping agent"), { get label() {
    return tr("Shipping agent")
  }, get confirmLabel() {
    return tr("Add Shipping Agent")
  } })
    if (!name?.trim() || !supabase) return
    const { data, error } = await supabase.rpc('add_freight_agent', { p_name: name.trim() })
    if (error) return toast.error(friendlyError(error))
    setAgents(await loadAgents())
    up({ agent_id: data as string, insurance_auto: false })
  }

  async function changeOrder(v: string) {
    if (!v) {
      setOrderCode(null)
      setFilled([])
      return up({ order_id: '' })
    }
    if (
      (f!.customer_name || f!.invoice_total) &&
      !(await confirmAction(tr("Fill the details from this order? The customer, quote #, invoice #, invoice total, currency, freight type, ship date, hours and plywood sheets are replaced."), {
        get confirmLabel() {
    return tr("Fill From Order")
  },
      }))
    ) {
      setOrderCode(orders.find((o) => o.id === v)?.order_code ?? null)
      return up({ order_id: v })
    }
    setF(await fillFromOrder(v, f!, settings))
  }

  async function save() {
    if (!supabase) return
    if (invoice === null) return toast.error(tr("The invoice total is not a valid amount or sum. Use numbers with + − × ÷ only, for example 12000+850."))
    if (f!.currency === 'USD' && fx <= 0) return toast.error(tr("Enter the exchange rate (USD to CAD)."))
    setBusy(true)
    const { data, error } = await supabase.rpc('save_freight_breakdown', {
      p: {
        ...f, id: id ?? null, order_id: f!.order_id || null, agent_id: f!.agent_id || null, agent_name: agent?.name ?? saved?.agent_name ?? null,
        ...numbers, sub_contractor: agent?.sub_contractor ? f!.sub_contractor : '', exchange_rate: fx,
      },
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(id ? tr("Cost breakdown saved.") : tr("Cost breakdown created."))
    if (!id) return navigate(`/freight/breakdowns/${data as string}`, { replace: true })
    const { data: b } = await supabase.from('freight_breakdowns').select('*').eq('id', id).maybeSingle()
    setSaved(b as Breakdown)
  }

  async function archive() {
    if (!supabase || !saved) return
    const to = !saved.archived
    if (to && !(await confirmAction(tr("Archive this cost breakdown? It leaves the list and the insurance summary. It can be restored from “Show archived”."), { get confirmLabel() {
    return tr("Archive")
  }, danger: true }))) return
    const { error } = await supabase.rpc('archive_freight_breakdown', { p_id: saved.id, p_archived: to })
    if (error) return toast.error(friendlyError(error))
    toast.success(to ? tr("Cost breakdown archived.") : tr("Cost breakdown restored."))
    setSaved({ ...saved, archived: to })
  }

  const copy = async (key: string, value: number) => {
    if (await copyText(value.toFixed(2))) {
      setCopied(key)
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
    } else toast.error(tr("The amount could not be copied. Select it and copy it by hand."))
  }
  const Row = ({ label, value, k, strong }: { label: string; value: number; k?: string; strong?: boolean }) => (
    <div className={`flex items-center justify-between gap-2 py-1.5 ${strong ? 'font-semibold' : ''}`}>
      <span className="min-w-0">{label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="tabular-nums" data-result={k}>
          {money(value)}
        </span>
        {k && (
          <Can permission="freight.breakdowns.copy">
            <button type="button" className="rounded border border-slate-300 px-1.5 py-0.5 text-xs font-normal print:hidden" onClick={() => copy(k, value)} aria-label={tr("Copy {{label}}", { label: label })}>
              {copied === k ? tr("Copied") : tr("Copy")}
            </button>
          </Can>
        )}
      </span>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link to="/freight?tab=breakdowns" className="text-sm text-slate-600 underline">
            {tr("← Freight")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{id ? tr("Shipment Cost Breakdown") : tr("New Shipment Cost Breakdown")}</h1>
          {saved && (
            <p className="text-sm text-slate-600">
              {saved.source === 'import' ? tr("Imported from the Freight Multitool. ") : ''}
              {saved.created_by_name ? tr("Created by {{created_by_name}}. ", { created_by_name: saved.created_by_name }) : ''}
              {saved.archived ? tr("Archived.") : ''}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {f.order_id && (
            <>
              <Can permission="order.page">
                <Link to={`/orders/${f.order_id}`} className={secondaryButtonClass}>
                  {tr("Open Order")} {orderCode ?? ''}
                </Link>
              </Can>
              <Can permission="freight.quote">
                <Link to={`/freight/quote?order=${f.order_id}`} className={secondaryButtonClass}>
                  {tr("Freight Quote Request")}
                </Link>
              </Can>
            </>
          )}
          {saved && (
            <>
              <Can permission="freight.breakdowns.print">
                <PrintButton title={tr("Shipment Cost Breakdown")} to={`/freight/breakdowns/${saved.id}/print`} className="py-2" />
              </Can>
              <Can permission="freight.breakdowns.archive" level="edit">
                <button type="button" className={secondaryButtonClass} onClick={archive}>
                  {saved.archived ? ACTION.restore : ACTION.archive}
                </button>
              </Can>
            </>
          )}
        </div>
      </div>

      {filled.length > 0 && !id && (
        <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900" role="status">
          {tr("Filled in from order")} {orderCode}: {filled.join(', ')}{tr(". Check the numbers and change anything that is different for this shipment.")}
        </p>
      )}

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-4">
          <Section title={tr("Order and Invoice")}>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label={tr("Order")} htmlFor="fb-order" hint={tr("Choosing an order fills in its details.")}>
                <select id="fb-order" className={inputClass} value={f.order_id} disabled={ro} onChange={(e) => changeOrder(e.target.value)}>
                  <option value="">{tr("Not linked to an order")}</option>
                  {f.order_id && !orders.some((o) => o.id === f.order_id) && <option value={f.order_id}>{tr("Order")} {orderCode ?? ''}</option>}
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.order_code} · {o.customer_name ?? ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={tr("Customer")} htmlFor="fb-customer">
                <input id="fb-customer" className={inputClass} value={f.customer_name} disabled={ro} onChange={(e) => up({ customer_name: e.target.value })} />
              </Field>
              <Field label={tr("Quote #")} htmlFor="fb-quote">
                <input id="fb-quote" className={inputClass} value={f.quote_number} disabled={ro} onChange={(e) => up({ quote_number: e.target.value })} />
              </Field>
              <Field label={tr("Invoice #")} htmlFor="fb-invoice">
                <input id="fb-invoice" className={inputClass} value={f.invoice_number} disabled={ro} onChange={(e) => up({ invoice_number: e.target.value })} />
              </Field>
              <Field label={tr("Invoice currency")} htmlFor="fb-currency">
                <select id="fb-currency" className={inputClass} value={f.currency} disabled={ro} onChange={(e) => changeCurrency(e.target.value as FreightCurrency)}>
                  <option value="CAD">CAD</option>
                  <option value="USD">USD</option>
                </select>
              </Field>
              {f.currency === 'USD' && (
                <Field label={tr("Exchange rate (USD to CAD)")} htmlFor="fb-fx" hint={tr("Used to store every amount in CAD as well.")}>
                  <input id="fb-fx" inputMode="decimal" className={inputClass} value={f.exchange_rate} disabled={ro} onChange={(e) => up({ exchange_rate: e.target.value })} />
                </Field>
              )}
              <Field
                label={tr("Total amount on invoice")}
                htmlFor="fb-total"
                hint={invoice === null ? undefined : isSum ? `= ${money(invoice)}` : tr("A sum also works, for example 12000+850.")}
                error={invoice === null ? 'This is not a valid amount or sum.' : undefined}
              >
                <input id="fb-total" inputMode="decimal" className={inputClass} value={f.invoice_total} disabled={ro} onChange={(e) => up({ invoice_total: e.target.value })} />
              </Field>
              <Field label={tr("Ship date (picked up)")} htmlFor="fb-ship">
                <input id="fb-ship" type="date" className={inputClass} value={f.ship_date} disabled={ro} onChange={(e) => up({ ship_date: e.target.value })} />
              </Field>
            </div>
          </Section>

          <Section title={tr("Shipment Details")}>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label={tr("Shipping agent")} htmlFor="fb-agent">
                <select id="fb-agent" className={inputClass} value={f.agent_id} disabled={ro} onChange={(e) => changeAgent(e.target.value)}>
                  <option value="">{saved?.agent_name && !f.agent_id ? saved.agent_name : tr("Choose…")}</option>
                  {agents
                    .filter((a) => !a.archived || a.id === f.agent_id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  {can('freight.agents.add', 'edit') && <option value="new">{tr("Add new…")}</option>}
                </select>
              </Field>
              <Field label={tr("Agent ref #")} htmlFor="fb-ref">
                <input id="fb-ref" className={inputClass} value={f.agent_ref} disabled={ro} onChange={(e) => up({ agent_ref: e.target.value })} />
              </Field>
              {agent?.sub_contractor && (
                <Field label={tr("Sub-contractor carrier")} htmlFor="fb-sub" hint={tr("The carrier {{name}} booked.", { name: agent.name })}>
                  <input id="fb-sub" className={inputClass} value={f.sub_contractor} disabled={ro} onChange={(e) => up({ sub_contractor: e.target.value })} />
                </Field>
              )}
              <Field label={tr("Carrier")} htmlFor="fb-carrier">
                <input id="fb-carrier" className={inputClass} value={f.carrier} disabled={ro} onChange={(e) => up({ carrier: e.target.value })} />
              </Field>
              <Field label={tr("Carrier tracking number")} htmlFor="fb-tracking">
                <input id="fb-tracking" className={inputClass} value={f.tracking_number} disabled={ro} onChange={(e) => up({ tracking_number: e.target.value })} />
              </Field>
              <Field label={tr("Freight type")} htmlFor="fb-type">
                <select id="fb-type" className={inputClass} value={f.freight_type} disabled={ro} onChange={(e) => up({ freight_type: e.target.value as FreightType })}>
                  {FREIGHT_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Section>

          <Section title={tr("Costs")}>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
              <Field label={tr("Total cargo value")} htmlFor="fb-cargo">
                <input id="fb-cargo" inputMode="decimal" className={inputClass} value={f.cargo_value} disabled={ro} onChange={(e) => up({ cargo_value: e.target.value })} />
              </Field>
              <Field label={tr("Freight (per carrier’s quote)")} htmlFor="fb-freight">
                <input id="fb-freight" inputMode="decimal" className={inputClass} value={f.freight} disabled={ro} onChange={(e) => up({ freight: e.target.value })} />
              </Field>
              <Field
                label={tr("Insurance")}
                htmlFor="fb-insurance"
                hint={
                  f.insurance_auto
                    ? tr("Calculated: the larger of (cargo value + freight) × {{uplift}} × {{rate_pct}}% and ${{minimum}}.", { uplift: settings.insurance.uplift, rate_pct: settings.insurance.rate_pct, minimum: settings.insurance.minimum })
                    : undefined
                }
              >
                <input
                  id="fb-insurance"
                  inputMode="decimal"
                  className={inputClass}
                  value={f.insurance_auto ? insurance.toFixed(2) : f.insurance}
                  disabled={ro || f.insurance_auto}
                  onChange={(e) => up({ insurance: e.target.value })}
                />
                <label className="mt-1 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={f.insurance_auto}
                    disabled={ro}
                    onChange={(e) => up({ insurance_auto: e.target.checked, insurance: e.target.checked ? f.insurance : insurance.toFixed(2) })}
                  />
                  {tr("Calculate automatically")}
                </label>
              </Field>
              <Field label={tr("Broker fees")} htmlFor="fb-broker">
                <input
                  id="fb-broker"
                  inputMode="decimal"
                  className={inputClass}
                  value={f.broker_fees}
                  disabled={ro}
                  onChange={(e) => up({ broker_fees: e.target.value, broker_standard: false })}
                />
                <label className="mt-1 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={f.broker_standard}
                    disabled={ro}
                    onChange={(e) => up({ broker_standard: e.target.checked, broker_fees: e.target.checked ? String(settings.broker_fee) : '' })}
                  />
                  {tr("Standard fee ($")}{settings.broker_fee})
                </label>
              </Field>
            </div>
            <h3 className="mt-4 mb-2 text-sm font-semibold">{tr("Handling")}</h3>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr))]">
              <Field label={tr("Hours")} htmlFor="fb-hours">
                <input id="fb-hours" inputMode="decimal" className={inputClass} value={f.hours} disabled={ro} onChange={(e) => up({ hours: e.target.value })} />
              </Field>
              <Field label={tr("Hourly rate")} htmlFor="fb-hourly">
                <input id="fb-hourly" inputMode="decimal" className={inputClass} value={f.hourly_rate} disabled={ro} onChange={(e) => up({ hourly_rate: e.target.value })} />
              </Field>
              <Field label={tr("Plywood sheets")} htmlFor="fb-sheets">
                <input id="fb-sheets" inputMode="decimal" className={inputClass} value={f.plywood_sheets} disabled={ro} onChange={(e) => up({ plywood_sheets: e.target.value })} />
              </Field>
              <Field label={tr("Plywood rate")} htmlFor="fb-plyrate">
                <input id="fb-plyrate" inputMode="decimal" className={inputClass} value={f.plywood_rate} disabled={ro} onChange={(e) => up({ plywood_rate: e.target.value })} />
              </Field>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {tr("Handling = hours × hourly rate + plywood sheets × plywood rate =")} {money(r.handling)}.
              {f.order_id ? tr(" Hours and sheets come from the crates entered on the order.") : ''}
            </p>
            <h3 className="mt-4 mb-2 text-sm font-semibold">{tr("Margin")}</h3>
            <div className="flex flex-wrap items-center gap-2">
              {settings.margin_presets.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={ro}
                  aria-pressed={num(f.margin_pct) === m && f.margin_pct !== ''}
                  className={`rounded-md border px-3 py-2 text-sm font-medium ${num(f.margin_pct) === m && f.margin_pct !== '' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
                  onClick={() => up({ margin_pct: String(m) })}
                >
                  {m}%
                </button>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <span className="text-slate-600">{tr("Custom %")}</span>
                <input aria-label={tr("Margin %")} inputMode="decimal" className={`${narrowInputClass} w-24`} value={f.margin_pct} disabled={ro} onChange={(e) => up({ margin_pct: e.target.value })} />
              </label>
            </div>
            <Field label={tr("Notes")} htmlFor="fb-notes" className="mt-4">
              <textarea id="fb-notes" rows={2} maxLength={2000} className={inputClass} value={f.notes} disabled={ro} onChange={(e) => up({ notes: e.target.value })} />
            </Field>
          </Section>
        </div>

        <aside className="w-full shrink-0 space-y-4 xl:sticky xl:top-4 xl:w-96">
          <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm md:p-6" aria-label={tr("Results")}>
            <h2 className="mb-2 text-base font-semibold">{tr("Results (")}{f.currency})</h2>
            <div className="divide-y divide-slate-100">
              <Row label={tr("Cargo value")} value={numbers.cargo_value} />
              <Row label={tr("Freight")} value={numbers.freight} />
              <Row label={tr("Insurance")} value={numbers.insurance} />
              <Row label={tr("Broker fees")} value={numbers.broker_fees} />
              <Row label={tr("Handling")} value={r.handling} />
              <Row label={tr("Subtotal")} value={r.subtotal} strong />
              <Row label={tr("Freight subtotal (without cargo value)")} value={r.freight_subtotal} k="freight_subtotal" />
              <Row label={tr("Total breakdown cost")} value={r.breakdown_total} k="breakdown_total" strong />
              <Row label={tr("Total with margin ({{margin_pct}}%)", { margin_pct: numbers.margin_pct })} value={r.total_with_margin} k="total_with_margin" strong />
              <Row label={tr("Freight subtotal with margin ({{margin_pct}}%)", { margin_pct: numbers.margin_pct })} value={r.freight_with_margin} k="freight_with_margin" />
              <Row label={tr("Total amount on invoice")} value={numbers.invoice_total} />
            </div>
            <div
              className={`mt-3 flex items-center justify-between gap-2 rounded-md px-3 py-2 font-semibold ${r.price_difference >= 0 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}
              data-result="price_difference"
            >
              <span>{tr("Price difference (invoice − breakdown cost)")}</span>
              <span className="tabular-nums">{money(r.price_difference)}</span>
            </div>
            {f.currency === 'USD' && fx > 0 && (
              <p className="mt-3 text-xs text-slate-600">
                {tr("In CAD at")} {fx}{tr(": breakdown cost")} {formatMoney(r.breakdown_total * fx, 'CAD')}{tr(", total with margin")} {formatMoney(r.total_with_margin * fx, 'CAD')}{tr(", invoice")}{' '}
                {formatMoney(numbers.invoice_total * fx, 'CAD')}{tr(". Every amount is also stored in CAD.")}
              </p>
            )}
          </section>
          <Can permission="freight.breakdowns" level="edit">
            <button type="button" className={`${buttonClass} w-full`} onClick={save} disabled={busy}>
              {busy ? tr("Saving…") : id ? ACTION.save : tr("Create Cost Breakdown")}
            </button>
          </Can>
        </aside>
      </div>
    </div>
  )
}
