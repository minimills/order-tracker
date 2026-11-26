type Cell = string | number | boolean | null | undefined

function escape(value: Cell) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Downloads rows as a CSV file that opens correctly in Excel and Google Sheets. */
export function downloadCsv(filename: string, header: string[], rows: Cell[][]) {
  const text = [header, ...rows].map((r) => r.map(escape).join(',')).join('\r\n')
  // The BOM at the start tells Excel the file is UTF-8 (so accents and × show correctly).
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Downloads rows as an Excel workbook (.xlsx, one sheet). SheetJS is loaded only when needed. */
export async function downloadXlsx(filename: string, sheetName: string, header: string[], rows: Cell[][]) {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows.map((r) => r.map((c) => (c === undefined ? null : c)))])
  ws['!cols'] = header.map((h, i) => ({ wch: Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)) + 2 }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  XLSX.writeFile(wb, filename)
}
