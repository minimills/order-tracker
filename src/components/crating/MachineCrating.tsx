import { useState } from 'react'
import { toast } from 'sonner'
import { crateLine, type CrateMachine, type NumberedCrate } from '../../lib/crates'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { usePreferences } from '../../lib/preferences'
import { supabase } from '../../lib/supabase'
import CrateDialog from './CrateDialog'

type Props = {
  orderId: string
  orderCode: string
  machine: CrateMachine
  orderMachines: CrateMachine[]
  /** All crates of the order (numbered); this machine's are picked out here. */
  crates: NumberedCrate[]
  /** Reload after a change. */
  onChanged: () => void
  /** Bigger text for the shop board. */
  large?: boolean
}

/**
 * The "Crated?" tick box for one machine, its crates, and "Add another crate".
 * Ticking opens the crate form; unticking removes the machine's crating
 * (a shared crate stays for the other machines in it).
 */
export default function MachineCrating({ orderId, orderCode, machine, orderMachines, crates, onChanged, large = false }: Props) {
  const { units } = usePreferences()
  const [dialog, setDialog] = useState<{ crate: NumberedCrate | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const mine = crates.filter((c) => c.machine_ids.includes(machine.id))
  const crated = mine.length > 0
  const labelOf = (id: string) => orderMachines.find((m) => m.id === id)?.label ?? 'another machine'

  async function untick() {
    if (!supabase) return
    const ok = window.confirm(
      `Mark ${machine.label} as NOT crated? Its crating details (${mine.length} crate${mine.length === 1 ? '' : 's'}) are removed. A crate it shares with other machines stays for them.`,
    )
    if (!ok) return
    setBusy(true)
    const { error } = await supabase.rpc('uncrate_machine', { p_machine_id: machine.id })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${machine.label} marked not crated.`)
    onChanged()
  }

  return (
    <div className={large ? 'text-lg' : 'text-sm'}>
      <label className="inline-flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className={large ? 'h-6 w-6 accent-teal-700' : 'h-5 w-5 accent-teal-700'}
          checked={crated}
          disabled={busy}
          onChange={() => (crated ? untick() : setDialog({ crate: null }))}
        />
        <span className={crated ? 'font-medium text-teal-800' : 'text-slate-500'}>{crated ? 'Crated' : 'Crated?'}</span>
      </label>

      {crated && (
        <ul className={`mt-1 space-y-1 ${large ? 'pl-8' : 'pl-7'}`}>
          {mine.map((c) => {
            const shared = c.machine_ids.filter((id) => id !== machine.id)
            return (
              <li key={c.id} className="text-slate-700">
                <span className="font-medium">Crate {c.number}:</span> {crateLine(c, units)}
                <span className="text-slate-500">
                  {' '}
                  · {showDate(c.crated_on)}
                  {c.crated_by && <> by {c.crated_by}</>}
                </span>
                {shared.length > 0 && (
                  <span className="text-slate-500"> · also holds {shared.map(labelOf).join(', ')}</span>
                )}
                {c.notes && <span className="text-slate-500"> · {c.notes}</span>}{' '}
                <button type="button" className="text-blue-700 underline print:hidden" onClick={() => setDialog({ crate: c })}>
                  Edit
                </button>
              </li>
            )
          })}
          <li className="print:hidden">
            <button type="button" className="text-blue-700 underline" onClick={() => setDialog({ crate: null })}>
              + Add another crate
            </button>
          </li>
        </ul>
      )}

      {dialog && (
        <CrateDialog
          orderId={orderId}
          orderCode={orderCode}
          machine={machine}
          orderMachines={orderMachines}
          crate={dialog.crate}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            toast.success(message)
            setDialog(null)
            onChanged()
          }}
        />
      )}
    </div>
  )
}
