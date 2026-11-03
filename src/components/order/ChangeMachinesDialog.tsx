import { useEffect, useState } from 'react'
import { useAlerts } from '../../lib/alerts'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { MachineType } from '../../lib/types'
import ChangeList, { type SerialChange } from '../admin/ChangeList'
import { buttonClass, inputClass, Modal, secondaryButtonClass } from '../form'

type Row = { key: number; typeId: string; quantity: string; serial: string }
type Preview = {
  added: { machine_type: string; serial: string | null }[]
  removed: { machine_type: string; serial: string | null; built: boolean }[]
  serials: SerialChange[]
}

type Props = {
  orderId: string
  orderCode: string
  stage: string
  /** Add machines, or remove the given machine. */
  mode: { kind: 'add' } | { kind: 'remove'; machineId: string; label: string; built: boolean }
  onClose: () => void
  onDone: (message: string) => void
}

let nextKey = 1
const newRow = (): Row => ({ key: nextKey++, typeId: '', quantity: '1', serial: '' })

/**
 * Add machines to an order, or take one off. Always shows what will change
 * (the new serials and any other order's serials that move) before saving.
 */
export default function ChangeMachinesDialog({ orderId, orderCode, stage, mode, onClose, onDone }: Props) {
  const { refresh: refreshAlerts } = useAlerts()
  const [types, setTypes] = useState<MachineType[]>([])
  const [rows, setRows] = useState<Row[]>(() => [newRow()])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (mode.kind !== 'add') return
    supabase
      ?.from('machine_types')
      .select('id, name, code, next_serial_number, archived')
      .eq('archived', false)
      .order('name')
      .then(({ data }) => setTypes((data as MachineType[]) ?? []))
  }, [mode.kind])

  const args = () => {
    if (mode.kind === 'remove') return { p_add: [], p_remove: [mode.machineId] }
    const add = rows.flatMap((r) => {
      const n = Number(r.quantity)
      return Array.from({ length: n }, (_, i) => ({
        machine_type_id: r.typeId,
        serial_number: n === 1 && i === 0 && r.serial.trim() ? r.serial.trim().toUpperCase() : null,
      }))
    })
    return { p_add: add, p_remove: [] }
  }

  async function run(apply: boolean) {
    if (!supabase) return
    if (mode.kind === 'add') {
      if (rows.some((r) => !r.typeId)) return setError('Choose a machine type on every line.')
      if (rows.some((r) => !/^\d+$/.test(r.quantity) || Number(r.quantity) < 1 || Number(r.quantity) > 50))
        return setError('Quantity must be 1 to 50.')
    }
    setBusy(true)
    setError(null)
    const { data, error: e } = await supabase.rpc('change_order_machines', { p_order_id: orderId, ...args(), p_apply: apply })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    if (!apply) return setPreview(data as Preview)
    refreshAlerts()
    const p = data as Preview
    onDone(
      mode.kind === 'add'
        ? `${p.added.length} machine${p.added.length === 1 ? '' : 's'} added to order ${orderCode}.`
        : `Machine removed from order ${orderCode}.`,
    )
  }

  // In remove mode, work out the preview straight away.
  useEffect(() => {
    // run() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    if (mode.kind === 'remove') run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const noSerials = stage === 'Quote' || stage === 'Cancelled'
  const title = mode.kind === 'add' ? `Add machines to order ${orderCode}` : `Remove ${mode.label} from order ${orderCode}?`

  const footer = (
    <>
      <button type="button" className={secondaryButtonClass} onClick={preview && mode.kind === 'add' ? () => setPreview(null) : onClose} disabled={busy}>
        {preview && mode.kind === 'add' ? 'Back' : 'Cancel'}
      </button>
      {preview ? (
        <button
          type="button"
          className={mode.kind === 'remove' ? 'rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60' : buttonClass}
          onClick={() => run(true)}
          disabled={busy}
        >
          {busy ? 'Saving…' : mode.kind === 'add' ? 'Add machines' : 'Remove machine'}
        </button>
      ) : (
        mode.kind === 'add' && (
          <button type="button" className={buttonClass} onClick={() => run(false)} disabled={busy}>
            {busy ? 'Working it out…' : 'Show what changes'}
          </button>
        )
      )}
    </>
  )

  return (
    <Modal title={title} onClose={onClose} busy={busy} footer={footer}>
      {mode.kind === 'add' && !preview && (
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={r.key} className="grid grid-cols-[1fr_5rem_auto] items-end gap-2">
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">Machine type</span>
                <select
                  className={inputClass}
                  value={r.typeId}
                  onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, typeId: e.target.value } : x)))}
                >
                  <option value="">Choose…</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.code ? ` (${t.code})` : ' (no code yet)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">How many</span>
                <input
                  inputMode="numeric"
                  className={inputClass}
                  value={r.quantity}
                  onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, quantity: e.target.value } : x)))}
                />
              </label>
              <button
                type="button"
                className="pb-2 text-sm text-red-700 underline disabled:text-slate-400 disabled:no-underline"
                disabled={rows.length === 1}
                onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                aria-label={`Remove line ${i + 1}`}
              >
                ✕
              </button>
              {r.quantity === '1' && (
                <label className="col-span-3 text-xs text-slate-600">
                  Serial typed by hand (optional, for odd cases; leave empty for the next automatic serial)
                  <input
                    className={`${inputClass} mt-1 max-w-48 font-mono uppercase`}
                    value={r.serial}
                    placeholder="automatic"
                    onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, serial: e.target.value } : x)))}
                  />
                </label>
              )}
            </div>
          ))}
          <button type="button" className={secondaryButtonClass} onClick={() => setRows([...rows, newRow()])}>
            + Another machine type
          </button>
        </div>
      )}

      {mode.kind === 'remove' && !preview && !error && <p className="text-sm text-slate-500">Working out what changes…</p>}

      {preview && (
        <div className="space-y-4 text-sm">
          {preview.added.length > 0 && (
            <div>
              <h3 className="font-medium">New machines</h3>
              <ul className="mt-1 space-y-0.5">
                {preview.added.map((a, i) => (
                  <li key={i}>
                    {a.machine_type}:{' '}
                    <strong className="font-mono">
                      {a.serial ?? (noSerials ? 'no serial yet (the order is not confirmed)' : 'no serial (this type has no code yet)')}
                    </strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.removed.length > 0 && (
            <div>
              <h3 className="font-medium">Taken off the order</h3>
              <ul className="mt-1 space-y-0.5">
                {preview.removed.map((r, i) => (
                  <li key={i}>
                    {r.machine_type} <span className="font-mono">{r.serial ?? ''}</span>
                    <span className="text-slate-500">
                      {r.built
                        ? ' — built, so it keeps its serial'
                        : r.serial
                          ? ' — its serial is given back for other machines'
                          : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">
                It is archived, not deleted: an admin can bring it back from Admin → Archive.
              </p>
            </div>
          )}
          <div>
            <h3 className="font-medium">Other machines</h3>
            {preview.serials.length === 0 ? (
              <p className="mt-1 text-slate-500">No other serial numbers change.</p>
            ) : (
              <>
                <p className="mt-1 text-slate-600">
                  These serials move so that orders earlier in the shop queue keep the lower serials. Built machines are
                  never changed.
                </p>
                <div className="mt-2">
                  <ChangeList serials={preview.serials} />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
    </Modal>
  )
}
