// @permission-scope admin.import
import { useState } from 'react'
import { formatMoney } from '../../../lib/format'
import { NOT_A_MACHINE, type DraftMachine, type DraftOrder, type Msg } from '../../../lib/sheetImport/types'
import type { CheckedOrder, ImportType } from '../../../lib/sheetImport/validate'

const CREATE = '__create'

const tone = {
  error: 'border-red-500 bg-red-50/40',
  warning: 'border-amber-400 bg-amber-50/30',
  ok: 'border-green-500 bg-white',
  info: 'border-green-500 bg-white',
  off: 'border-slate-300 bg-slate-50 opacity-70',
}
const msgTone = { error: 'text-red-700', warning: 'text-amber-800', info: 'text-slate-500' }
const icon = { error: '✖', warning: '⚠', info: 'ℹ' }

const small = 'rounded border border-slate-300 bg-white px-1.5 py-1 text-xs focus:border-slate-500 focus:outline-none'

function Messages({ msgs }: { msgs: Msg[] }) {
  if (!msgs.length) return null
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {msgs.map((m, i) => (
        <li key={i} className={msgTone[m.level]}>
          <span aria-hidden="true">{icon[m.level]} </span>
          Row {m.row}: {m.text}
        </li>
      ))}
    </ul>
  )
}

type Props = {
  checked: CheckedOrder
  types: ImportType[]
  options: { voltage: string[]; delivery_equipment: string[]; freight_type: string[] }
  onOrder: (patch: Partial<DraftOrder>) => void
  onMachine: (key: string, patch: Partial<DraftMachine>) => void
  onCreateType: (machine: DraftMachine) => void
  onUseForAll: (name: string, typeId: string) => void
}

/** One order in the import preview: what will be saved, problems, and quick fixes. */
export default function OrderPreview({ checked: c, types, options, onOrder, onMachine, onCreateType, onUseForAll }: Props) {
  const [editing, setEditing] = useState(false)
  const d = c.draft
  const level = d.include ? c.level : 'off'
  const activeTypes = types.filter((t) => !t.archived)
  const field = (key: keyof DraftOrder, label: string, type: 'text' | 'date' = 'text', width = 'w-32') => (
    <label className="flex flex-col text-xs text-slate-600">
      {label}
      <input
        type={type}
        className={`${small} ${width}`}
        value={d[key] as string}
        onChange={(e) => onOrder({ [key]: e.target.value } as Partial<DraftOrder>)}
      />
    </label>
  )
  const cur = c.currency
  const amount = (n: number | null) => (n === null ? '—' : formatMoney(n, cur))

  return (
    <article className={`rounded-lg border border-l-4 p-3 text-sm ${tone[level]}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={d.include}
          onChange={(e) => onOrder({ include: e.target.checked })}
          aria-label={`Import order ${d.code}`}
        />
        <span className="text-xs text-slate-500">Row {d.row}</span>
        <span className="font-semibold">Order {d.code}</span>
        <span>
          {c.customerName || <em className="text-slate-400">no customer</em>}
          {(c.state || c.country) && <span className="text-slate-500"> · {[c.state, c.country].filter(Boolean).join(', ')}</span>}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${c.existing ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'}`}>
          {c.existing ? 'Update' : 'New'}
        </span>
        <span className="text-xs text-slate-600">{c.stage}</span>
        <button type="button" className="ml-auto text-xs underline" onClick={() => setEditing((e) => !e)}>
          {editing ? 'Done editing' : 'Edit'}
        </button>
      </div>

      {editing ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {field('code', 'Order #', 'text', 'w-20')}
          {field('customer', 'Customer, Country', 'text', 'w-64')}
          {field('expected', 'Expected ship', 'date')}
          {field('actual', 'Actual ship', 'date')}
          <label className="flex flex-col text-xs text-slate-600">
            Voltage
            <select className={`${small} w-28`} value={c.voltage ?? ''} onChange={(e) => onOrder({ voltage: e.target.value })}>
              {!c.voltage && <option value="">(keep)</option>}
              {options.voltage.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-600">
            Delivery
            <select className={`${small} w-36`} value={d.delivery} onChange={(e) => onOrder({ delivery: e.target.value })}>
              <option value="">From notes ({c.delivery ?? '—'})</option>
              {options.delivery_equipment.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-600">
            Freight
            <select className={`${small} w-36`} value={d.freight} onChange={(e) => onOrder({ freight: e.target.value })}>
              <option value="">From notes ({c.freight ?? '—'})</option>
              {options.freight_type.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-600">
            Currency
            <select className={`${small} w-20`} value={d.currency || 'CAD'} onChange={(e) => onOrder({ currency: e.target.value })}>
              <option>CAD</option>
              <option>USD</option>
            </select>
          </label>
          {field('notes', 'Notes', 'text', 'w-72')}
          {field('total', 'Order total', 'text', 'w-28')}
          {field('dpAmount', 'Down payment', 'text', 'w-28')}
          {field('dpDue', 'DP due', 'date')}
          {field('dpReceived', 'DP received', 'date')}
          {field('balanceDue', 'Balance due', 'date')}
          {field('balanceReceived', 'Balance received', 'date')}
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-700">
          <span>Ship: {d.expected || '—'}{d.actual && ` → shipped ${d.actual}`}</span>
          <span>Voltage: {c.voltage ?? '(keep)'}</span>
          <span>Delivery: {c.delivery ?? '(keep)'}</span>
          <span>Freight: {c.freight ?? '—'}</span>
          <span>
            Total {amount(c.total)} · DP {amount(c.dpAmount)}
            {d.dpReceived && ` (received ${d.dpReceived})`} · Balance {amount(c.balance)}
            {d.balanceReceived && ` (received ${d.balanceReceived})`}
          </span>
          {d.notes && <span className="text-slate-500">Notes: {d.notes}</span>}
        </div>
      )}

      <Messages msgs={c.msgs} />

      {c.machines.length > 0 && (
        <table className="mt-2 w-full text-xs">
          <tbody>
            {c.machines.map((m) => {
              const dm = m.draft
              const selectValue = dm.typeChoice || m.type?.id || ''
              const mTone = !dm.include ? 'text-slate-400' : m.level === 'error' ? 'bg-red-50' : m.level === 'warning' ? 'bg-amber-50/60' : ''
              return (
                <tr key={dm.key} className={`border-t border-slate-100 align-top ${mTone}`}>
                  <td className="w-6 py-1">
                    <input
                      type="checkbox"
                      checked={dm.include}
                      onChange={(e) => onMachine(dm.key, { include: e.target.checked })}
                      aria-label={`Import ${dm.name}`}
                    />
                  </td>
                  <td className="w-12 py-1 text-slate-500">Row {dm.row}</td>
                  <td className="py-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-28">{dm.name}</span>
                      <select
                        aria-label={`Machine type for row ${dm.row}`}
                        className={`${small} max-w-52`}
                        value={selectValue}
                        onChange={(e) => {
                          if (e.target.value === CREATE) onCreateType(dm)
                          else onMachine(dm.key, { typeChoice: e.target.value })
                        }}
                      >
                        {!selectValue && <option value="">Choose a machine type…</option>}
                        {activeTypes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                            {t.code ? ` (${t.code})` : ''}
                          </option>
                        ))}
                        <option value={NOT_A_MACHINE}>Not a machine (add to order notes)</option>
                        <option value={CREATE}>+ Create a new machine type…</option>
                      </select>
                      {m.suggestion && (
                        <button type="button" className="text-xs text-blue-700 underline" onClick={() => onUseForAll(dm.name, m.suggestion!.id)}>
                          Use {m.suggestion.name} for every “{dm.name}”
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="w-32 py-1">
                    {dm.typeChoice !== NOT_A_MACHINE && (
                      <input
                        aria-label={`Serial for row ${dm.row}`}
                        className={`${small} w-28 font-mono uppercase`}
                        value={dm.serial}
                        placeholder="needs serial"
                        onChange={(e) => onMachine(dm.key, { serial: e.target.value })}
                      />
                    )}
                  </td>
                  <td className="w-16 py-1">
                    {dm.typeChoice !== NOT_A_MACHINE && (
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={dm.built} onChange={(e) => onMachine(dm.key, { built: e.target.checked })} />
                        Built
                      </label>
                    )}
                  </td>
                  <td className="py-1 text-slate-500">
                    {dm.notes}
                    <Messages msgs={m.msgs} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </article>
  )
}
