// @permission-scope admin.scheduling
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { showDate } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { DEFAULT_SCHEDULING, type SchedulingSettings } from '../../lib/schedule'
import { supabase } from '../../lib/supabase'
import { loadSetting } from '../../lib/useSchedule'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Working days, holidays, buffer and how machines in one order are built. */
export default function SchedulingPage() {
  const [f, setF] = useState<SchedulingSettings>(DEFAULT_SCHEDULING)
  const [holidayDate, setHolidayDate] = useState('')
  const [holidayName, setHolidayName] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    loadSetting('scheduling', DEFAULT_SCHEDULING).then(setF)
  }, [])

  async function save(e?: FormEvent, next = f) {
    e?.preventDefault()
    if (!supabase) return
    if (next.working_days.length === 0) return toast.error('Tick at least one working day.')
    if (!Number.isInteger(next.buffer_days) || next.buffer_days < 0 || next.buffer_days > 90) return toast.error('Buffer days: 0 to 90.')
    setSaving(true)
    const { error } = await supabase.from('app_settings').upsert({ key: 'scheduling', value: next })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Scheduling saved. Suggested dates on orders update straight away; promised dates only change when accepted.')
  }

  function addHoliday() {
    if (!holidayDate) return toast.error('Pick the date.')
    if (f.holidays.some((h) => h.date === holidayDate)) return toast.error('That date is already a holiday.')
    const next = { ...f, holidays: [...f.holidays, { date: holidayDate, name: holidayName.trim() || 'Holiday' }].sort((a, b) => a.date.localeCompare(b.date)) }
    setF(next)
    setHolidayDate('')
    setHolidayName('')
    save(undefined, next)
  }

  function removeHoliday(date: string) {
    const next = { ...f, holidays: f.holidays.filter((h) => h.date !== date) }
    setF(next)
    save(undefined, next)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AdminPageHeader title="Scheduling">
        How expected ship dates and department deadlines are worked out. Orders are built one after another in the order
        of the shop queue.
      </AdminPageHeader>

      <form onSubmit={save} className="space-y-5 rounded-lg border border-slate-200 bg-white p-5" noValidate>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">Working days</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {WEEKDAYS.map((name, i) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={f.working_days.includes(i + 1)}
                  onChange={(e) =>
                    setF({
                      ...f,
                      working_days: e.target.checked ? [...f.working_days, i + 1].sort() : f.working_days.filter((d) => d !== i + 1),
                    })
                  }
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Buffer days before shipping" htmlFor="sc-buffer" hint="Working days between the end of the build and the ship date.">
            <input
              id="sc-buffer"
              type="number"
              min={0}
              max={90}
              className={inputClass}
              value={f.buffer_days}
              onChange={(e) => setF({ ...f, buffer_days: Number(e.target.value) })}
            />
          </Field>
          <Field label="Machines within one order" htmlFor="sc-parallel">
            <select
              id="sc-parallel"
              className={inputClass}
              value={f.machines_in_parallel ? 'parallel' : 'sequence'}
              onChange={(e) => setF({ ...f, machines_in_parallel: e.target.value === 'parallel' })}
            >
              <option value="sequence">Built one after another</option>
              <option value="parallel">Built at the same time</option>
            </select>
          </Field>
        </div>
        <div className="flex justify-end">
          <button type="submit" className={buttonClass} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="mb-3 font-semibold">Company holidays</h2>
        <div className="grid gap-2 sm:grid-cols-[11rem_1fr_auto]">
          <input type="date" aria-label="Holiday date" className={inputClass} value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} />
          <input aria-label="Holiday name" className={inputClass} placeholder="e.g. Canada Day" value={holidayName} onChange={(e) => setHolidayName(e.target.value)} />
          <button type="button" className={secondaryButtonClass} onClick={addHoliday}>
            + Add holiday
          </button>
        </div>
        {f.holidays.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No holidays yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {f.holidays.map((h) => (
              <li key={h.date} className="flex items-center justify-between py-1.5">
                <span>
                  <span className="font-medium">{showDate(h.date, 'EEE, MMM d, yyyy')}</span> · {h.name}
                </span>
                <button type="button" className="text-xs text-red-700 underline" onClick={() => removeHoliday(h.date)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
