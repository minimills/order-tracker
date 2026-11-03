import type { MachineType } from '../../lib/types'
import { Field, inputClass, secondaryButtonClass } from '../form'
import { MAX_QUANTITY, newMachineRow, parseQuantity, type MachineRow } from './machines'

type Props = {
  rows: MachineRow[]
  onChange: (rows: MachineRow[]) => void
  machineTypes: MachineType[]
  /** preview[rowIndex][unitIndex] */
  preview: (string | null)[][]
  getsSerials: boolean
  /** Error messages keyed "row-<i>-type", "row-<i>-qty", "row-<i>-unit-<j>", or "machines". */
  errors: Record<string, string>
}

export default function MachinesSection({ rows, onChange, machineTypes, preview, getsSerials, errors }: Props) {
  const typeById = new Map(machineTypes.map((t) => [t.id, t]))
  const activeTypes = machineTypes.filter((t) => !t.archived)

  const updateRow = (index: number, change: Partial<MachineRow>) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...change } : r)))

  const setQuantity = (index: number, text: string) => {
    const row = rows[index]
    const n = parseQuantity(text)
    // Keep one entry per machine (hand-typed serials for extra machines are dropped).
    const manual = n === null ? row.manual : Array.from({ length: n }, (_, j) => row.manual[j] ?? null)
    updateRow(index, { quantity: text, manual })
  }

  const setManual = (rowIndex: number, unitIndex: number, value: string | null) => {
    const manual = [...rows[rowIndex].manual]
    manual[unitIndex] = value
    updateRow(rowIndex, { manual })
  }

  return (
    <div className="space-y-4">
      {rows.map((row, i) => {
        const type = typeById.get(row.machineTypeId)
        return (
          <div key={row.key} className="rounded-md border border-slate-200 p-3">
            <div className="grid grid-cols-[1fr_5.5rem] gap-3 md:grid-cols-[1fr_7rem_auto]">
              <Field label="Machine type" htmlFor={`${row.key}-type`} error={errors[`row-${i}-type`]}>
                <select
                  id={`${row.key}-type`}
                  className={inputClass}
                  value={row.machineTypeId}
                  onChange={(e) => updateRow(i, { machineTypeId: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {activeTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.code ? ` (${t.code})` : ' (no code yet)'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Quantity" htmlFor={`${row.key}-qty`} error={errors[`row-${i}-qty`]}>
                <input
                  id={`${row.key}-qty`}
                  type="number"
                  min={1}
                  max={MAX_QUANTITY}
                  inputMode="numeric"
                  className={inputClass}
                  value={row.quantity}
                  onChange={(e) => setQuantity(i, e.target.value)}
                />
              </Field>
              <div className="col-span-2 flex items-end md:col-span-1">
                <button
                  type="button"
                  className="text-sm text-red-700 underline disabled:text-slate-400 disabled:no-underline"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  disabled={rows.length === 1}
                >
                  Remove
                </button>
              </div>
            </div>

            {type && (
              <ul className="mt-3 space-y-2 text-sm">
                {row.manual.map((manual, j) => {
                  const unitError = errors[`row-${i}-unit-${j}`]
                  const serial = preview[i]?.[j]
                  return (
                    <li key={j} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="w-20 shrink-0 text-slate-500">Machine {j + 1}</span>
                      {manual === null ? (
                        <>
                          <span className="font-mono">
                            {serial ??
                              (!type.code
                                ? 'No serial (this type has no code yet)'
                                : getsSerials
                                  ? '—'
                                  : 'Serial given when confirmed')}
                          </span>
                          <button
                            type="button"
                            className="text-xs text-slate-600 underline"
                            onClick={() => setManual(i, j, '')}
                          >
                            Type serial by hand
                          </button>
                        </>
                      ) : (
                        <>
                          <input
                            aria-label={`Serial for machine ${j + 1}`}
                            className={`${inputClass} max-w-48 font-mono uppercase`}
                            value={manual}
                            placeholder={type.code ? `${type.code}-0000` : 'Serial'}
                            onChange={(e) => setManual(i, j, e.target.value)}
                          />
                          <button
                            type="button"
                            className="text-xs text-slate-600 underline"
                            onClick={() => setManual(i, j, null)}
                          >
                            Use automatic serial
                          </button>
                          {unitError && <span className="w-full text-xs font-medium text-red-600">{unitError}</span>}
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}

      {errors.machines && <p className="text-sm font-medium text-red-600">{errors.machines}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className={secondaryButtonClass} onClick={() => onChange([...rows, newMachineRow()])}>
          + Add another machine type
        </button>
        <p className="text-xs text-slate-500">
          {getsSerials
            ? 'Serials shown are a preview. The final numbers are given when you save, so nobody can get the same number.'
            : 'Quotes do not get serial numbers. They are given when the order is confirmed.'}
        </p>
      </div>
    </div>
  )
}
