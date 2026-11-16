// @permission-scope admin.freight
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { loadAgents, loadFreightSettings, type FreightAgent, type FreightSettings } from '../../lib/freight'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'

const card = 'space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm'
const n = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? 0 : Number(v))

/** Admin → Freight Settings: fees, rates, the insurance rule, margin buttons, pick-up locations and shipping agents. */
export default function FreightSettingsPage() {
  const [s, setS] = useState<FreightSettings | null>(null)
  const [savedJson, setSavedJson] = useState('')
  const [margins, setMargins] = useState('')
  const [agents, setAgents] = useState<FreightAgent[]>([])
  const [newAgent, setNewAgent] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadFreightSettings().then((v) => {
      setS(v)
      setSavedJson(JSON.stringify(v))
      setMargins(v.margin_presets.join(', '))
    })
    loadAgents().then(setAgents)
  }, [])

  if (!s) return <p className="text-sm text-slate-500">Loading…</p>
  const presets = margins.split(/[,;\s]+/).filter(Boolean).map(Number).filter((x) => Number.isFinite(x))
  const current: FreightSettings = { ...s, margin_presets: presets }
  const dirty = JSON.stringify(current) !== savedJson

  async function save() {
    if (!supabase) return
    setBusy(true)
    const { error } = await supabase.rpc('set_freight_settings', { p: current })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setSavedJson(JSON.stringify(current))
    toast.success('Freight settings saved.')
  }

  async function saveAgent(a: FreightAgent, patch: Partial<FreightAgent>) {
    if (!supabase) return
    const { error } = await supabase.from('freight_agents').update(patch).eq('id', a.id)
    if (error) return toast.error(friendlyError(error))
    setAgents(await loadAgents())
  }
  async function addAgent() {
    if (!supabase || !newAgent.trim()) return
    const { error } = await supabase.from('freight_agents').insert({ name: newAgent.trim(), sort_order: Math.max(0, ...agents.map((a) => a.sort_order)) + 1 })
    if (error) return toast.error(friendlyError(error))
    setNewAgent('')
    setAgents(await loadAgents())
  }
  const rate = (cur: 'CAD' | 'USD', k: 'hourly' | 'plywood', v: string) => setS({ ...s!, rates: { ...s!.rates, [cur]: { ...s!.rates[cur], [k]: n(v) } } })
  const loc = (i: number, patch: Partial<{ name: string; address: string }>) =>
    setS({ ...s!, pickup_locations: s!.pickup_locations.map((l, j) => (j === i ? { ...l, ...patch } : l)) })

  return (
    <div className="space-y-4">
      <AdminPageHeader title="Freight Settings">
        Used by shipment cost breakdowns, freight quote requests and the insurance summary. Changes apply to new breakdowns; saved ones keep their numbers.
      </AdminPageHeader>

      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,26rem),1fr))]">
        <section className={card} data-setting="fr-broker">
          <h2 className="text-base font-semibold">Fees and Rates</h2>
          <Field label="Standard broker fee ($)" htmlFor="fr-broker-fee" hint="Filled in by the “Standard fee” checkbox on a breakdown.">
            <input id="fr-broker-fee" inputMode="decimal" className={inputClass} value={s.broker_fee} onChange={(e) => setS({ ...s, broker_fee: n(e.target.value) })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            {(['CAD', 'USD'] as const).map((cur) => (
              <div key={cur} className="space-y-2">
                <Field label={`Hourly rate, ${cur} invoices`} htmlFor={`fr-hourly-${cur}`}>
                  <input id={`fr-hourly-${cur}`} inputMode="decimal" className={inputClass} value={s.rates[cur].hourly} onChange={(e) => rate(cur, 'hourly', e.target.value)} />
                </Field>
                <Field label={`Plywood rate per sheet, ${cur}`} htmlFor={`fr-ply-${cur}`}>
                  <input id={`fr-ply-${cur}`} inputMode="decimal" className={inputClass} value={s.rates[cur].plywood} onChange={(e) => rate(cur, 'plywood', e.target.value)} />
                </Field>
              </div>
            ))}
          </div>
          <Field label="Usual exchange rate (USD to CAD)" htmlFor="fr-fx" hint="The starting value on a USD breakdown; it is changed per shipment.">
            <input id="fr-fx" inputMode="decimal" className={inputClass} value={s.exchange_rate} onChange={(e) => setS({ ...s, exchange_rate: n(e.target.value) })} />
          </Field>
          <Field label="Margin buttons (%)" htmlFor="fr-margins" hint="Separate with commas, for example 10, 20, 30.">
            <input id="fr-margins" className={inputClass} value={margins} onChange={(e) => setMargins(e.target.value)} />
          </Field>
        </section>

        <section className={card} data-setting="fr-insurance">
          <h2 className="text-base font-semibold">Insurance Rule</h2>
          <p className="text-slate-600">
            For agents with “Insurance calculated”: the larger of (cargo value + freight) × uplift × rate, and the minimum. The uplift also gives the insured value in the
            insurance summary.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Uplift (×)" htmlFor="fr-uplift">
              <input id="fr-uplift" inputMode="decimal" className={inputClass} value={s.insurance.uplift} onChange={(e) => setS({ ...s, insurance: { ...s.insurance, uplift: n(e.target.value) } })} />
            </Field>
            <Field label="Rate (%)" htmlFor="fr-rate">
              <input id="fr-rate" inputMode="decimal" className={inputClass} value={s.insurance.rate_pct} onChange={(e) => setS({ ...s, insurance: { ...s.insurance, rate_pct: n(e.target.value) } })} />
            </Field>
            <Field label="Minimum ($)" htmlFor="fr-min">
              <input id="fr-min" inputMode="decimal" className={inputClass} value={s.insurance.minimum} onChange={(e) => setS({ ...s, insurance: { ...s.insurance, minimum: n(e.target.value) } })} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 font-medium">Freight types counted as ocean and air</legend>
            <div className="flex flex-wrap gap-3">
              {['LTL', 'FTL', 'LCL', 'FCL', 'Air'].map((t) => (
                <label key={t} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={s.ocean_air_types.includes(t)}
                    onChange={(e) => setS({ ...s, ocean_air_types: e.target.checked ? [...s.ocean_air_types, t] : s.ocean_air_types.filter((x) => x !== t) })}
                  />
                  {t}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">The others are inland in the insurance summary.</p>
          </fieldset>
        </section>

        <section className={card} data-setting="fr-locations">
          <h2 className="text-base font-semibold">Pick-up Locations</h2>
          <p className="text-slate-600">Our locations offered on a freight quote request.</p>
          {s.pickup_locations.map((l, i) => (
            <div key={i} className="space-y-2 rounded border border-slate-200 p-2">
              <input aria-label={`Location ${i + 1} name`} className={inputClass} value={l.name} placeholder="Name" onChange={(e) => loc(i, { name: e.target.value })} />
              <input aria-label={`Location ${i + 1} address`} className={inputClass} value={l.address} placeholder="Address" onChange={(e) => loc(i, { address: e.target.value })} />
              <button type="button" className="text-xs text-red-700 underline" onClick={() => setS({ ...s, pickup_locations: s.pickup_locations.filter((_, j) => j !== i) })}>
                Remove Location
              </button>
            </div>
          ))}
          <button type="button" className={secondaryButtonClass} onClick={() => setS({ ...s, pickup_locations: [...s.pickup_locations, { name: '', address: '' }] })}>
            Add Location
          </button>
        </section>
      </div>

      <button type="button" className={buttonClass} onClick={save} disabled={busy || !dirty}>
        {busy ? 'Saving…' : ACTION.save}
      </button>

      <section className="rounded-lg border border-slate-200 bg-white" data-setting="fr-agents">
        <div className="border-b border-slate-200 p-4">
          <h2 className="text-base font-semibold">Shipping Agents and Carriers</h2>
          <p className="text-sm text-slate-600">The list on breakdowns and quote requests. Each change here is saved at once. The contact receives quote requests.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-600">
              <tr>
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Contact name</th>
                <th className="px-3 py-2 font-semibold">Contact email</th>
                <th className="px-3 py-2 font-semibold">Insurance calculated</th>
                <th className="px-3 py-2 font-semibold">Uses sub-contractor carriers</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {agents.map((a) => (
                <tr key={a.id} className={a.archived ? 'text-slate-400' : ''}>
                  <td className="px-3 py-2">
                    <input aria-label="Name" className={`${inputClass} min-w-36`} defaultValue={a.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== a.name && saveAgent(a, { name: e.target.value.trim() })} />
                  </td>
                  <td className="px-3 py-2">
                    <input aria-label={`Contact name for ${a.name}`} className={`${inputClass} min-w-36`} defaultValue={a.contact_name ?? ''} onBlur={(e) => (e.target.value.trim() || null) !== a.contact_name && saveAgent(a, { contact_name: e.target.value.trim() || null })} />
                  </td>
                  <td className="px-3 py-2">
                    <input aria-label={`Contact email for ${a.name}`} type="email" className={`${inputClass} min-w-48`} defaultValue={a.contact_email ?? ''} onBlur={(e) => (e.target.value.trim() || null) !== a.contact_email && saveAgent(a, { contact_email: e.target.value.trim() || null })} />
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Insurance calculated for ${a.name}`} checked={a.auto_insurance} onChange={(e) => saveAgent(a, { auto_insurance: e.target.checked })} />
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`${a.name} uses sub-contractor carriers`} checked={a.sub_contractor} onChange={(e) => saveAgent(a, { sub_contractor: e.target.checked })} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" className="underline" onClick={() => saveAgent(a, { archived: !a.archived })}>
                      {a.archived ? ACTION.restore : ACTION.archive}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-slate-200 p-4">
          <input id="fr-new-agent" aria-label="New shipping agent" className={`${inputClass} max-w-xs`} value={newAgent} placeholder="Name of a new agent or carrier" onChange={(e) => setNewAgent(e.target.value)} />
          <button type="button" className={secondaryButtonClass} onClick={addAgent} disabled={!newAgent.trim()}>
            Add Shipping Agent
          </button>
        </div>
      </section>
    </div>
  )
}
