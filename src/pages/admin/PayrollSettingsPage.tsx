// @permission-scope admin.payroll
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, cardGridClass, Field, inputClass, narrowInputClass, secondaryButtonClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { fillHours, loadPayrollSettings, minimumProblems, showHours, type PayrollSettings, type Tier } from '../../lib/timesheets'
import { ACTION } from '../../lib/wording'

const card = 'space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm'
const n = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? 0 : Number(v))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function Tiers({ id, tiers, onChange, unit }: { id: string; tiers: Tier[]; onChange: (t: Tier[]) => void; unit: string }) {
  return (
    <div className="space-y-2">
      {tiers.map((t, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span>After</span>
          <input aria-label="Years of service" inputMode="decimal" className={`${narrowInputClass} w-16`} value={t.after_years} onChange={(e) => onChange(tiers.map((x, j) => (j === i ? { ...x, after_years: n(e.target.value) } : x)))} />
          <span>years of service:</span>
          <input id={i === 0 ? id : undefined} aria-label={unit} inputMode="decimal" className={`${narrowInputClass} w-16`} value={t.days} onChange={(e) => onChange(tiers.map((x, j) => (j === i ? { ...x, days: n(e.target.value) } : x)))} />
          <span>{unit}</span>
          <button type="button" className="text-slate-500 hover:text-red-700" aria-label="Remove this step" onClick={() => onChange(tiers.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="text-xs text-blue-700 underline" onClick={() => onChange([...tiers, { after_years: (tiers.at(-1)?.after_years ?? 0) + 1, days: tiers.at(-1)?.days ?? 0 }])}>
        + Add a Step
      </button>
    </div>
  )
}

/** Admin → Payroll Settings: overtime, banked overtime, hours per day, vacation and sick days, statutory holiday pay, employer costs, PEI minimums. */
export default function PayrollSettingsPage() {
  const [s, setS] = useState<PayrollSettings | null>(null)
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    loadPayrollSettings().then((v) => {
      setS(v)
      setSaved(JSON.stringify(v))
    })
  }, [])
  if (!s) return <p className="text-sm text-slate-500">Loading…</p>
  const dirty = JSON.stringify(s) !== saved
  const problems = minimumProblems(s)
  const sortTiers = (t: Tier[]) => [...t].sort((a, b) => a.after_years - b.after_years)

  async function save() {
    if (!supabase || !s) return
    setBusy(true)
    const v = { ...s, vacation_tiers: sortTiers(s.vacation_tiers), sick_tiers: sortTiers(s.sick_tiers) }
    const { error } = await supabase.rpc('set_payroll_settings', { p: v })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setS(v)
    setSaved(JSON.stringify(v))
    toast.success(problems.length ? 'Payroll settings saved. Some settings are below the PEI minimum (see the warning).' : 'Payroll settings saved.')
  }

  return (
    <div className="space-y-4">
      <AdminPageHeader title="Payroll Settings">
        Rules for every employee. A single employee’s vacation or sick days can be changed in Admin → Users → Employee Setup (with a reason). Changes apply to every week shown from now on, including past weeks
        that are not approved.
      </AdminPageHeader>

      {problems.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
          <p className="font-semibold">These settings give less than the PEI minimum:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className={cardGridClass}>
        <section className={card} data-setting="pr-overtime">
          <h2 className="text-base font-semibold">Week and Overtime</h2>
          <Field label="The pay week starts on" htmlFor="pr-week">
            <select id="pr-week" className={inputClass} value={s.week_start} onChange={(e) => setS({ ...s, week_start: Number(e.target.value) })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Overtime after (hours a week)" htmlFor="pr-overtime" hint="Hours worked plus banked hours used over this are overtime. The PEI standard is below.">
            <input id="pr-overtime" inputMode="decimal" className={`${narrowInputClass} w-24`} value={s.overtime_weekly_hours} onChange={(e) => setS({ ...s, overtime_weekly_hours: n(e.target.value) })} />
          </Field>
          <Field label="Overtime is paid at (× the hourly rate)" htmlFor="pr-ot-rate">
            <input id="pr-ot-rate" inputMode="decimal" className={`${narrowInputClass} w-24`} value={s.overtime_rate} onChange={(e) => setS({ ...s, overtime_rate: n(e.target.value) })} />
          </Field>
          <Field label="Hours in a full day" htmlFor="pr-hpd" hint="Used for vacation, sick and banked days and statutory holiday pay. Can be changed per employee.">
            <input id="pr-hpd" inputMode="decimal" className={`${narrowInputClass} w-24`} value={s.hours_per_day} onChange={(e) => setS({ ...s, hours_per_day: n(e.target.value) })} />
          </Field>
        </section>

        <section className={card} data-setting="pr-fill">
          <h2 className="text-base font-semibold">Weekday Fill</h2>
          <p className="text-slate-600">
            The hours that “Fill Weekdays” on a timesheet and “Fill Weekday Hours for Everyone” put on each weekday ({showHours(fillHours(s))} paid hours).
          </p>
          <div className="flex flex-wrap gap-3">
            <Field label="Start" htmlFor="pr-fill-start">
              <input id="pr-fill-start" type="time" step={900} className={`${narrowInputClass} w-32`} value={s.fill_start} onChange={(e) => setS({ ...s, fill_start: e.target.value })} />
            </Field>
            <Field label="End" htmlFor="pr-fill-end">
              <input id="pr-fill-end" type="time" step={900} className={`${narrowInputClass} w-32`} value={s.fill_end} onChange={(e) => setS({ ...s, fill_end: e.target.value })} />
            </Field>
            <Field label="Unpaid break (minutes)" htmlFor="pr-fill-break">
              <input id="pr-fill-break" inputMode="numeric" className={`${narrowInputClass} w-24`} value={s.fill_break_minutes} onChange={(e) => setS({ ...s, fill_break_minutes: n(e.target.value) })} />
            </Field>
          </div>
        </section>

        <section className={card} data-setting="pr-bank">
          <h2 className="text-base font-semibold">Banked Hours</h2>
          <p className="text-slate-600">Employees can bank regular or overtime hours instead of being paid for them, and use them later. Regular hours go into the bank one for one.</p>
          <fieldset>
            <legend className="mb-1 font-medium">One banked overtime hour adds to the bank</legend>
            {[1, 1.5].map((v) => (
              <label key={v} className="flex items-center gap-2">
                <input type="radio" name="pr-bank" checked={s.banked_overtime_credit === v} onChange={() => setS({ ...s, banked_overtime_credit: v })} />
                {v === 1 ? '1 hour (1×)' : '1.5 hours (1.5×)'}
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-slate-500">When banked hours used take a week over the overtime threshold, the person entering the hours chooses Overtime or Regular pay for the extra hours; the choice is kept in the week’s history.</p>
        </section>

        <section className={card} data-setting="pr-vacation">
          <h2 className="text-base font-semibold">Vacation Days (Company Rule)</h2>
          <Tiers id="pr-vacation" tiers={s.vacation_tiers} unit="days a year" onChange={(t) => setS({ ...s, vacation_tiers: t })} />
          <p className="text-xs text-slate-500">A calendar year counts the years of service reached by December 31 of that year.</p>
        </section>

        <section className={card} data-setting="pr-sick">
          <h2 className="text-base font-semibold">Paid Sick Days (Company Rule)</h2>
          <Tiers id="pr-sick" tiers={s.sick_tiers} unit="paid days a year" onChange={(t) => setS({ ...s, sick_tiers: t })} />
        </section>

        <section className={card} data-setting="pr-stat">
          <h2 className="text-base font-semibold">Statutory Holidays and Labour Cost</h2>
          <p className="text-slate-600">Holidays come from Admin → Company Holidays. Eligible employees are paid their hours for a full day on each one that falls on a working day.</p>
          <fieldset>
            <legend className="mb-1 font-medium">Paid holidays</legend>
            {[
              ['statutory', 'Statutory holidays'],
              ['company', 'Company holidays'],
              ['closure', 'Office closures'],
            ].map(([k, l]) => (
              <label key={k} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.paid_holiday_kinds.includes(k)}
                  onChange={(e) => setS({ ...s, paid_holiday_kinds: e.target.checked ? [...s.paid_holiday_kinds, k] : s.paid_holiday_kinds.filter((x) => x !== k) })}
                />
                {l}
              </label>
            ))}
          </fieldset>
          <Field label="Paid after (days of employment)" htmlFor="pr-stat">
            <input id="pr-stat" inputMode="numeric" className={`${narrowInputClass} w-24`} value={s.stat_min_days_employed} onChange={(e) => setS({ ...s, stat_min_days_employed: n(e.target.value) })} />
          </Field>
          <Field label="Employer costs (CPP, EI, WCB) as a % of pay" htmlFor="pr-employer" hint="Added to the labour cost only.">
            <input id="pr-employer" inputMode="decimal" className={`${narrowInputClass} w-24`} value={s.employer_cost_pct} onChange={(e) => setS({ ...s, employer_cost_pct: n(e.target.value) })} />
          </Field>
        </section>

        <section className={card} data-setting="pr-minimum">
          <h2 className="text-base font-semibold">PEI Minimum Standards</h2>
          <p className="text-slate-600">
            The app warns when a setting, or one employee’s entitlement, gives less than these. Check them against the PEI Employment Standards Act when it changes (a new Act came into force on June 30, 2026).
          </p>
          <Field label="Overtime after at most (hours a week)" htmlFor="pr-min-ot">
            <input id="pr-min-ot" inputMode="decimal" className={`${narrowInputClass} w-24`} value={s.pei_minimum.overtime_weekly_hours} onChange={(e) => setS({ ...s, pei_minimum: { ...s.pei_minimum, overtime_weekly_hours: n(e.target.value) } })} />
          </Field>
          <p className="font-medium">Minimum vacation</p>
          <Tiers id="pr-min-vac" tiers={s.pei_minimum.vacation_tiers} unit="days a year" onChange={(t) => setS({ ...s, pei_minimum: { ...s.pei_minimum, vacation_tiers: t } })} />
          <p className="font-medium">Minimum paid sick days</p>
          <Tiers id="pr-min-sick" tiers={s.pei_minimum.sick_tiers} unit="paid days a year" onChange={(t) => setS({ ...s, pei_minimum: { ...s.pei_minimum, sick_tiers: t } })} />
        </section>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} disabled={!dirty || busy} onClick={() => setS(JSON.parse(saved))}>
          {ACTION.cancel}
        </button>
        <button type="button" className={buttonClass} disabled={!dirty || busy} onClick={save}>
          {busy ? ACTION.saving : ACTION.save}
        </button>
      </div>
    </div>
  )
}
