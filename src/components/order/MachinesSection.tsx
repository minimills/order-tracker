// @permission-scope orders.new
import type { MachineType } from '../../lib/types'
import Can from '../Can'
import { Field, inputClass } from '../form'
import MachineTypeSearch from './MachineTypeSearch'
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
  /** “Crate?” for newly added rows (Admin → Order defaults). */
  crateDefault?: boolean
}

export default function MachinesSection({ rows, onChange, machineTypes, preview, getsSerials, errors, crateDefault = true }: Props) {
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

  /** Adds machines from the search box; the same type again just adds to its quantity. */
  const addMachines = (type: MachineType, n: number) => {
    const i = rows.findIndex((r) => r.machineTypeId === type.id)
    if (i >= 0) {
      const total = Math.min(MAX_QUANTITY, (parseQuantity(rows[i].quantity) ?? 0) + n)
      setQuantity(i, String(total))
      return
    }
    onChange([...rows, { ...newMachineRow(crateDefault), machineTypeId: type.id, quantity: String(n), manual: Array.from({ length: n }, () => null) }])
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
              <Field label="Machine type" error={errors[`row-${i}-type`]}>
                <p className="py-2 text-sm font-medium">
                  {type?.name ?? '—'}
                  <span className="ml-2 font-mono text-xs font-normal text-slate-500">{type?.code ?? 'no code yet'}</span>
                </p>
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
              <div className="col-span-2 flex items-end gap-4 md:col-span-1">
                <Can permission="order.machines.crate_flag" level="edit">
                  <label className="flex items-center gap-2 pb-2 text-sm" title="Only crated machines get a crating deadline">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={row.needsCrate}
                      onChange={(e) => updateRow(i, { needsCrate: e.target.checked })}
                    />
                    Crate?
                  </label>
                </Can>
                <button
                  type="button"
                  className="text-sm text-red-700 underline disabled:text-slate-400 disabled:no-underline"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
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
                          <Can permission="orders.new.serial_by_hand" level="edit">
                            <button
                              type="button"
                              className="text-xs text-slate-600 underline"
                              onClick={() => setManual(i, j, '')}
                            >
                              Type serial by hand
                            </button>
                          </Can>
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

      <MachineTypeSearch types={activeTypes} onAdd={addMachines} />

      {errors.machines && <p className="text-sm font-medium text-red-600">{errors.machines}</p>}

      <div>
        <p className="text-xs text-slate-500">
          {getsSerials
            ? 'Serials shown are a preview. The final numbers are given when you save, so nobody can get the same number.'
            : 'Quotes do not get serial numbers. They are given when the order is confirmed.'}
        </p>
      </div>
    </div>
  )
}
