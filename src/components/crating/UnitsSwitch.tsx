import { usePreferences } from '../../lib/preferences'
import type { Units } from '../../lib/units'

const OPTIONS: { value: Units; label: string; hint: string }[] = [
  { value: 'imperial', label: 'Imperial', hint: 'inches, lb' },
  { value: 'metric', label: 'Metric', hint: 'cm, kg' },
]

/** Imperial / Metric switch. The choice is remembered for each person. */
export default function UnitsSwitch({ className = '' }: { className?: string }) {
  const { units, setUnits } = usePreferences()
  return (
    <div role="radiogroup" aria-label="Units" className={`inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-xs ${className}`}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={units === o.value}
          onClick={() => units !== o.value && setUnits(o.value)}
          className={`rounded px-2.5 py-1 font-medium ${units === o.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
        >
          {o.label} <span className={units === o.value ? 'text-slate-300' : 'text-slate-400'}>({o.hint})</span>
        </button>
      ))}
    </div>
  )
}
