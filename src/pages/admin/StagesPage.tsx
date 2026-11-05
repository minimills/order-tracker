// @permission-scope admin.stages
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { saveStageLabels, STAGE_HINTS, useStageLabels, type StageLabels } from '../../lib/stages'
import { STAGES } from '../../lib/types'

/** Rename what people see for each stage, e.g. "Ready" → "Ready / testing". */
export default function StagesPage() {
  const label = useStageLabels()
  const [draft, setDraft] = useState<Partial<StageLabels> | null>(null)
  const [saving, setSaving] = useState(false)
  // Until someone types, the boxes show the current names.
  const value = (s: (typeof STAGES)[number]) => draft?.[s] ?? label(s)

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    const next = Object.fromEntries(STAGES.map((s) => [s, value(s)])) as StageLabels
    const error = await saveStageLabels(next)
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    setDraft(null)
    toast.success('Stage names saved. Everyone sees them the next time a page opens.')
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AdminPageHeader title="Stage names">
        Rename what people see for each stage. The order of the stages and what they do (shop queue, serial numbers,
        alerts) stay the same. Leave a box empty to use the standard name.
      </AdminPageHeader>
      <form onSubmit={save} className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
        {STAGES.map((s) => (
          <Field key={s} label={`Standard name: ${s}`} htmlFor={`stage-${s}`} hint={STAGE_HINTS[s]}>
            <input
              id={`stage-${s}`}
              className={inputClass}
              value={value(s)}
              placeholder={s}
              maxLength={40}
              onChange={(e) => setDraft({ ...(draft ?? {}), [s]: e.target.value })}
            />
          </Field>
        ))}
        <div className="flex justify-end gap-3">
          {draft && (
            <button type="button" className="text-sm underline" onClick={() => setDraft(null)}>
              Undo changes
            </button>
          )}
          <button type="submit" className={buttonClass} disabled={saving || !draft}>
            {saving ? 'Saving…' : 'Save names'}
          </button>
        </div>
      </form>
    </div>
  )
}
