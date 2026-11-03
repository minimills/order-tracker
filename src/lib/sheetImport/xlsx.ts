import { serialToDate } from './parse'
import type { Cell, Grid } from './types'

/* SheetJS is loaded only when it is needed (it is large). */
const loadXlsx = () => import('xlsx')

/** Reads every sheet of an .xlsx/.xls/.csv file into simple grids. */
export async function readWorkbook(file: File): Promise<Grid[]> {
  const XLSX = await loadXlsx()
  const data = await file.arrayBuffer()
  const wb = XLSX.read(data, { type: 'array', cellFormula: true, cellNF: true, cellDates: false })
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    const rows: Cell[][] = []
    if (!ws['!ref']) return { name, rows }
    const range = XLSX.utils.decode_range(ws['!ref'])
    for (let R = 0; R <= range.e.r; R++) {
      const row: Cell[] = []
      for (let C = 0; C <= Math.min(range.e.c, 25); C++) {
        const c = ws[XLSX.utils.encode_cell({ r: R, c: C })]
        row.push(toCell(XLSX, c))
      }
      rows.push(row)
    }
    return { name, rows }
  })
}

type XlsxModule = Awaited<ReturnType<typeof loadXlsx>>

function toCell(XLSX: XlsxModule, c: { t?: string; v?: unknown; f?: string; z?: string | number; w?: string } | undefined): Cell {
  if (!c || c.v === undefined || c.v === null) return { kind: 'empty' }
  switch (c.t) {
    case 'b':
      return { kind: 'bool', value: Boolean(c.v) }
    case 'n': {
      const v = Number(c.v)
      if (typeof c.z === 'string' && XLSX.SSF.is_date(c.z)) {
        const d = XLSX.SSF.parse_date_code(v)
        if (d) return { kind: 'date', iso: `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` }
        return { kind: 'date', iso: serialToDate(v) }
      }
      return { kind: 'number', value: v, formula: c.f }
    }
    case 'd':
      return { kind: 'date', iso: new Date(c.v as string).toISOString().slice(0, 10) }
    case 's':
    case 'str':
      return String(c.v).trim() === '' ? { kind: 'empty' } : { kind: 'text', text: String(c.v) }
    default:
      return { kind: 'empty' }
  }
}

/** A cell to write: text, number, date (YYYY-MM-DD), tick, or a number with a formula. */
export type OutCell = string | number | boolean | null | { date: string } | { formula: string; value: number }

export type OutSheet = { name: string; rows: OutCell[][]; widths?: number[] }

const dateSerial = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000
}

/** Builds an .xlsx file and makes the browser download it. */
export async function downloadWorkbook(filename: string, sheets: OutSheet[]) {
  const XLSX = await loadXlsx()
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws: Record<string, unknown> = {}
    let maxC = 0
    s.rows.forEach((row, R) => {
      row.forEach((v, C) => {
        if (v === null || v === undefined || v === '') return
        maxC = Math.max(maxC, C)
        const ref = XLSX.utils.encode_cell({ r: R, c: C })
        if (typeof v === 'string') ws[ref] = { t: 's', v }
        else if (typeof v === 'number') ws[ref] = { t: 'n', v }
        else if (typeof v === 'boolean') ws[ref] = { t: 'b', v }
        else if ('date' in v) ws[ref] = { t: 'n', v: dateSerial(v.date), z: 'yyyy-mm-dd' }
        else ws[ref] = { t: 'n', v: v.value, f: v.formula }
      })
    })
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, s.rows.length - 1), c: maxC } })
    if (s.widths) ws['!cols'] = s.widths.map((wch) => ({ wch }))
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }
  XLSX.writeFile(wb, filename, { compression: true })
}
