// @permission-scope timesheets.fill_all
/* Opened only from the button inside <Can permission="timesheets.fill_all" level="edit">; fill_week_for_everyone checks it again. */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { buttonClass, Modal, secondaryButtonClass } from '../form'
import { addDaysISO, showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { clockText, showHours } from '../../lib/timesheets'
import { ACTION } from '../../lib/wording'

type Result = {
  week_start: string
  start: string
  end: string
  break_minutes: number
  hours_per_day: number
  filled: { employee: string; employee_id: string; days: string[]; hours: number }[]
  skipped: { employee: string; employee_id: string; date: string | null; reason: string }[]
  applied: boolean
}

/**
 * "Fill Weekday Hours for Everyone": first shows what would be filled and what
 * is skipped (approved time off, company days off, approved weeks, days that
 * already have hours, days outside employment), then fills on Confirm.
 */
export default function FillEveryoneDialog({ weekStart, onClose, onDone }: { weekStart: string; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supabase) return
    supabase.rpc('fill_week_for_everyone', { p_week_start: weekStart, p_apply: false }).then(({ data, error }) => {
      if (error) {
        toast.error(friendlyError(error))
        return onClose()
      }
      setPreview(data as Result)
    })
  }, [weekStart, onClose])

  async function confirm() {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('fill_week_for_everyone', { p_week_start: weekStart, p_apply: true })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    const r = data as Result
    const days = r.filled.reduce((a, f) => a + f.days.length, 0)
    toast.success(`Filled ${days} day${days === 1 ? '' : 's'} for ${r.filled.length} employee${r.filled.length === 1 ? '' : 's'}.`)
    onDone()
  }

  const dayList = (d: string[]) => d.map((x) => showDate(x, 'EEE')).join(', ')
  // Skipped days grouped by person and reason: "Ben Off – approved time off: Wed, Thu, Fri".
  const skippedGroups = new Map<string, { employee: string; reason: string; days: string[] }>()
  for (const s of preview?.skipped ?? []) {
    const k = `${s.employee_id}|${s.reason}`
    const g = skippedGroups.get(k) ?? { employee: s.employee, reason: s.reason, days: [] }
    if (s.date) g.days.push(s.date)
    skippedGroups.set(k, g)
  }
  const totalDays = (preview?.filled ?? []).reduce((a, f) => a + f.days.length, 0)

  return (
    <Modal
      title="Fill Weekday Hours for Everyone"
      onClose={onClose}
      busy={busy}
      wide
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={confirm} disabled={busy || !preview || totalDays === 0}>
            {busy ? ACTION.saving : `Fill ${totalDays} Day${totalDays === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {!preview ? (
        <p className="text-sm text-slate-500">Working out what to fill…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <p>
            Week of {showDate(preview.week_start, 'EEE MMM d')} to {showDate(addDaysISO(preview.week_start, 6), 'EEE MMM d, yyyy')}: each weekday is filled{' '}
            {clockText(preview.start)} to {clockText(preview.end)} with a {preview.break_minutes}-minute unpaid break ({showHours(Number(preview.hours_per_day))} paid
            hours). Days that already have hours are never changed. Nothing is saved until you select Fill.
          </p>
          <section>
            <h3 className="mb-1 font-semibold">
              Will be filled ({preview.filled.length} employee{preview.filled.length === 1 ? '' : 's'}, {totalDays} day{totalDays === 1 ? '' : 's'})
            </h3>
            {preview.filled.length === 0 ? (
              <p className="text-slate-500">Nothing to fill: every weekday already has hours or is skipped.</p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {preview.filled.map((f) => (
                  <li key={f.employee_id} className="flex flex-wrap justify-between gap-2 px-3 py-1.5">
                    <span className="font-medium">{f.employee}</span>
                    <span className="text-slate-600">
                      {dayList(f.days)} · {showHours(Number(f.hours))} hours
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-semibold">Skipped ({skippedGroups.size})</h3>
            {skippedGroups.size === 0 ? (
              <p className="text-slate-500">Nothing is skipped.</p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {[...skippedGroups.values()].map((g) => (
                  <li key={`${g.employee}${g.reason}`} className="flex flex-wrap justify-between gap-2 px-3 py-1.5">
                    <span>{g.employee}</span>
                    <span className="text-slate-600">
                      {g.reason.charAt(0).toUpperCase() + g.reason.slice(1)}
                      {g.days.length ? `: ${dayList(g.days)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  )
}
