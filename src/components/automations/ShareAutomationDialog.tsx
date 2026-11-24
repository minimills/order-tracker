// @permission-scope automations.share
import { useState } from 'react'
import { toast } from 'sonner'
import { Modal, buttonClass, narrowInputClass, secondaryButtonClass } from '../form'
import { shareAutomation, type AutomationRow, type Choices, type Share } from '../../lib/automations'
import { friendlyError } from '../../lib/format'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

/** Share with chosen people, groups or departments: they can see and use it, and edit it only if allowed. */
export default function ShareAutomationDialog({ automation, choices, onClose, onSaved }: { automation: AutomationRow; choices: Choices; onClose: () => void; onSaved: () => void }) {
  const [shares, setShares] = useState<Share[]>(automation.shares.map((s) => ({ type: s.type, target: s.target, can_edit: s.can_edit })))
  const [type, setType] = useState<Share['type']>('user')
  const [busy, setBusy] = useState(false)
  const options =
    type === 'user'
      ? choices.people.filter((p) => p.email !== automation.owner_email).map((p) => ({ id: p.email, name: p.name }))
      : type === 'group'
        ? choices.groups.filter((g) => g.can_message)
        : choices.departments.filter((d) => d.can_message)
  const nameOf = (s: Share) =>
    s.type === 'user'
      ? (choices.people.find((p) => p.email === s.target)?.name ?? s.target)
      : s.type === 'group'
        ? `Group: ${choices.groups.find((g) => g.id === s.target)?.name ?? 'removed group'}`
        : `Department: ${choices.departments.find((d) => d.id === s.target)?.name ?? 'removed department'}`

  async function save() {
    setBusy(true)
    try {
      await shareAutomation(automation.id, shares)
      toast.success(tr("Sharing saved."))
      onSaved()
      onClose()
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
    setBusy(false)
  }

  return (
    <Modal
      title={tr("Share: {{name}}", { name: automation.name })}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={save}>
            {busy ? ACTION.saving : ACTION.save}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        {tr("People you share with can see this automation, test it and copy it. Allow editing only for people you trust: it keeps running with your permissions. You can share with people, groups and departments you are allowed to message.")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <select aria-label={tr("Share with")} className={`${narrowInputClass} w-40`} value={type} onChange={(e) => setType(e.target.value as Share['type'])}>
          <option value="user">{tr("A person")}</option>
          <option value="group">{tr("A group")}</option>
          <option value="department">{tr("A department")}</option>
        </select>
        <select
          aria-label={tr("Which")}
          className={`${narrowInputClass} min-w-48 flex-1`}
          value=""
          onChange={(e) => {
            const v = e.target.value
            if (v && !shares.some((s) => s.type === type && s.target === v)) setShares([...shares, { type, target: v, can_edit: false }])
          }}
        >
          <option value="">{tr("Select…")}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
      <ul className="mt-3 space-y-2">
        {shares.map((s, i) => (
          <li key={`${s.type}:${s.target}`} className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-words">{nameOf(s)}</span>
            <label className="flex items-center gap-1.5 text-slate-600">
              <input type="checkbox" checked={s.can_edit} onChange={(e) => setShares(shares.map((x, j) => (j === i ? { ...x, can_edit: e.target.checked } : x)))} /> {tr("Allowed to edit")}
            </label>
            <button type="button" aria-label={tr("Remove {{nameOf}}", { nameOf: nameOf(s) })} className="text-slate-500 hover:text-red-700" onClick={() => setShares(shares.filter((_, j) => j !== i))}>
              ✕
            </button>
          </li>
        ))}
        {shares.length === 0 && <li className="text-sm text-slate-500">{tr("Not shared with anyone.")}</li>}
      </ul>
    </Modal>
  )
}
