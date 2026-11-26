// @permission-scope machines.import
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, inputClass, Modal, secondaryButtonClass } from '../form'
import { friendlyError } from '../../lib/format'
import { readWorkbook } from '../../lib/sheetImport/xlsx'
import type { Cell, Grid } from '../../lib/sheetImport/types'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'

/** What a column can mean, and the headings that suggest it. */
const FIELDS = [
  { key: 'serial_number', label: 'Serial number', guess: /serial/i, required: true },
  { key: 'machine_type', label: 'Machine type / model', guess: /type|model|machine/i, required: true },
  { key: 'year_built', label: 'Year built', guess: /year/i },
  { key: 'voltage', label: 'Voltage', guess: /volt/i },
  { key: 'original_customer', label: 'Original customer', guess: /original|first|bought by|customer/i },
  { key: 'current_owner', label: 'Current owner ("Company" = in stock)', guess: /current|owner|now/i },
  { key: 'location', label: 'Where it is', guess: /location|where/i },
  { key: 'condition', label: 'Condition', guess: /condition/i },
  { key: 'notes', label: 'Notes', guess: /note|comment/i },
] as const
type FieldKey = (typeof FIELDS)[number]['key']
type Result = { row: number; serial: string | null; problems: string[] }

const text = (c: Cell | undefined): string =>
  !c || c.kind === 'empty' ? '' : c.kind === 'text' ? c.text.trim() : c.kind === 'number' ? String(c.value) : c.kind === 'date' ? c.iso.slice(0, 4) : c.value ? 'Yes' : ''

/** Import older machines from Excel or CSV: choose the sheet, match the columns, preview, import. */
export default function ImportMachinesDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [sheets, setSheets] = useState<Grid[]>([])
  const [sheet, setSheet] = useState(0)
  const [map, setMap] = useState<Record<FieldKey, number>>({} as Record<FieldKey, number>)
  const [approx, setApprox] = useState(false)
  const [preview, setPreview] = useState<Result[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grid = sheets[sheet]
  const headings = grid?.rows[0]?.map(text) ?? []
  const rows = useMemo(() => {
    if (!grid) return []
    return grid.rows
      .slice(1)
      .map((r) => Object.fromEntries(FIELDS.map((f) => [f.key, map[f.key] >= 0 ? text(r[map[f.key]]) : ''])) as Record<FieldKey, string>)
      .filter((r) => Object.values(r).some(Boolean))
      .map((r) => ({ ...r, year_approx: approx }))
  }, [grid, map, approx])

  function guess(g: Grid) {
    const hs = g.rows[0]?.map(text) ?? []
    const used = new Set<number>()
    const m = {} as Record<FieldKey, number>
    for (const f of FIELDS) {
      const i = hs.findIndex((h, idx) => !used.has(idx) && f.guess.test(h))
      m[f.key] = i
      if (i >= 0) used.add(i)
    }
    setMap(m)
  }

  async function open(file: File) {
    setError(null)
    setPreview(null)
    try {
      const gs = (await readWorkbook(file)).filter((g) => g.rows.length > 1)
      if (gs.length === 0) return setError('The file has no rows to import.')
      setSheets(gs)
      setSheet(0)
      guess(gs[0])
    } catch (e) {
      setError(`The file could not be read: ${friendlyError(e as Error)}`)
    }
  }

  async function run(apply: boolean) {
    if (!supabase) return
    if (FIELDS.some((f) => 'required' in f && f.required && !(map[f.key] >= 0))) return setError('Match the Serial number and Machine type columns first.')
    setBusy(true)
    setError(null)
    const { data, error: e } = await supabase.rpc('import_existing_machines', { p_rows: rows, p_apply: apply })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    const res = data as { rows: Result[]; imported: number }
    if (apply) {
      toast.success(`${res.imported} machine${res.imported === 1 ? '' : 's'} imported.`)
      onDone()
    } else setPreview(res.rows)
  }

  const ok = preview?.filter((r) => r.problems.length === 0).length ?? 0

  return (
    <Can permission="machines.import" level="edit">
      <Modal
        title="Import Machines"
        onClose={onClose}
        busy={busy}
        wide
        footer={
          <>
            <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
              {ACTION.cancel}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => run(false)} disabled={busy || !grid}>
              Preview
            </button>
            <button type="button" className={buttonClass} onClick={() => run(true)} disabled={busy || !preview || ok === 0}>
              {preview ? `Import ${ok} Machine${ok === 1 ? '' : 's'}` : 'Import'}
            </button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-slate-600">
            An Excel (.xlsx, .xls) or CSV file with one machine per row and headings in the first row. The file is read in this browser and not stored. Rows with a problem are skipped; fix them in the file and
            import again (serials already in the app are skipped).
          </p>
          <input type="file" accept=".xlsx,.xls,.csv" aria-label="Choose the file" onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
          {sheets.length > 1 && (
            <label className="flex items-center gap-2">
              Sheet
              <select
                className={`${inputClass} w-60`}
                value={sheet}
                onChange={(e) => {
                  setSheet(Number(e.target.value))
                  guess(sheets[Number(e.target.value)])
                  setPreview(null)
                }}
              >
                {sheets.map((g, i) => (
                  <option key={g.name} value={i}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {grid && (
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-1 font-medium text-slate-700">Which column holds…</legend>
              {FIELDS.map((f) => (
                <label key={f.key} className="flex items-center justify-between gap-2">
                  <span>{f.label}</span>
                  <select
                    className={`${inputClass} w-48`}
                    value={map[f.key] ?? -1}
                    onChange={(e) => {
                      setMap({ ...map, [f.key]: Number(e.target.value) })
                      setPreview(null)
                    }}
                  >
                    <option value={-1}>Not in the file</option>
                    {headings.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="flex items-center gap-2 sm:col-span-2">
                <input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} /> The years built are approximate
              </label>
            </fieldset>
          )}
          {preview && (
            <div className="max-h-80 overflow-auto rounded border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-2 py-1">Row</th>
                    <th className="px-2 py-1">Serial</th>
                    <th className="px-2 py-1">Type</th>
                    <th className="px-2 py-1">Owner</th>
                    <th className="px-2 py-1">Check</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={r.row} className={`border-t border-slate-100 ${r.problems.length ? 'bg-red-50' : 'bg-green-50'}`}>
                      <td className="px-2 py-1">{r.row + 1}</td>
                      <td className="px-2 py-1 font-mono">{r.serial ?? '—'}</td>
                      <td className="px-2 py-1">{rows[i]?.machine_type}</td>
                      <td className="px-2 py-1">{rows[i]?.current_owner || rows[i]?.original_customer || '—'}</td>
                      <td className="px-2 py-1">{r.problems.length ? r.problems.join(' ') : 'Ready to import'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview && (
            <p>
              {ok} of {preview.length} rows are ready to import.
            </p>
          )}
          {error && <p className="font-medium text-red-600">{error}</p>}
        </div>
      </Modal>
    </Can>
  )
}
