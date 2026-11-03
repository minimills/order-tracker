import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import OrderPreview from '../../components/admin/import/OrderPreview'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../../components/form'
import { useAlerts } from '../../lib/alerts'
import { todayISO } from '../../lib/dates'
import { fetchAll } from '../../lib/fetchAll'
import { friendlyError } from '../../lib/format'
import { backupSheets, templateSheets } from '../../lib/sheetImport/exportData'
import { parseGrid } from '../../lib/sheetImport/parse'
import { buildPayload } from '../../lib/sheetImport/payload'
import type { DraftMachine, DraftOrder, Grid } from '../../lib/sheetImport/types'
import { checkImport, type ExistingOrder, type ImportContext, type ImportType } from '../../lib/sheetImport/validate'
import { downloadWorkbook, readWorkbook } from '../../lib/sheetImport/xlsx'
import { supabase } from '../../lib/supabase'

type Filter = 'all' | 'attention' | 'errors'
type Summary = Record<string, number | Record<string, number>>

const DEFAULT_OPTIONS = {
  voltage: ['120V', '240V', 'Unknown'],
  delivery_equipment: ['Liftgate', 'No liftgate', 'Forklift', 'Tractor with forks', 'Unknown'],
  freight_type: ['LTL', 'FTL', 'LCL', "40' container", 'Other'],
}

/** Picks the sheet that holds the orders (not Instructions / Customers / Payments). */
function bestSheet(grids: Grid[]) {
  const ignore = /^(instructions|customers|payments)$/i
  return grids.find((g) => /^(orders|2026)$/i.test(g.name)) ?? grids.find((g) => !ignore.test(g.name)) ?? grids[0]
}

export default function ImportPage() {
  const { refresh: refreshAlerts } = useAlerts()
  const [busy, setBusy] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [grids, setGrids] = useState<Grid[]>([])
  const [sheet, setSheet] = useState('')
  const [drafts, setDrafts] = useState<DraftOrder[]>([])
  const [skippedTop, setSkippedTop] = useState(0)
  const [types, setTypes] = useState<ImportType[]>([])
  const [options, setOptions] = useState(DEFAULT_OPTIONS)
  const [existing, setExisting] = useState(new Map<string, ExistingOrder>())
  const [serialOwner, setSerialOwner] = useState(new Map<string, string>())
  const [keepSerials, setKeepSerials] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<Summary | null>(null)
  const [creating, setCreating] = useState<{ machine: DraftMachine; name: string; code: string } | null>(null)

  // ---------- Reference data from the app ----------
  const loadTypes = useCallback(async () => {
    if (!supabase) return
    const [t, o] = await Promise.all([
      supabase.from('machine_types').select('id, name, code, archived').order('name'),
      supabase.from('option_lists').select('list_name, value').eq('archived', false).order('sort_order'),
    ])
    setTypes((t.data as ImportType[]) ?? [])
    const lists = { ...DEFAULT_OPTIONS }
    for (const key of Object.keys(lists) as (keyof typeof lists)[]) {
      const values = ((o.data as { list_name: string; value: string }[]) ?? []).filter((x) => x.list_name === key).map((x) => x.value)
      if (values.length) lists[key] = values
    }
    setOptions(lists)
  }, [])
  useEffect(() => {
    // loadTypes() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    loadTypes()
  }, [loadTypes])

  /** Which orders and serials in the file already exist in the app. */
  const loadExisting = useCallback(async (list: DraftOrder[]) => {
    if (!supabase) return
    const numbers = [...new Set(list.map((d) => Number(d.code.match(/^\d+/)?.[0])).filter((n) => n > 0))]
    const ex = new Map<string, ExistingOrder>()
    for (let i = 0; i < numbers.length; i += 200) {
      const { data } = await supabase
        .from('orders')
        .select('id, order_code, stage, customers(name), order_machines(id, machine_type_id, serial_number, ready, archived)')
        .in('order_number', numbers.slice(i, i + 200))
      for (const o of (data ?? []) as unknown as {
        id: string
        order_code: string
        stage: string
        customers: { name: string } | null
        order_machines: (ExistingOrder['machines'][number] & { archived: boolean })[]
      }[]) {
        ex.set(o.order_code, {
          id: o.id,
          order_code: o.order_code,
          stage: o.stage,
          customer_name: o.customers?.name ?? '',
          machines: o.order_machines.filter((m) => !m.archived),
        })
      }
    }
    const owners = new Map<string, string>()
    // Every serial already in the app, to spot ones the file would use twice.
    const { data: all } = await fetchAll<{ serial_number: string; orders: { order_code: string } | null }>(() =>
      supabase!.from('order_machines').select('serial_number, orders(order_code)').not('serial_number', 'is', null).order('serial_number'),
    )
    for (const r of all) if (r.serial_number) owners.set(r.serial_number, r.orders?.order_code ?? '?')
    setExisting(ex)
    setSerialOwner(owners)
  }, [])

  // ---------- Reading a file ----------
  async function onFile(file: File | undefined) {
    if (!file) return
    setBusy('Reading the file…')
    setResult(null)
    try {
      const gs = await readWorkbook(file)
      const g = bestSheet(gs)
      setGrids(gs)
      setFileName(file.name)
      await openSheet(gs, g.name)
    } catch (e) {
      toast.error(`That file could not be read: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function openSheet(gs: Grid[], name: string) {
    const g = gs.find((x) => x.name === name) ?? gs[0]
    const parsed = parseGrid(g)
    setSheet(g.name)
    setSkippedTop(parsed.skippedTop)
    setDrafts(parsed.orders)
    await loadExisting(parsed.orders)
    if (parsed.orders.length === 0) toast.error(`No orders found on the "${g.name}" sheet. Order numbers must be in column A.`)
  }

  // ---------- Checking (runs after every edit) ----------
  const ctx: ImportContext = useMemo(() => ({ types, options, existing, serialOwner, keepSerials }), [types, options, existing, serialOwner, keepSerials])
  const check = useMemo(() => checkImport(drafts, ctx), [drafts, ctx])
  const boardPos = useMemo(() => new Map(check.boardOrder.map((o, i) => [o.draft.key, i + 1])), [check])
  const included = check.orders.filter((o) => o.draft.include)
  const errors = included.filter((o) => o.level === 'error').length
  const warnings = included.filter((o) => o.level === 'warning').length
  const shown = check.orders.filter((o) =>
    filter === 'all' ? true : filter === 'errors' ? o.draft.include && o.level === 'error' : o.draft.include && o.level !== 'ok',
  )

  // ---------- Edits from the preview ----------
  const patchOrder = (key: string, patch: Partial<DraftOrder>) => setDrafts((all) => all.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  const patchMachine = (orderKey: string, machineKey: string, patch: Partial<DraftMachine>) =>
    setDrafts((all) =>
      all.map((d) => (d.key === orderKey ? { ...d, machines: d.machines.map((m) => (m.key === machineKey ? { ...m, ...patch } : m)) } : d)),
    )
  const applyTypeToName = (name: string, typeId: string) =>
    setDrafts((all) =>
      all.map((d) => ({
        ...d,
        machines: d.machines.map((m) => (m.name.trim().toLowerCase() === name.trim().toLowerCase() && !m.typeChoice ? { ...m, typeChoice: typeId } : m)),
      })),
    )

  async function fillCodes() {
    if (!supabase) return
    setBusy('Saving codes…')
    for (const s of check.codeSuggestions) {
      const { error } = await supabase.from('machine_types').update({ code: s.code }).eq('id', s.type.id)
      if (error) toast.error(`${s.type.name}: ${friendlyError(error)}`)
    }
    await loadTypes()
    setBusy(null)
    toast.success('Codes saved in Machine types.')
  }

  async function createType() {
    if (!supabase || !creating) return
    const name = creating.name.trim()
    const code = creating.code.trim().toUpperCase()
    if (!name) return toast.error('Enter a name.')
    if (code && !/^[A-Z0-9]+$/.test(code)) return toast.error('The code can only have capital letters and numbers.')
    const { data, error } = await supabase.from('machine_types').insert({ name, code: code || null }).select('id').single()
    if (error) return toast.error(friendlyError(error))
    await loadTypes()
    applyTypeToName(creating.machine.name, (data as { id: string }).id)
    toast.success(`Machine type "${name}" created.`)
    setCreating(null)
  }

  // ---------- Import ----------
  const plan = useMemo(() => buildPayload(check), [check])

  async function runImport() {
    if (!supabase) return
    setBusy('Importing…')
    const { data, error } = await supabase.rpc('import_sheet', { p_orders: plan.payload, p_skipped: plan.skipped })
    setBusy(null)
    setConfirming(false)
    if (error) return toast.error(`Nothing was imported: ${friendlyError(error)}`)
    setResult(data as Summary)
    setDrafts([])
    setGrids([])
    refreshAlerts()
    toast.success('Import finished.')
  }

  async function download(kind: 'template' | 'backup') {
    setBusy(kind === 'template' ? 'Making the template…' : 'Collecting all data…')
    try {
      if (kind === 'template') await downloadWorkbook('order-import-template.xlsx', templateSheets())
      else await downloadWorkbook(`order-tracker-backup-${todayISO()}.xlsx`, await backupSheets())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const n = (key: string) => (typeof result?.[key] === 'number' ? (result[key] as number) : 0)

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <AdminPageHeader title="Import & backup">
        Bring orders in from a spreadsheet laid out like the old Google Sheet, or download everything as a backup in the
        same layout. Nothing is saved until you press Import and confirm.
      </AdminPageHeader>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="font-medium">1. Get the template</div>
          <p className="mt-1 text-sm text-slate-600">Columns A–N exactly like the old sheet, plus an Instructions sheet with an example.</p>
          <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={() => download('template')} disabled={!!busy}>
            ⬇ Download template
          </button>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="font-medium">2. Upload the filled file</div>
          <p className="mt-1 text-sm text-slate-600">.xlsx from Google Sheets (File → Download → Microsoft Excel) or Excel.</p>
          <label className={`${buttonClass} mt-3 inline-block cursor-pointer`}>
            ⬆ Upload filled file
            <input
              type="file"
              accept=".xlsx,.xls,.ods,.csv"
              className="sr-only"
              disabled={!!busy}
              onChange={(e) => {
                onFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="font-medium">Backup</div>
          <p className="mt-1 text-sm text-slate-600">Every order, machine and payment in the same layout (it can be imported again).</p>
          <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={() => download('backup')} disabled={!!busy}>
            ⬇ Download all data
          </button>
        </div>
      </div>

      {busy && <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">{busy}</p>}

      {result && (
        <section className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
          <h2 className="text-lg font-semibold text-green-900">Import finished</h2>
          <p className="mt-1">
            <strong>{n('orders_created') + n('orders_updated')}</strong> orders ({n('orders_created')} new, {n('orders_updated')} updated),{' '}
            <strong>{n('machines_created') + n('machines_updated')}</strong> machines, <strong>{n('payments_created') + n('payments_updated')}</strong>{' '}
            payments imported; <strong>{n('skipped')}</strong> skipped. {n('customers_created')} new customers.
          </p>
          {n('needs_serial') > 0 && (
            <p className="mt-1">
              {n('needs_serial')} machine{n('needs_serial') === 1 ? '' : 's'} need a serial:{' '}
              <Link to="/admin/serials" className="underline">
                Admin → Serial numbers
              </Link>
              .
            </p>
          )}
          {result.next_serial_numbers && Object.keys(result.next_serial_numbers).length > 0 && (
            <p className="mt-1">
              Next serial numbers set to:{' '}
              {Object.entries(result.next_serial_numbers as Record<string, number>)
                .map(([code, next]) => `${code}-${String(next).padStart(4, '0')}`)
                .join(', ')}
              .
            </p>
          )}
          <p className="mt-2">
            <Link to="/orders?stage=all" className="underline">
              See the orders
            </Link>{' '}
            · This import is recorded in{' '}
            <Link to="/admin/activity" className="underline">
              Activity
            </Link>
            .
          </p>
        </section>
      )}

      {drafts.length > 0 && (
        <>
          <section className="sticky top-0 z-10 space-y-3 rounded-lg border border-slate-300 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-semibold">{fileName}</span>
              {grids.length > 1 && (
                <select
                  aria-label="Sheet"
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                  value={sheet}
                  onChange={(e) => openSheet(grids, e.target.value)}
                >
                  {grids.map((g) => (
                    <option key={g.name}>{g.name}</option>
                  ))}
                </select>
              )}
              <span className="text-slate-600">
                {check.orders.length} orders found ({plan.counts.newOrders} new, {plan.counts.updatedOrders} update)
                {skippedTop > 0 && ` · ${skippedTop} heading row${skippedTop === 1 ? '' : 's'} skipped`}
              </span>
              <span className="text-red-700">{errors} with errors</span>
              <span className="text-amber-800">{warnings} with warnings</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <div className="flex gap-1 rounded-md bg-slate-100 p-1" role="tablist">
                {(
                  [
                    ['all', 'All'],
                    ['attention', 'Needs a look'],
                    ['errors', 'Errors only'],
                  ] as [Filter, string][]
                ).map(([f, label]) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={`rounded px-3 py-1 ${filter === f ? 'bg-white shadow-sm' : 'text-slate-600'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={keepSerials} onChange={(e) => setKeepSerials(e.target.checked)} />
                Keep serials exactly as in the file
              </label>
              <button
                type="button"
                className={`${buttonClass} ml-auto`}
                disabled={errors > 0 || included.length === 0 || !!busy}
                onClick={() => setConfirming(true)}
              >
                Import…
              </button>
            </div>
            {errors > 0 && <p className="text-sm text-red-700">Fix the red rows (or untick them) before importing.</p>}
            {check.codeSuggestions.length > 0 && (
              <div className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">
                These machine types have no code in the app yet, but your serials use one:{' '}
                {check.codeSuggestions.map((s) => `${s.type.name} → ${s.code}`).join(', ')}.{' '}
                <button type="button" className="font-medium underline" onClick={fillCodes} disabled={!!busy}>
                  Save these codes
                </button>{' '}
                (then those serials follow the normal numbering).
              </div>
            )}
          </section>

          <div className="space-y-3">
            {shown.map((c) => (
              <OrderPreview
                key={c.draft.key}
                checked={c}
                types={types}
                options={options}
                boardPosition={boardPos.get(c.draft.key) ?? null}
                onOrder={(patch) => patchOrder(c.draft.key, patch)}
                onMachine={(mk, patch) => patchMachine(c.draft.key, mk, patch)}
                onCreateType={(m) => {
                  const code = m.serial.trim().toUpperCase().match(/^([A-Z0-9]*[A-Z][A-Z0-9]*)/)?.[1] ?? ''
                  setCreating({ machine: m, name: m.name, code })
                }}
                onUseForAll={applyTypeToName}
              />
            ))}
            {shown.length === 0 && <p className="text-center text-sm text-slate-500">Nothing to show with this filter.</p>}
          </div>
        </>
      )}

      {confirming && (
        <Modal
          title="Import now?"
          onClose={() => setConfirming(false)}
          busy={!!busy}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setConfirming(false)} disabled={!!busy}>
                Cancel
              </button>
              <button type="button" className={buttonClass} onClick={runImport} disabled={!!busy}>
                {busy ? 'Importing…' : 'Yes, import'}
              </button>
            </>
          }
        >
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <strong>{plan.counts.newOrders}</strong> new orders and <strong>{plan.counts.updatedOrders}</strong> existing orders updated
            </li>
            <li>
              <strong>{plan.counts.machines}</strong> machines and <strong>{plan.counts.payments}</strong> payments
            </li>
            {plan.counts.notMachines > 0 && <li>{plan.counts.notMachines} non-machine rows added to order notes</li>}
            <li>{plan.skipped} unticked rows skipped</li>
          </ul>
          <p className="mt-3 text-sm text-slate-600">
            Everything is saved in one go: if anything goes wrong, nothing is saved. Afterwards each machine type’s next
            serial is set one above the highest imported number.
          </p>
        </Modal>
      )}

      {creating && (
        <Modal
          title="Create a machine type"
          onClose={() => setCreating(null)}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button type="button" className={buttonClass} onClick={createType}>
                Create
              </button>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="ct-name">
              <input id="ct-name" className={inputClass} value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
            </Field>
            <Field label="Code (optional)" htmlFor="ct-code" hint="Capital letters and numbers, e.g. SSD.">
              <input
                id="ct-code"
                className={`${inputClass} uppercase`}
                value={creating.code}
                onChange={(e) => setCreating({ ...creating, code: e.target.value })}
              />
            </Field>
          </div>
          <p className="mt-3 text-sm text-slate-600">Every row named “{creating.machine.name}” will use the new type.</p>
        </Modal>
      )}
    </div>
  )
}
