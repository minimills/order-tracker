// @permission-scope admin.scheduling
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { Link } from 'react-router-dom'
import Can from '../../components/Can'
import { buttonClass, Field, inputClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { DEFAULT_SCHEDULING, type SchedulingSettings } from '../../lib/schedule'
import { supabase } from '../../lib/supabase'
import { loadSetting } from '../../lib/useSchedule'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Working days, buffer and how machines in one order are built (holidays: Admin → Company Holidays). */
export default function SchedulingPage() {
  const [f, setF] = useState<SchedulingSettings>(DEFAULT_SCHEDULING)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    loadSetting('scheduling', DEFAULT_SCHEDULING).then(setF)
  }, [])

  async function save(e?: FormEvent, next = f) {
    e?.preventDefault()
    if (!supabase) return
    if (next.working_days.length === 0) return toast.error('Select at least one working day.')
    if (!Number.isInteger(next.buffer_days) || next.buffer_days < 0 || next.buffer_days > 90) return toast.error('Buffer days: 0 to 90.')
    setSaving(true)
    // Holidays live in Admin → Company Holidays now, not in this setting.
    const { holidays: _unused, ...value } = next
    void _unused
    const { error } = await supabase.from('app_settings').upsert({ key: 'scheduling', value })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Scheduling saved. Suggested dates on orders update immediately; promised dates only change when accepted.')
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
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>

      <section className="rounded-lg border border-slate-200 bg-white p-5 text-sm">
        <h2 className="mb-1 font-semibold">Company Holidays</h2>
        <p className="text-slate-600">
          Statutory holidays, company holidays and office closures are kept in Admin → Company Holidays. Days marked as a day off are skipped
          here.
        </p>
        <Can permission="admin.holidays" level="edit">
          <Link to="/admin/holidays" className="mt-2 inline-block underline">
            Open Company Holidays
          </Link>
        </Can>
      </section>
    </div>
  )
}
