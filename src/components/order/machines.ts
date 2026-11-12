import { formatSerial } from '../../lib/format'
import type { MachineType } from '../../lib/types'

/** One line in the Machines section: a type and how many. */
export type MachineRow = {
  key: string
  machineTypeId: string
  quantity: string
  /** One entry per machine: null = automatic serial, text = typed by hand. */
  manual: (string | null)[]
  /** “Crate?”: only crated machines get a crating deadline. */
  needsCrate: boolean
}

let counter = 0
export function newMachineRow(needsCrate = false): MachineRow {
  counter += 1
  return { key: `row-${counter}-${Date.now()}`, machineTypeId: '', quantity: '1', manual: [null], needsCrate }
}

export const MAX_QUANTITY = 50

export function parseQuantity(text: string) {
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= MAX_QUANTITY ? n : null
}

/** Hand-typed serials are stored in capitals, as the database does. */
export function cleanSerial(text: string) {
  return text.trim().toUpperCase()
}

/**
 * Works out the serials each machine will probably get, the same way the
 * database does: hand-typed serials are kept, and automatic ones count up from
 * each type's next serial number, skipping numbers that are already taken.
 * Returns preview[rowIndex][unitIndex] = serial text, or null when the
 * machine gets no serial (Quote, or the type has no code yet).
 */
export function previewSerials(
  rows: MachineRow[],
  types: MachineType[],
  getsSerials: boolean,
  takenSerials: Set<string>,
) {
  const typeById = new Map(types.map((t) => [t.id, t]))
  const manualInForm = new Set(
    rows.flatMap((r) => r.manual.filter((m): m is string => m !== null && m.trim() !== '').map(cleanSerial)),
  )
  const nextByType = new Map<string, number>()

  return rows.map((row) => {
    const type = typeById.get(row.machineTypeId)
    return row.manual.map((manual) => {
      if (manual !== null) return manual.trim() ? cleanSerial(manual) : null
      if (!getsSerials || !type?.code) return null
      let n = nextByType.get(type.id) ?? type.next_serial_number
      while (manualInForm.has(formatSerial(type.code, n)) || takenSerials.has(formatSerial(type.code, n))) n += 1
      nextByType.set(type.id, n + 1)
      return formatSerial(type.code, n)
    })
  })
}
