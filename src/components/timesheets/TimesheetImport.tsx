// @permission-scope admin.timesheets
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { buttonClass, narrowInputClass, secondaryButtonClass } from '../form'
import { askText, confirmAction } from '../../lib/confirm'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import {
  buildDrafts,
  colLetter,
  defaultTabLayout,
  FIELDS,
  headingKey,
  readSheets,
  rowHours,
  toPayload,
  validate,
  type Action,
  type Draft,
  type FieldKey,
  type LayoutConfig,
  type RawSheet,
  type TabLayout,
} from '../../lib/timesheetImport'
import { showHours, usePayrollSettings, type Employee } from '../../lib/timesheets'
import { tr } from '../../i18n'

type SavedLayout = { id: string; name: string; config: LayoutConfig }
type ImportRun = { id: string; file_name: string | null; layout_name: string | null; rows_saved: number; rows_skipped: number; needs_review: number; imported_by_name: string | null; imported_at: string }
const cell = 'px-1 py-1'
const tiny = `${narrowInputClass} px-1.5 py-1 text-xs`
const PAGE = 150

/** Admin → Timesheets → Import: Excel or CSV, every tab, column matching (saved as named layouts), preview with problems, import. */
export default function TimesheetImport({ employees, reloadEmployees }: { employees: Employee[]; reloadEmployees: () => void }) {
  const settings = usePayrollSettings()
  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState<RawSheet[]>([])
  const [tabs, setTabs] = useState<Record<string, TabLayout>>({})
  const [layouts, setLayouts] = useState<SavedLayout[]>([])
  const [layoutName, setLayoutName] = useState('')
  const [step, setStep] = useState<'file' | 'match' | 'preview' | 'done'>('file')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const [days, setDays] = useState<Map<string, string[]>>(new Map())
  const [filter, setFilter] = useState<'all' | 'problems' | 'import' | 'keep' | 'skip'>('problems')
  const [shown, setShown] = useState(PAGE)
  const [approve, setApprove] = useState(true)
  const [busy, setBusy] = useState(false)
  const [runs, setRuns] = useState<ImportRun[]>([])
  const [result, setResult] = useState<{ saved: number; skipped: number; needs_review: number } | null>(null)

  const loadMeta = useCallback(async () => {
    if (!supabase) return
    const [l, r] = await Promise.all([
      supabase.from('timesheet_import_layouts').select('id, name, config').order('name'),
      supabase.from('timesheet_imports').select('*').order('imported_at', { ascending: false }).limit(30),
    ])
    setLayouts((l.data as SavedLayout[]) ?? [])
    setRuns((r.data as ImportRun[]) ?? [])
  }, [])
  useEffect(() => {
    // loadMeta() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    loadMeta()
  }, [loadMeta])

  const hpd = useCallback((id: string) => Number(employees.find((e) => e.id === id)?.hours_per_day) || settings.hours_per_day, [employees, settings.hours_per_day])

  async function chooseFile(f: File | undefined) {
    if (!f) return
    try {
      const s = await readSheets(f)
      setFileName(f.name)
      setSheets(s)
      const byHeading = layouts.find((l) => l.name === layoutName)?.config.byHeading ?? {}
      setTabs(Object.fromEntries(s.map((sh) => [sh.name, defaultTabLayout(sh, byHeading)])))
      setStep('match')
    } catch (e) {
      toast.error(tr("The file could not be read: {{message}}. Save it as .xlsx or .csv and try again.", { message: (e as Error).message }))
    }
  }

  function applyLayout(name: string) {
    setLayoutName(name)
    const l = layouts.find((x) => x.name === name)
    if (!l) return
    setTabs(
      Object.fromEntries(
        sheets.map((sh) => {
          const saved = l.config.tabs?.[sh.name]
          if (saved) return [sh.name, { ...saved, employee_id: saved.employee_id && employees.some((e) => e.id === saved.employee_id) ? saved.employee_id : null }]
          return [sh.name, defaultTabLayout(sh, l.config.byHeading ?? {})]
        }),
      ),
    )
    toast.success(tr("Matching “{{name}}” applied.", { name: name }))
  }

  async function saveLayout() {
    if (!supabase) return
    const name = await askText(tr("Name of this matching, for example “2025 sheet”"), { initial: layoutName, get label() {
    return tr("Layout name")
  }, get confirmLabel() {
    return tr("Save Layout")
  } })
    if (!name) return
    const byHeading: Record<string, FieldKey> = {}
    for (const t of Object.values(tabs)) for (const [k, f] of Object.entries(t.fields)) if (!k.startsWith('col:') && f !== 'ignore') byHeading[k] = f
    const { error } = await supabase.rpc('save_timesheet_layout', { p_name: name, p_config: { tabs, byHeading } })
    if (error) return toast.error(friendlyError(error))
    setLayoutName(name)
    toast.success(tr("Layout “{{name}}” saved.", { name: name }))
    loadMeta()
  }

  async function toPreview() {
    if (!supabase) return
    const built = buildDrafts(sheets, tabs, employees, fileName, hpd)
    if (built.length === 0) return toast.error(tr("No rows found. Check the heading row and that the Date and hours columns are matched."))
    const dates = built.map((d) => d.date).filter(Boolean).sort()
    const keysProbe = validate(built, new Set(), new Map()).map((d) => d.importKey)
    const [k, dw] = await Promise.all([
      supabase.rpc('timesheet_import_keys', { p_keys: keysProbe }),
      dates.length ? supabase.rpc('timesheet_days_with_hours', { p_from: dates[0], p_to: dates[dates.length - 1] }) : Promise.resolve({ data: [] }),
    ])
    const ex = new Set(((k.data as string[]) ?? []).map(String))
    const dm = new Map(((dw.data as { employee_id: string; work_date: string; sources: string[] }[]) ?? []).map((r) => [`${r.employee_id}|${r.work_date}`, r.sources]))
    setExisting(ex)
    setDays(dm)
    setDrafts(validate(built, ex, dm))
    setShown(PAGE)
    setStep('preview')
  }

  const edit = (key: string, patch: Partial<Draft>) => setDrafts((list) => validate(list.map((d) => (d.key === key ? { ...d, ...patch } : d)), existing, days))
  const unknownNames = useMemo(() => [...new Set(drafts.filter((d) => !d.employee_id && d.employeeText).map((d) => d.employeeText))], [drafts])

  async function mapName(name: string, employeeId: string, remember: boolean) {
    if (!supabase) return
    if (employeeId === '__new') {
      const { data, error } = await supabase.rpc('save_employee', { p: { name, pay_type: 'hourly', import_names: [] } })
      if (error) return toast.error(friendlyError(error))
      employeeId = data as string
      reloadEmployees()
      toast.success(tr("Employee “{{name}}” added (no login). Add their start date and pay rate in Employees.", { name: name }))
    } else if (remember) {
      await supabase.rpc('add_employee_alias', { p_employee: employeeId, p_name: name })
      reloadEmployees()
    }
    setDrafts((list) => validate(list.map((d) => (d.employeeText === name && !d.employee_id ? { ...d, employee_id: employeeId } : d)), existing, days))
  }

  const counts = { import: drafts.filter((d) => d.action === 'import').length, keep: drafts.filter((d) => d.action === 'keep').length, skip: drafts.filter((d) => d.action === 'skip').length }
  const blocked = drafts.filter((d) => d.action !== 'skip' && d.problems.some((p) => p.level === 'error'))
  const list = drafts.filter((d) => (filter === 'all' ? true : filter === 'problems' ? d.problems.some((p) => p.level !== 'info') : d.action === filter))

  async function runImport() {
    if (!supabase) return
    if (blocked.length) return toast.error(tr("{{length}} rows still have a problem that stops them being imported (employee or date). Fix them or skip them.", { length: blocked.length }))
    const rows = drafts.filter((d) => d.action !== 'skip').map(toPayload)
    if (!rows.length) return toast.error(tr("Nothing to import."))
    if (!(await confirmAction(tr("Import {{length}} rows ({{keep}} marked “imported – needs review”)?", { length: rows.length, keep: counts.keep }), { get confirmLabel() {
    return tr("Import")
  } }))) return
    setBusy(true)
    const total = { saved: 0, skipped: 0, needs_review: 0 }
    for (let i = 0; i < rows.length; i += 2000) {
      const { data, error } = await supabase.rpc('import_timesheet_rows', { p_file: fileName, p_layout: layoutName || null, p_rows: rows.slice(i, i + 2000), p_approve: approve })
      if (error) {
        setBusy(false)
        return toast.error(`${friendlyError(error)}${i ? tr(" (the first {{i}} rows were imported)", { i: i }) : ''}`, { duration: 12000 })
      }
      const r = data as typeof total
      total.saved += r.saved
      total.skipped += r.skipped
      total.needs_review += r.needs_review
    }
    setBusy(false)
    setResult(total)
    setStep('done')
    loadMeta()
  }

  async function removeRun(r: ImportRun) {
    if (!supabase) return
    const typed = await askText(tr("Permanently delete everything imported from “{{file_name}}” on {{showDate}}? Type DELETE to confirm.", { file_name: r.file_name, showDate: showDate(r.imported_at.slice(0, 10)) }), { get label() {
    return tr("Type DELETE")
  }, get confirmLabel() {
    return tr("Permanently Delete")
  } })
    if (typed !== 'DELETE') return
    const { data, error } = await supabase.rpc('delete_timesheet_import', { p_batch: r.id, p_confirm: 'DELETE' })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("{{data}} entries removed.", { data: data }))
    loadMeta()
  }

  const setTab = (name: string, patch: Partial<TabLayout>) => setTabs({ ...tabs, [name]: { ...tabs[name], ...patch } })

  return (
    <div className="space-y-4 text-sm" data-setting="ts-import">
      <p className="text-slate-600">
        {tr("Upload the whole timesheet file (.xlsx, .xls or .csv). It is read here in your browser and is not stored anywhere: only the cleaned rows are saved. Every tab is read; choose what each column means, check the preview, then import. Imported years show in every report.")}
      </p>

      {step === 'file' && (
        <div className="flex flex-wrap items-center gap-3">
          {layouts.length > 0 && (
            <select aria-label={tr("Saved layout")} className={narrowInputClass} value={layoutName} onChange={(e) => setLayoutName(e.target.value)}>
              <option value="">{tr("No saved layout")}</option>
              {layouts.map((l) => (
                <option key={l.id} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <label className={buttonClass}>
            {tr("Choose File")}
            <input type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={(e) => chooseFile(e.target.files?.[0])} />
          </label>
        </div>
      )}

      {step === 'match' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{fileName}</span>
            <select aria-label={tr("Apply a saved layout")} className={narrowInputClass} value={layoutName} onChange={(e) => applyLayout(e.target.value)}>
              <option value="">{tr("Apply a saved layout…")}</option>
              {layouts.map((l) => (
                <option key={l.id} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
            <button type="button" className={secondaryButtonClass} onClick={saveLayout}>
              {tr("Save Layout As…")}
            </button>
            {layouts.some((l) => l.name === layoutName) && (
              <button
                type="button"
                className="text-xs text-red-700 underline"
                onClick={async () => {
                  if (!supabase || !(await confirmAction(tr("Permanently delete the layout “{{layoutName}}”?", { layoutName: layoutName }), { danger: true, get confirmLabel() {
    return tr("Permanently Delete")
  } }))) return
                  await supabase.rpc('delete_timesheet_layout', { p_name: layoutName })
                  setLayoutName('')
                  loadMeta()
                }}
              >
                {tr("Permanently Delete Layout")}
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button type="button" className={secondaryButtonClass} onClick={() => setStep('file')}>
                {tr("Choose Another File")}
              </button>
              <button type="button" className={buttonClass} onClick={toPreview}>
                {tr("Preview →")}
              </button>
            </div>
          </div>
          {sheets.map((sh) => {
            const t = tabs[sh.name]
            if (!t) return null
            const head = sh.rows[t.header_row - 1] ?? []
            const width = Math.max(head.length, ...sh.rows.slice(t.header_row, t.header_row + 3).map((r) => r.length))
            return (
              <section key={sh.name} className={`rounded-lg border bg-white p-3 ${t.include ? 'border-slate-200' : 'border-dashed border-slate-300 opacity-70'}`}>
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={t.include} onChange={(e) => setTab(sh.name, { include: e.target.checked })} />
                    {tr("Tab “")}{sh.name}”
                  </label>
                  <span className="text-xs text-slate-500">{sh.rows.length} {tr("rows")}</span>
                  <label className="flex items-center gap-1 text-xs">
                    {tr("Headings on row")}
                    <input inputMode="numeric" className={`${tiny} w-14`} value={t.header_row} onChange={(e) => setTab(sh.name, { header_row: Math.max(1, Number(e.target.value) || 1) })} />
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    {tr("This whole tab is")}
                    <select className={tiny} value={t.employee_id ?? ''} onChange={(e) => setTab(sh.name, { employee_id: e.target.value || null })}>
                      <option value="">{tr("(read the employee from a column)")}</option>
                      {employees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {t.include && (
                  <div className="overflow-x-auto">
                    <table className="text-xs">
                      <tbody>
                        <tr>
                          {Array.from({ length: width }, (_, i) => {
                            const k = headingKey(head[i]?.w ?? '', i)
                            return (
                              <td key={i} className="min-w-28 p-1 align-top">
                                <div className="mb-1 truncate font-medium" title={head[i]?.w}>
                                  {colLetter(i)}: {head[i]?.w || tr("(no heading)")}
                                </div>
                                <select aria-label={tr("Column {{colLetter}} means", { colLetter: colLetter(i) })} className={`${tiny} w-full`} value={t.fields[k] ?? 'ignore'} onChange={(e) => setTab(sh.name, { fields: { ...t.fields, [k]: e.target.value as FieldKey } })}>
                                  {FIELDS.filter((f) => !(f.key === 'employee' && t.employee_id)).map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {f.label}
                                    </option>
                                  ))}
                                </select>
                                {sh.rows.slice(t.header_row, t.header_row + 3).map((r, j) => (
                                  <div key={j} className="mt-0.5 truncate text-slate-500">
                                    {r[i]?.w || '·'}
                                  </div>
                                ))}
                              </td>
                            )
                          })}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      {step === 'preview' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => setStep('match')}>
              {tr("← Back to Matching")}
            </button>
            <span>
              {drafts.length} rows: <strong>{counts.import}</strong> {tr("to import,")} <strong>{counts.keep}</strong> {tr("kept as-is (imported – needs review),")} <strong>{counts.skip}</strong> skipped.
            </span>
            <label className="ml-auto flex items-center gap-2">
              <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
              {tr("Mark imported weeks as approved (weeks with rows to review stay open)")}
            </label>
            <button type="button" className={buttonClass} disabled={busy} onClick={runImport}>
              {busy ? tr("Importing…") : tr("Import")}
            </button>
          </div>
          {blocked.length > 0 && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-red-900">{blocked.length} {tr("rows need an employee or a date before they can be imported (or skip them).")}</p>}

          {unknownNames.length > 0 && (
            <section className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <h3 className="mb-2 font-semibold text-amber-900">{tr("Unknown Names")}</h3>
              <ul className="space-y-1.5">
                {unknownNames.map((name) => (
                  <UnknownName key={name} name={name} employees={employees} onChoose={mapName} />
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-1" role="tablist" aria-label={tr("Rows")}>
            {(
              [
                ['problems', 'With problems'],
                ['all', 'All'],
                ['import', 'To import'],
                ['keep', 'Needs review'],
                ['skip', 'Skipped'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => (setFilter(k), setShown(PAGE))} className={`rounded-full border px-3 py-1 text-xs ${filter === k ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}>
                {l}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[78rem] text-xs">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className={cell}>{tr("Tab, row")}</th>
                  <th className={cell}>{tr("Employee")}</th>
                  <th className={cell}>{tr("Date")}</th>
                  <th className={cell}>{tr("Start")}</th>
                  <th className={cell}>{tr("End")}</th>
                  <th className={cell}>{tr("Break min")}</th>
                  <th className={cell}>{tr("Total")}</th>
                  <th className={cell}>{tr("Banked in")}</th>
                  <th className={cell}>{tr("Banked used")}</th>
                  <th className={cell}>{tr("Vacation h")}</th>
                  <th className={cell}>{tr("Sick h")}</th>
                  <th className={cell}>{tr("Notes")}</th>
                  <th className={cell}>{tr("Problems")}</th>
                  <th className={cell}>{tr("Action")}</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr>
                    <td className={`${cell} text-slate-500`} colSpan={14}>
                      {tr("No rows here.")}
                    </td>
                  </tr>
                )}
                {list.slice(0, shown).map((d) => {
                  const bad = d.problems.some((p) => p.level === 'error')
                  const warn = d.problems.some((p) => p.level === 'warning')
                  const tone = d.action === 'skip' ? 'opacity-60' : bad ? 'bg-red-50' : warn ? 'bg-amber-50' : ''
                  const inp = (k: keyof Draft, w = 'w-16', type = 'text') => (
                    <input type={type} aria-label={String(k)} className={`${tiny} ${w}`} value={String(d[k] ?? '')} onChange={(e) => edit(d.key, { [k]: e.target.value } as Partial<Draft>)} />
                  )
                  const computed = rowHours(d)
                  return (
                    <tr key={d.key} className={`border-t border-slate-100 ${tone}`}>
                      <td className={`${cell} whitespace-nowrap`}>
                        {d.tab}, {d.row}
                      </td>
                      <td className={cell}>
                        <select aria-label={tr("Employee")} className={`${tiny} w-36`} value={d.employee_id} onChange={(e) => edit(d.key, { employee_id: e.target.value })}>
                          <option value="">{d.employeeText ? tr("Unknown: {{employeeText}}", { employeeText: d.employeeText }) : tr("Choose")}</option>
                          {employees.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={cell}>{inp('date', 'w-32', 'date')}</td>
                      <td className={cell}>{inp('start', 'w-24', 'time')}</td>
                      <td className={cell}>{inp('end', 'w-24', 'time')}</td>
                      <td className={cell}>{inp('breakMin', 'w-14')}</td>
                      <td className={cell}>
                        {inp('total', 'w-14')}
                        {computed != null && <div className="text-slate-500">= {showHours(computed)}</div>}
                      </td>
                      <td className={cell}>{inp('bankedEarned', 'w-14')}</td>
                      <td className={cell}>{inp('bankedUsed', 'w-14')}</td>
                      <td className={cell}>{inp('vacation', 'w-14')}</td>
                      <td className={cell}>{inp('sick', 'w-14')}</td>
                      <td className={cell}>{inp('notes', 'w-32')}</td>
                      <td className={`${cell} max-w-56`}>
                        {d.problems.map((p, i) => (
                          <div key={i} className={p.level === 'error' ? 'text-red-800' : p.level === 'warning' ? 'text-amber-800' : 'text-slate-500'}>
                            {p.text}
                          </div>
                        ))}
                      </td>
                      <td className={cell}>
                        <select aria-label={tr("Action")} className={tiny} value={d.action} onChange={(e) => edit(d.key, { action: e.target.value as Action, actionChosen: true })}>
                          <option value="import">{tr("Import")}</option>
                          <option value="keep">{tr("Keep as-is (needs review)")}</option>
                          <option value="skip">{tr("Skip")}</option>
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {list.length > shown && (
            <button type="button" className={secondaryButtonClass} onClick={() => setShown(shown + PAGE)}>
              {tr("Show More (")}{list.length - shown} {tr("more)")}
            </button>
          )}
        </div>
      )}

      {step === 'done' && result && (
        <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 p-3 text-green-900">
          <p>
            {tr("Imported")} {result.saved} {tr("rows from")} {fileName}
            {result.needs_review ? tr("; {{needs_review}} marked “imported – needs review” (open their weeks in Timesheets to check them)", { needs_review: result.needs_review }) : ''}
            {result.skipped ? tr("; {{skipped}} were already imported and were skipped", { skipped: result.skipped }) : ''}.
          </p>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              setStep('file')
              setSheets([])
              setDrafts([])
              setResult(null)
            }}
          >
            {tr("Import Another File")}
          </button>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="font-semibold">{tr("Imports So Far")}</h3>
        {runs.length === 0 ? (
          <p className="text-slate-500">{tr("Nothing imported yet.")}</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-medium">{r.file_name}</span>
                <span className="text-slate-600">
                  {r.layout_name ? `“${r.layout_name}” · ` : ''}
                  {r.rows_saved} {tr("rows")}{r.needs_review ? tr(", {{needs_review}} to review", { needs_review: r.needs_review }) : ''} · {r.imported_by_name}, {showDate(r.imported_at.slice(0, 10))}
                </span>
                <button type="button" className="ml-auto text-xs text-red-700 underline" onClick={() => removeRun(r)}>
                  {tr("Permanently Delete This Import")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function UnknownName({ name, employees, onChoose }: { name: string; employees: Employee[]; onChoose: (name: string, id: string, remember: boolean) => void }) {
  const [id, setId] = useState('')
  const [remember, setRemember] = useState(true)
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="w-40 truncate font-medium">“{name}”</span>
      <span>{tr("is")}</span>
      <select aria-label={tr("Who is {{name}}", { name: name })} className={narrowInputClass} value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">{tr("Choose an employee")}</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
        <option value="__new">{tr("A new employee without a login")}</option>
      </select>
      {id && id !== '__new' && (
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {tr("Remember this spelling")}
        </label>
      )}
      <button type="button" className={secondaryButtonClass} disabled={!id} onClick={() => onChoose(name, id, remember)}>
        {tr("Use for Every Row")}
      </button>
    </li>
  )
}
