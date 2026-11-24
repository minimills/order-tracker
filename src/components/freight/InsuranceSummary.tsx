// @permission-scope freight.insurance
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { downloadCsv } from '../../lib/csv'
import { showDate, todayISO } from '../../lib/dates'
import { fetchAll } from '../../lib/fetchAll'
import { formatMoney, friendlyError } from '../../lib/format'
import { FREIGHT_DEFAULTS, loadFreightSettings, type Breakdown, type FreightSettings } from '../../lib/freight'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import { inputClass, secondaryButtonClass } from '../form'
import { tr } from '../../i18n'

type Line = { label: string; shipments: number; cargo: number; freight: number; insured: number; insurance: number }
const empty = (label: string): Line => ({ label, shipments: 0, cargo: 0, freight: 0, insured: 0, insurance: 0 })
const cad = (n: number) => formatMoney(n, 'CAD')

/**
 * Insurance summary for the yearly insurance broker review: shipments in a
 * date range, split into ocean / air and inland, with cargo values and the
 * insured values (cargo + freight, plus the uplift). Everything in CAD.
 */
export default function InsuranceSummary() {
  const [params, setParams] = useSearchParams()
  const today = todayISO()
  // The review is each June: default to the last 12 months.
  const from = params.get('ifrom') ?? `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`
  const to = params.get('ito') ?? today
  const [rows, setRows] = useState<Breakdown[]>([])
  const [settings, setSettings] = useState<FreightSettings>(FREIGHT_DEFAULTS)
  const [loading, setLoading] = useState(true)
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v) n.set(k, v)
        else n.delete(k)
        return n
      },
      { replace: true },
    )

  useEffect(() => {
    if (!supabase) return
    loadFreightSettings().then(setSettings)
    fetchAll<Breakdown>(() => supabase!.from('freight_breakdowns').select('*').eq('archived', false).order('id')).then((r) => {
      if (r.error) toast.error(friendlyError(r.error))
      setRows(r.data)
      setLoading(false)
    })
  }, [])

  const inRange = useMemo(() => rows.filter((r) => r.ship_date && r.ship_date >= from && r.ship_date <= to), [rows, from, to])
  const noDate = rows.filter((r) => !r.ship_date).length
  const { groups, byType, total } = useMemo(() => {
    const ocean = empty(tr("Ocean and air"))
    const inland = empty('Inland')
    const total = empty('Total')
    const types = new Map<string, Line>()
    for (const r of inRange) {
      const isOcean = settings.ocean_air_types.includes(r.freight_type)
      if (!types.has(r.freight_type)) types.set(r.freight_type, empty(r.freight_type))
      for (const l of [isOcean ? ocean : inland, total, types.get(r.freight_type)!]) {
        l.shipments++
        l.cargo += Number(r.cargo_value_cad)
        l.freight += Number(r.freight_cad)
        l.insured += Number(r.insured_value_cad)
        l.insurance += Number(r.insurance_cad)
      }
    }
    return { groups: [ocean, inland], byType: [...types.values()].sort((a, b) => a.label.localeCompare(b.label)), total }
  }, [inRange, settings])

  const oceanTypes = settings.ocean_air_types.join(', ')
  const uplift = Math.round((settings.insurance.uplift - 1) * 1000) / 10

  function exportCsv() {
    const line = (l: Line, kind: string) => [kind, l.label, l.shipments, l.cargo.toFixed(2), l.freight.toFixed(2), l.insured.toFixed(2), l.insurance.toFixed(2)]
    downloadCsv(
      `insurance-summary-${from}-to-${to}.csv`,
      ['Section', 'Group', 'Shipments', tr("Cargo value (CAD)"), 'Freight (CAD)', tr("Insured value (CAD, cargo + freight + {{uplift}}%)", { uplift: uplift }), tr("Insurance paid (CAD)")],
      [
        ...groups.map((g) => line(g, 'Summary')),
        line(total, 'Summary'),
        ...byType.map((t) => line(t, tr("By freight type"))),
        [],
        ['Shipments', tr("Ship date"), 'Customer', 'Invoice #', 'Agent', tr("Freight type"), tr("Ocean / air or inland"), tr("Entered currency"), tr("Exchange rate"), tr("Cargo value (CAD)"), 'Freight (CAD)', tr("Insured value (CAD)"), tr("Insurance paid (CAD)")],
        ...inRange
          .slice()
          .sort((a, b) => (a.ship_date ?? '').localeCompare(b.ship_date ?? ''))
          .map((r) => [
            '', r.ship_date, r.customer_name, r.invoice_number, r.agent_name, r.freight_type,
            settings.ocean_air_types.includes(r.freight_type) ? tr("Ocean / air") : 'Inland',
            r.currency, r.currency === 'USD' ? Number(r.exchange_rate) : '',
            Number(r.cargo_value_cad).toFixed(2), Number(r.freight_cad).toFixed(2), Number(r.insured_value_cad).toFixed(2), Number(r.insurance_cad).toFixed(2),
          ]),
      ],
    )
  }

  const table = (title: string, lines: Line[], withTotal: boolean) => (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 px-4 py-3 font-semibold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-600">
            <tr>
              <th className="px-3 py-2 font-semibold">{tr("Group")}</th>
              <th className="px-3 py-2 text-right font-semibold">{tr("Shipments")}</th>
              <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">{tr("Cargo value")}</th>
              <th className="px-3 py-2 text-right font-semibold">{tr("Freight")}</th>
              <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">{tr("Insured value")}</th>
              <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">{tr("Insurance paid")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  {tr("No shipments in these dates.")}
                </td>
              </tr>
            )}
            {[...lines, ...(withTotal ? [total] : [])].map((l) => (
              <tr key={l.label} className={l.label === 'Total' ? 'bg-slate-50 font-semibold' : ''}>
                <td className="px-3 py-2">{l.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.shipments}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{cad(l.cargo)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{cad(l.freight)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{cad(l.insured)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{cad(l.insurance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{tr("Shipped from")}</span>
          <input type="date" className={inputClass} value={from} max={to} onChange={(e) => set('ifrom', e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{tr("to")}</span>
          <input type="date" className={inputClass} value={to} min={from} onChange={(e) => set('ito', e.target.value)} />
        </label>
        <span className="flex-1" />
        <Can permission="freight.insurance.export">
          <button type="button" className={secondaryButtonClass} onClick={exportCsv} disabled={inRange.length === 0}>
            {tr("Export CSV")}
          </button>
        </Can>
      </div>
      <p className="text-sm text-slate-600">
        {tr("Saved cost breakdowns shipped")} {showDate(from)} {tr("to")} {showDate(to)}{tr(", in CAD. Ocean and air =")} {oceanTypes || tr("none")}{tr("; everything else is inland. Insured value = cargo value + freight, plus")} {uplift}%.
        {noDate > 0 && tr(" {{count}} breakdown has no ship date and is left out.", { count: noDate })}
      </p>
      {loading ? (
        <p className="py-8 text-center text-slate-500">{tr("Loading…")}</p>
      ) : (
        <>
          {table('Ocean and Air Compared With Inland', inRange.length ? groups : [], true)}
          {table('By Freight Type', byType, false)}
        </>
      )}
    </div>
  )
}
