// @permission-scope admin.serials
import { stageLabel } from '../../lib/stages'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import ChangeList from '../../components/admin/ChangeList'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../../components/form'
import { fetchAll } from '../../lib/fetchAll'
import { formatSerial, friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { MachineType } from '../../lib/types'
import SerialNumber from '../../components/SerialNumber'

type Machine = {
  id: string
  order_id: string
  serial_number: string | null
  serial_manual: boolean
  needs_serial: boolean
  ready: boolean
  archived: boolean
  orders: { order_code: string; board_position: number | null; stage: string } | null
}
type ReseqRow = { machine_id: string; order_code: string; board_position: number; old_serial: string | null; new_serial: string }

const small = 'rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50'

function serialNumberPart(s: string | null) {
  const m = s?.match(/(\d+)$/)
  return m ? Number(m[1]) : null
}

export default function SerialsPage() {
  const [types, setTypes] = useState<MachineType[]>([])
  const [typeId, setTypeId] = useState('')
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(false)
  // Edit one serial
  const [editing, setEditing] = useState<Machine | null>(null)
  const [serial, setSerial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Machines imported without a serial, across all types
  const [needing, setNeeding] = useState<{ machine_type_id: string; machine_types: { name: string } | null }[]>([])
  // Re-sequence
  const [start, setStart] = useState('')
  const [preview, setPreview] = useState<ReseqRow[] | null>(null)

  useEffect(() => {
    supabase
      ?.from('machine_types')
      .select('id, name, code, next_serial_number, archived')
      .order('name')
      .then(({ data }) => {
        const list = (data as MachineType[]) ?? []
        setTypes(list)
        if (list.length) setTypeId((cur) => cur || list[0].id)
      })
  }, [])

  const type = types.find((t) => t.id === typeId)

  useEffect(() => {
    supabase
      ?.from('order_machines')
      .select('machine_type_id, machine_types(name)')
      .eq('needs_serial', true)
      .eq('archived', false)
      .limit(1000)
      .then(({ data }) => setNeeding((data as unknown as typeof needing) ?? []))
  }, [machines])
  const needingByType = new Map<string, { name: string; count: number }>()
  for (const n of needing) {
    const e = needingByType.get(n.machine_type_id) ?? { name: n.machine_types?.name ?? '?', count: 0 }
    e.count += 1
    needingByType.set(n.machine_type_id, e)
  }

  const load = useCallback(async () => {
    if (!supabase || !typeId) return
    setLoading(true)
    const { data, error: e } = await fetchAll<Machine>(() =>
      supabase!
        .from('order_machines')
        .select('id, order_id, serial_number, serial_manual, needs_serial, ready, archived, orders(order_code, board_position, stage)')
        .eq('machine_type_id', typeId)
        .eq('archived', false)
        .order('serial_number', { nullsFirst: false }),
    )
    if (e) toast.error(friendlyError(e))
    setMachines(data)
    setLoading(false)
  }, [typeId])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  // Suggested start for re-sequencing: the lowest serial among the machines it would renumber.
  const renumberable = machines.filter((m) => !m.ready && !m.serial_manual && m.orders?.board_position != null)
  const suggestedStart = Math.min(
    ...renumberable.map((m) => serialNumberPart(m.serial_number) ?? Infinity),
    type?.next_serial_number ?? Infinity,
  )

  async function saveSerial() {
    if (!supabase || !editing) return
    setBusy(true)
    const { error: e } = await supabase.rpc('admin_set_serial', { p_machine_id: editing.id, p_serial: serial })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success(serial.trim() ? `Serial set to ${serial.trim().toUpperCase()}.` : 'Serial will be given automatically again.')
    setEditing(null)
    load()
  }

  async function runResequence(apply: boolean) {
    if (!supabase || !type) return
    const n = Number(start || suggestedStart)
    if (!Number.isInteger(n) || n < 1) return toast.error('Enter a starting number of 1 or more.')
    setBusy(true)
    const { data, error: e } = await supabase.rpc('admin_resequence_serials', {
      p_machine_type_id: type.id,
      p_start: n,
      p_apply: apply,
    })
    setBusy(false)
    if (e) return toast.error(friendlyError(e))
    if (!apply) return setPreview((data as ReseqRow[]) ?? [])
    toast.success(`${type.code} serials re-sequenced.`)
    setPreview(null)
    load()
    // Refresh the next serial number shown.
    const { data: t } = await supabase.from('machine_types').select('id, name, code, next_serial_number, archived').eq('id', type.id).single()
    if (t) setTypes((all) => all.map((x) => (x.id === type.id ? (t as MachineType) : x)))
  }

  const changes = (preview ?? []).filter((r) => r.old_serial !== r.new_serial)

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <AdminPageHeader title="Serial Numbers">
        Fix a single serial by hand (it then stays fixed), or re-sequence a machine type so its unbuilt machines get
        consecutive serials in board order. Built machines and hand-typed serials are never changed by re-sequencing.
      </AdminPageHeader>

      {needing.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>{needing.length}</strong> machine{needing.length === 1 ? '' : 's'} imported without a serial need one:{' '}
          {[...needingByType].map(([id, t], i) => (
            <span key={id}>
              {i > 0 && ', '}
              <button type="button" className="underline" onClick={() => setTypeId(id)}>
                {t.name} ({t.count})
              </button>
            </span>
          ))}
          . Use <em>Edit serial</em> to type one, or save it empty to give it the next automatic serial.
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Machine type" htmlFor="st-type">
          <select id="st-type" className={inputClass} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.code ?? 'no code'})
              </option>
            ))}
          </select>
        </Field>
        {type?.code && (
          <p className="pb-2 text-sm text-slate-600">
            Next automatic serial: <strong className="font-mono">{formatSerial(type.code!, type.next_serial_number)}</strong>{' '}
            <Link to="/admin/machine-types" className="underline">
              change
            </Link>
          </p>
        )}
      </div>

      {type && !type.code && (
        <p className="text-sm text-slate-600">
          {type.name} has no code yet, so it gets no automatic serials. You can still type a serial by hand, or give it a
          code in{' '}
          <Link to="/admin/machine-types" className="underline">
            Machine Types
          </Link>
          .
        </p>
      )}

      {type?.code && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">Re-sequence {type.code} serials</h2>
          <p className="mt-1 text-sm text-slate-600">
            {renumberable.length} unbuilt machine{renumberable.length === 1 ? '' : 's'} on the board would be numbered
            from the starting number, in board order.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Start from number" htmlFor="st-start">
              <input
                id="st-start"
                inputMode="numeric"
                className={`${inputClass} w-32`}
                placeholder={Number.isFinite(suggestedStart) ? String(suggestedStart) : '1'}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <button type="button" className={buttonClass} disabled={busy || renumberable.length === 0} onClick={() => runResequence(false)}>
              Preview Changes
            </button>
          </div>
        </section>
      )}

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-normal">Serial</th>
              <th className="px-3 py-2 font-normal">Order</th>
              <th className="px-3 py-2 font-normal">Built</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && machines.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                  There are no machines of this type yet.
                </td>
              </tr>
            )}
            {machines.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2 font-mono">
                  {(m.serial_number && <SerialNumber serial={m.serial_number} />) ??
                    (m.needs_serial ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 font-sans text-xs font-medium text-amber-900">Needs serial</span>
                    ) : (
                      <span className="font-sans text-slate-400">none ({stageLabel(m.orders?.stage)})</span>
                    ))}
                  {m.serial_manual && m.serial_number && <span className="ml-1 font-sans text-xs text-slate-500">(by hand)</span>}
                </td>
                <td className="px-3 py-2">
                  <Link to={`/orders/${m.order_id}`} className="hover:underline">
                    {m.orders?.order_code}
                  </Link>
                </td>
                <td className="px-3 py-2">{m.ready ? 'Built' : ''}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className={small}
                    onClick={() => {
                      setEditing(m)
                      setSerial(m.serial_number ?? '')
                      setError(null)
                    }}
                  >
                    Edit serial
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editing && (
        <Modal
          title={`Edit serial (order ${editing.orders?.order_code})`}
          onClose={() => setEditing(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={buttonClass} onClick={saveSerial} disabled={busy}>
                {busy ? 'Saving…' : 'Save Serial Number'}
              </button>
            </>
          }
        >
          <Field
            label="Serial number"
            htmlFor="edit-serial"
            hint="It is checked for duplicates and then stays fixed. Leave empty to go back to an automatic serial."
          >
            <input
              id="edit-serial"
              className={`${inputClass} font-mono uppercase`}
              value={serial}
              placeholder={type?.code ? `${type.code}-0000` : ''}
              onChange={(e) => setSerial(e.target.value)}
            />
          </Field>
          {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
        </Modal>
      )}

      {preview && type?.code && (
        <Modal
          title={`Re-sequence ${type.code} serials?`}
          onClose={() => setPreview(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setPreview(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={buttonClass} onClick={() => runResequence(true)} disabled={busy || changes.length === 0}>
                {busy ? 'Saving…' : `Change ${changes.length} serial${changes.length === 1 ? '' : 's'}`}
              </button>
            </>
          }
        >
          <ChangeList serials={changes.map((r) => ({ order: r.order_code, old: r.old_serial, new: r.new_serial }))} />
          <p className="mt-3 text-xs text-slate-500">
            Afterwards the next automatic serial is set just after the highest {type.code} serial in use.
          </p>
        </Modal>
      )}
    </div>
  )
}
