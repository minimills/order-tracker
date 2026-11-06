// @permission-scope crating
import { useState } from 'react'
import type { CrateMachine, NumberedCrate } from '../../lib/crates'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePreferences } from '../../lib/preferences'
import { supabase } from '../../lib/supabase'
import {
  lengthInput,
  lengthToCm,
  lengthUnit,
  weightInput,
  weightToKg,
  weightUnit,
  type Units,
} from '../../lib/units'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'
import Can from '../Can'
import UnitsSwitch from './UnitsSwitch'
import { confirmAction } from '../../lib/confirm'

type Props = {
  orderId: string
  orderCode: string
  /** The machine the crate was opened from. */
  machine: CrateMachine
  /** Every machine on the order (for "This Crate Also Holds…"). */
  orderMachines: CrateMachine[]
  /** The crate being edited, or null for a new one. */
  crate: NumberedCrate | null
  onClose: () => void
  onDone: (message: string) => void
}

type MeasureKey = 'length' | 'width' | 'height' | 'weight'
const MEASURES: { key: MeasureKey; label: string; kind: 'length' | 'weight' }[] = [
  { key: 'length', label: 'Length', kind: 'length' },
  { key: 'width', label: 'Width', kind: 'length' },
  { key: 'height', label: 'Height', kind: 'length' },
  { key: 'weight', label: 'Weight', kind: 'weight' },
]

/** What was typed, and in which units (so switching units converts the boxes). */
type Draft = { text: string; units: Units }

function parse(text: string): number | null | 'bad' {
  const t = text.trim().replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : 'bad'
}

/** Add or edit one crate. Sizes and weight are typed in the person's units and saved in metric. */
export default function CrateDialog({ orderId, orderCode, machine, orderMachines, crate, onClose, onDone }: Props) {
  const { units, myName } = usePreferences()

  // Saved values in metric (null = empty); they only change when someone types.
  const [metric, setMetric] = useState<Record<MeasureKey, number | null>>({
    length: crate?.length_cm ?? null,
    width: crate?.width_cm ?? null,
    height: crate?.height_cm ?? null,
    weight: crate?.weight_kg ?? null,
  })
  const [drafts, setDrafts] = useState<Partial<Record<MeasureKey, Draft>>>({})
  const [sheets, setSheets] = useState(crate?.plywood_sheets == null ? '' : String(crate.plywood_sheets))
  const [hours, setHours] = useState(crate?.build_hours == null ? '' : String(crate.build_hours))
  const [cratedOn, setCratedOn] = useState(crate?.crated_on ?? todayISO())
  const [cratedBy, setCratedBy] = useState<string | null>(crate ? crate.crated_by ?? '' : null)
  const [notes, setNotes] = useState(crate?.notes ?? '')
  const [alsoHolds, setAlsoHolds] = useState<string[]>(crate ? crate.machine_ids.filter((id) => id !== machine.id) : [])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const others = orderMachines.filter((m) => m.id !== machine.id)
  // "Crated by" defaults to the signed-in person (their name once it has loaded).
  const cratedByValue = cratedBy ?? myName ?? ''

  function shown(key: MeasureKey, kind: 'length' | 'weight') {
    const d = drafts[key]
    if (d && d.units === units) return d.text
    return kind === 'length' ? lengthInput(metric[key], units) : weightInput(metric[key], units)
  }

  function type(key: MeasureKey, kind: 'length' | 'weight', text: string) {
    setDrafts((d) => ({ ...d, [key]: { text, units } }))
    const n = parse(text)
    if (n !== 'bad') {
      setMetric((m) => ({ ...m, [key]: n === null ? null : kind === 'length' ? lengthToCm(n, units) : weightToKg(n, units) }))
    }
  }

  async function save() {
    if (!supabase) return
    const e: Record<string, string> = {}
    for (const m of MEASURES) {
      const n = parse(shown(m.key, m.kind))
      if (n === 'bad') e[m.key] = 'Enter a number'
      else if (n !== null && n <= 0) e[m.key] = 'Enter a number greater than 0'
    }
    const sheetsN = parse(sheets)
    const hoursN = parse(hours)
    if (sheetsN === 'bad' || (sheetsN !== null && sheetsN < 0)) e.sheets = 'Enter a number (0 or more)'
    if (hoursN === 'bad' || (hoursN !== null && hoursN < 0)) e.hours = 'Enter a number (0 or more)'
    if (!cratedOn) e.cratedOn = 'Select the date'
    setErrors(e)
    if (Object.keys(e).length) return

    setSaving(true)
    setError(null)
    const { error: err } = await supabase.rpc('save_crate', {
      p_crate: {
        id: crate?.id ?? null,
        order_id: orderId,
        machine_ids: [machine.id, ...alsoHolds],
        length_cm: metric.length,
        width_cm: metric.width,
        height_cm: metric.height,
        weight_kg: metric.weight,
        plywood_sheets: sheetsN,
        build_hours: hoursN,
        crated_on: cratedOn,
        crated_by: cratedByValue,
        notes,
      },
    })
    setSaving(false)
    if (err) return setError(friendlyError(err))
    onDone(crate ? `Crate ${crate.number} saved.` : 'Crate saved.')
  }

  async function remove() {
    if (!supabase || !crate) return
    const shared = crate.machine_ids.length > 1
    const ok = await confirmAction(
      `Archive crate ${crate.number} on order ${orderCode}?${shared ? ' It holds more than one machine, so it is archived for all of them.' : ''}`,
      { confirmLabel: 'Archive' },
    )
    if (!ok) return
    setSaving(true)
    const { error: err } = await supabase.from('crates').update({ archived: true }).eq('id', crate.id)
    setSaving(false)
    if (err) return setError(friendlyError(err))
    onDone(`Crate ${crate.number} archived.`)
  }

  const title = crate ? `Crate ${crate.number} · Order ${orderCode}` : `New Crate · Order ${orderCode}`

  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          {crate && (
            <button type="button" className="mr-auto text-sm text-red-700 underline" onClick={remove} disabled={saving}>
              Archive This Crate
            </button>
          )}
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Crate'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">
          For <strong>{machine.label}</strong>
        </p>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-700">Size and Weight</span>
            <Can permission="crating.units">
              <UnitsSwitch />
            </Can>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {MEASURES.filter((m) => m.kind === 'length').map((m) => (
              <Field key={m.key} label={`${m.label} (${lengthUnit(units)})`} htmlFor={`crate-${m.key}`} error={errors[m.key]}>
                <input
                  id={`crate-${m.key}`}
                  inputMode="decimal"
                  className={inputClass}
                  value={shown(m.key, m.kind)}
                  onChange={(e) => type(m.key, m.kind, e.target.value)}
                />
              </Field>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label={`Weight (${weightUnit(units)})`} htmlFor="crate-weight" error={errors.weight}>
              <input
                id="crate-weight"
                inputMode="decimal"
                className={inputClass}
                value={shown('weight', 'weight')}
                onChange={(e) => type('weight', 'weight', e.target.value)}
              />
            </Field>
            <Field label="Plywood sheets" htmlFor="crate-sheets" error={errors.sheets}>
              <input id="crate-sheets" inputMode="decimal" className={inputClass} value={sheets} onChange={(e) => setSheets(e.target.value)} />
            </Field>
            <Field label="Hours to build" htmlFor="crate-hours" error={errors.hours}>
              <input id="crate-hours" inputMode="decimal" className={inputClass} value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
          </div>
          <p className="mt-1 text-xs text-slate-500">Leave a field empty if the value is not known yet; it can be filled in later.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date crated" htmlFor="crate-date" error={errors.cratedOn}>
            <input id="crate-date" type="date" className={inputClass} value={cratedOn} onChange={(e) => setCratedOn(e.target.value)} />
          </Field>
          <Field label="Crated by" htmlFor="crate-by">
            <input id="crate-by" className={inputClass} value={cratedByValue} onChange={(e) => setCratedBy(e.target.value)} />
          </Field>
        </div>

        {others.length > 0 && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">This Crate Also Holds…</legend>
            <p className="mb-2 text-xs text-slate-500">
              Select other machines from this order that share this crate, so its weight and plywood are counted once.
            </p>
            <div className="space-y-1">
              {others.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={alsoHolds.includes(m.id)}
                    onChange={(e) => setAlsoHolds((list) => (e.target.checked ? [...list, m.id] : list.filter((x) => x !== m.id)))}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <Field label="Notes" htmlFor="crate-notes">
          <textarea id="crate-notes" rows={2} className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
