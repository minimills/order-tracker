// @permission-scope crating.summary
import { toast } from 'sonner'
import { contentsLabel, freightSummary, type NumberedCrate } from '../../lib/crates'
import { usePreferences } from '../../lib/preferences'
import { showDims, showNumber, showWeight, weightFromKg, weightUnit } from '../../lib/units'
import { secondaryButtonClass, Section } from '../form'
import Can from '../Can'
import UnitsSwitch from './UnitsSwitch'

type Props = {
  order: { order_code: string; customer_name: string; customer_country: string | null }
  crates: NumberedCrate[]
  /** Labels of machines on the order that are not in any crate yet. */
  notCrated: string[]
}

/** Crating summary for freight quotes, with a Copy button. */
export default function CratingSummary({ order, crates, notCrated }: Props) {
  const { units } = usePreferences()
  const totalKg = crates.reduce((sum, c) => sum + (c.weight_kg ?? 0), 0)
  const missingWeight = crates.filter((c) => c.weight_kg == null).length

  async function copy() {
    const text = freightSummary(order, crates, units, notCrated)
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Crating summary copied. Paste it into your freight quote email.')
    } catch {
      toast.error('The summary could not be copied. Select the text and copy it manually.')
    }
  }

  return (
    <Section
      title="Crating Summary"
      aside={
        crates.length > 0 && (
          <Can permission="crating.summary.copy">
            <button type="button" className={secondaryButtonClass} onClick={copy}>
              Copy
            </button>
          </Can>
        )
      }
    >
      <Can permission="crating.units">
        <div className="mb-3">
          <UnitsSwitch />
        </div>
      </Can>
      {crates.length === 0 ? (
        <p className="text-sm text-slate-500">
          No crates have been entered yet. Mark a machine above as crated to enter its crate.
        </p>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            <strong>
              {crates.length} crate{crates.length === 1 ? '' : 's'}
            </strong>
            , total weight{' '}
            <strong>
              {showNumber(weightFromKg(totalKg, units), units === 'imperial' ? 0 : 1)} {weightUnit(units)}
            </strong>
            {missingWeight > 0 && (
              <span className="text-amber-700">
                {' '}
                ({missingWeight} crate{missingWeight === 1 ? ' has' : 's have'} no weight yet)
              </span>
            )}
          </p>
          <ul className="divide-y divide-slate-100">
            {crates.map((c) => (
              <li key={c.id} className="py-1.5">
                <div>
                  <span className="font-medium">Crate {c.number}:</span>{' '}
                  {showDims(c, units) ?? <span className="text-amber-700">size not entered</span>}
                  {' · '}
                  {c.weight_kg == null ? <span className="text-amber-700">weight not entered</span> : showWeight(c.weight_kg, units)}
                </div>
                <div className="text-xs text-slate-500">{contentsLabel(c.machine_types)}</div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">Sizes are length × width × height.</p>
        </div>
      )}
      {notCrated.length > 0 && crates.length > 0 && (
        <p className="mt-3 text-sm text-amber-700">Not crated yet: {notCrated.join(', ')}</p>
      )}
    </Section>
  )
}
