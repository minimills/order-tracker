/** One spreadsheet cell, already simplified (formula results, real dates, check marks…). */
export type Cell =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; formula?: string }
  | { kind: 'date'; iso: string }
  | { kind: 'bool'; value: boolean }

/** A whole sheet: rows[r][c]; sheet row number = r + 1, column A = c 0. */
export type Grid = { name: string; rows: Cell[][] }

export type Level = 'error' | 'warning' | 'info'
export type Msg = { row: number; level: Level; text: string }

/** A machine row as found in the file; the user can edit it in the preview. */
export type DraftMachine = {
  key: string
  row: number
  include: boolean
  name: string
  /** '' = match by name automatically, a machine type id, or NOT_A_MACHINE. */
  typeChoice: string
  serial: string
  built: boolean
  notes: string
}

export const NOT_A_MACHINE = '__note'

/** An order block as found in the file; the user can edit it in the preview. */
export type DraftOrder = {
  key: string
  row: number
  include: boolean
  code: string
  customer: string
  expected: string
  voltage: string
  notes: string
  actual: string
  dpAmount: string
  dpDue: string
  dpReceived: string
  dpReceivedAmount: string
  total: string
  balanceDue: string
  balanceReceived: string
  balanceReceivedAmount: string
  /** '' = worked out from the notes */
  delivery: string
  freight: string
  /** '' = CAD */
  currency: string
  /** '' = worked out (ship date / check marks); from the optional Stage column of a backup */
  stage: string
  /** Messages about how cells were read; they don't change when you edit. */
  readMessages: Msg[]
  machines: DraftMachine[]
}
