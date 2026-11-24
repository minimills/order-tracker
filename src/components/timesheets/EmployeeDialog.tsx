// @permission-scope admin.employees
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'
import { askText } from '../../lib/confirm'
import { showDate, todayISO } from '../../lib/dates'
import { formatMoney, friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { loadBalances, minimumFor, showHours, usePayrollSettings, type Balances, type Employee } from '../../lib/timesheets'
import { useDepartments } from '../../lib/useDepartments'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

type Rate = { id: string; effective_from: string; pay_type: string; hourly_rate: number | null; annual_salary: number | null; reason: string | null; created_by_name: string | null; created_at: string }
type LeaveChange = { id: string; kind: string; year: number | null; days: number | null; reason: string; created_by_name: string | null; created_at: string }

/**
 * Employee setup: pay type, start date, payroll department, hours per day,
 * other spellings in imported sheets; pay rates with their history (only with
 * "View pay and labour cost"); leave entitlements and banked hour corrections
 * (with "timesheets.adjust", reason required).
 */
export default function EmployeeDialog({ employee, userEmail, userName, onClose, onSaved }: { employee: Employee | null; userEmail?: string; userName?: string; onClose: () => void; onSaved: () => void }) {
  const { departments } = useDepartments()
  const settings = usePayrollSettings()
  const [e, setE] = useState({
    name: employee?.name ?? userName ?? '',
    pay_type: employee?.pay_type ?? 'hourly',
    department_id: employee?.department_id ?? '',
    start_date: employee?.start_date ?? '',
    end_date: employee?.end_date ?? '',
    hours_per_day: employee?.hours_per_day ? String(employee.hours_per_day) : '',
    import_names: (employee?.import_names ?? []).join(', '),
    notes: employee?.notes ?? '',
  })
  const [id, setId] = useState(employee?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [rates, setRates] = useState<Rate[]>([])
  const [rate, setRate] = useState({ from: todayISO(), amount: '', reason: '' })
  const [changes, setChanges] = useState<LeaveChange[]>([])
  const [bal, setBal] = useState<Balances | null>(null)
  const year = Number(todayISO().slice(0, 4))

  const loadExtra = useCallback(async (empId: string) => {
    if (!supabase) return
    supabase.rpc('pay_rate_history', { p_employee: empId }).then(({ data }) => setRates((data as Rate[]) ?? []))
    supabase
      .from('leave_entitlement_changes')
      .select('id, kind, year, days, reason, created_by_name, created_at')
      .eq('employee_id', empId)
      .order('created_at', { ascending: false })
      .then(({ data }) => setChanges((data as LeaveChange[]) ?? []))
    setBal(await loadBalances(empId, year))
  }, [year])
  useEffect(() => {
    // loadExtra() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    if (id) loadExtra(id)
  }, [id, loadExtra])

  async function save() {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('save_employee', {
      p: {
        id,
        user_email: employee?.user_email ?? userEmail ?? null,
        name: e.name,
        pay_type: e.pay_type,
        department_id: e.department_id || null,
        start_date: e.start_date || null,
        end_date: e.end_date || null,
        hours_per_day: e.hours_per_day || null,
        import_names: e.import_names.split(',').map((x) => x.trim()).filter(Boolean),
        notes: e.notes,
      },
    })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(id ? tr("Employee saved.") : tr("Employee added. You can now add the pay rate."))
    setId(data as string)
    onSaved()
  }

  async function addRate() {
    if (!supabase || !id) return
    const amount = Number(rate.amount.replace(/[$,\s]/g, ''))
    const { error } = await supabase.rpc('set_pay_rate', {
      p_employee: id,
      p_effective: rate.from,
      p_pay_type: e.pay_type,
      p_hourly: e.pay_type === 'hourly' ? amount : null,
      p_salary: e.pay_type === 'salaried' ? amount : null,
      p_reason: rate.reason,
    })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Pay rate saved."))
    setRate({ from: todayISO(), amount: '', reason: '' })
    loadExtra(id)
    onSaved()
  }

  async function changeLeave(kind: 'vacation' | 'sick') {
    if (!supabase || !id) return
    const days = await askText(tr("{{value}} days for {{year}} (leave empty to go back to the company rule)", { value: kind === 'vacation' ? tr("Vacation") : tr("Paid sick"), year: year }), { get label() {
    return tr("Days")
  }, initial: '' })
    if (days === null) return
    const reason = await askText(tr("Reason for the change"), { get label() {
    return tr("Reason")
  } })
    if (!reason) return toast.error(tr("A reason is needed."))
    const n = days.trim() === '' ? null : Number(days)
    if (n !== null && (Number.isNaN(n) || n < 0)) return toast.error(tr("Enter a number of days."))
    const minimum = bal ? minimumFor(settings, kind, bal.years_of_service) : 0
    if (n !== null && n < minimum) toast.warning(tr("{{n}} days is less than the PEI minimum of {{minimum}} days for {{value}} years of service.", { n: n, minimum: minimum, value: bal?.years_of_service }), { duration: 10000 })
    const { error } = await supabase.rpc('set_leave_entitlement', { p_employee: id, p_kind: kind, p_year: year, p_days: n, p_reason: reason })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Entitlement changed."))
    loadExtra(id)
  }
  async function adjustBank() {
    if (!supabase || !id) return
    const hours = await askText(tr("Hours to add to the bank (a negative number takes hours away)"), { get label() {
    return tr("Hours")
  } })
    if (!hours) return
    const reason = await askText(tr("Reason for the correction"), { get label() {
    return tr("Reason")
  } })
    if (!reason) return toast.error(tr("A reason is needed."))
    const { error } = await supabase.rpc('adjust_banked_hours', { p_employee: id, p_hours: Number(hours), p_reason: reason })
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Bank corrected."))
    loadExtra(id)
  }

  return (
    <Modal
      title={id ? tr("Employee Setup: {{name}}", { name: e.name }) : tr("Employee Setup")}
      wide
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.close}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={save}>
            {busy ? ACTION.saving : ACTION.save}
          </button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 text-sm">
          <Field label={tr("Name")} htmlFor="emp-name">
            <input id="emp-name" className={inputClass} value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} />
          </Field>
          <p className="text-xs text-slate-500">{employee?.user_email ?? userEmail ? tr("Signs in as {{value}}.", { value: employee?.user_email ?? userEmail }) : tr("No login (for example former staff in imported sheets).")}</p>
          <Field label={tr("Pay type")} htmlFor="emp-pay">
            <select id="emp-pay" className={inputClass} value={e.pay_type} onChange={(x) => setE({ ...e, pay_type: x.target.value as 'hourly' | 'salaried' })}>
              <option value="hourly">{tr("Hourly")}</option>
              <option value="salaried">{tr("Salaried")}</option>
            </select>
          </Field>
          <Field label={tr("Payroll department")} htmlFor="emp-dept" hint={tr("For department totals; the managers of this department and of their other departments approve their weeks.")}>
            <select id="emp-dept" className={inputClass} value={e.department_id} onChange={(x) => setE({ ...e, department_id: x.target.value })}>
              <option value="">{tr("None")}</option>
              {departments
                .filter((d) => !d.archived || d.id === e.department_id)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr("Start date")} htmlFor="emp-start" hint={tr("Years of service count from here.")}>
              <input id="emp-start" type="date" className={inputClass} value={e.start_date} onChange={(x) => setE({ ...e, start_date: x.target.value })} />
            </Field>
            <Field label={tr("Last day (if they left)")} htmlFor="emp-end">
              <input id="emp-end" type="date" className={inputClass} value={e.end_date} onChange={(x) => setE({ ...e, end_date: x.target.value })} />
            </Field>
          </div>
          <Field label={tr("Hours in a full day")} htmlFor="emp-hpd" hint={tr("Empty = {{hours_per_day}} (Admin → Payroll Settings).", { hours_per_day: settings.hours_per_day })}>
            <input id="emp-hpd" inputMode="decimal" className={`${narrowInputClass} w-24`} value={e.hours_per_day} onChange={(x) => setE({ ...e, hours_per_day: x.target.value.replace(/[^0-9.]/g, '') })} />
          </Field>
          <Field label={tr("Other spellings in imported sheets")} htmlFor="emp-alias" hint={tr("Separate with commas, for example “Tom, T. Test”.")}>
            <input id="emp-alias" className={inputClass} value={e.import_names} onChange={(x) => setE({ ...e, import_names: x.target.value })} />
          </Field>
          <Field label={tr("Notes")} htmlFor="emp-notes">
            <textarea id="emp-notes" rows={2} className={inputClass} value={e.notes} onChange={(x) => setE({ ...e, notes: x.target.value })} />
          </Field>
        </div>

        <div className="space-y-4 text-sm">
          {!id && <p className="rounded-md bg-slate-50 p-3 text-slate-600">{tr("Save the employee first; then the pay rate and leave entitlements can be added.")}</p>}
          {id && (
            <Can permission="payroll.pay">
              <section className="rounded-md border border-slate-200 p-3">
                <h3 className="mb-2 font-semibold">{tr("Pay Rate")}</h3>
                {rates.length === 0 ? (
                  <p className="text-slate-500">{tr("No pay rate yet.")}</p>
                ) : (
                  <ul className="mb-2 space-y-1">
                    {rates.map((r, i) => (
                      <li key={r.id} className={i === 0 ? 'font-medium' : 'text-slate-600'}>
                        {tr("From")} {showDate(r.effective_from)}: {r.pay_type === 'hourly' ? tr("{{formatMoney}} an hour", { formatMoney: formatMoney(Number(r.hourly_rate), 'CAD') }) : tr("{{formatMoney}} a year", { formatMoney: formatMoney(Number(r.annual_salary), 'CAD') })}
                        {r.reason && ` · ${r.reason}`}
                        <span className="text-xs text-slate-500"> · {r.created_by_name}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <Can permission="payroll.pay" level="edit">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Field label={tr("From")} htmlFor="rate-from">
                      <input id="rate-from" type="date" className={inputClass} value={rate.from} onChange={(x) => setRate({ ...rate, from: x.target.value })} />
                    </Field>
                    <Field label={e.pay_type === 'hourly' ? tr("Hourly rate (CAD)") : tr("Annual salary (CAD)")} htmlFor="rate-amount">
                      <input id="rate-amount" inputMode="decimal" className={inputClass} value={rate.amount} onChange={(x) => setRate({ ...rate, amount: x.target.value })} />
                    </Field>
                    <Field label={tr("Reason")} htmlFor="rate-reason">
                      <input id="rate-reason" className={inputClass} value={rate.reason} placeholder={tr("for example Raise")} onChange={(x) => setRate({ ...rate, reason: x.target.value })} />
                    </Field>
                  </div>
                  <button type="button" className={`${secondaryButtonClass} mt-2`} disabled={!rate.amount} onClick={addRate}>
                    {tr("Add Pay Rate")}
                  </button>
                  <p className="mt-1 text-xs text-slate-500">{tr("Earlier rates stay in the history and are used for the weeks before the new date (labour cost, compared years).")}</p>
                </Can>
              </section>
            </Can>
          )}
          {id && bal && (
            <section className="rounded-md border border-slate-200 p-3">
              <h3 className="mb-2 font-semibold">{tr("Leave")} {year}</h3>
              <p className="mb-2 text-xs text-slate-500">{bal.years_of_service} {tr("years of service by the end of")} {year}.</p>
              <dl className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1">
                <dt>{tr("Vacation days")}</dt>
                <dd className="tabular-nums">
                  {showHours(bal.vacation.entitlement)} ({showHours(bal.vacation.left)} {tr("left)")}
                </dd>
                <dd>
                  <Can permission="timesheets.adjust" level="edit">
                    <button type="button" className="text-xs text-blue-700 underline" onClick={() => changeLeave('vacation')}>
                      {tr("Change")}
                    </button>
                  </Can>
                </dd>
                <dt>{tr("Paid sick days")}</dt>
                <dd className="tabular-nums">
                  {showHours(bal.sick.entitlement)} ({showHours(bal.sick.left)} {tr("left)")}
                </dd>
                <dd>
                  <Can permission="timesheets.adjust" level="edit">
                    <button type="button" className="text-xs text-blue-700 underline" onClick={() => changeLeave('sick')}>
                      {tr("Change")}
                    </button>
                  </Can>
                </dd>
                <dt>{tr("Banked hours")}</dt>
                <dd className="tabular-nums">{showHours(bal.banked.balance)}</dd>
                <dd>
                  <Can permission="timesheets.adjust" level="edit">
                    <button type="button" className="text-xs text-blue-700 underline" onClick={adjustBank}>
                      {tr("Correct")}
                    </button>
                  </Can>
                </dd>
              </dl>
              {(bal.vacation.entitlement < minimumFor(settings, 'vacation', bal.years_of_service) || bal.sick.entitlement < minimumFor(settings, 'sick', bal.years_of_service)) && (
                <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-800">
                  {tr("Below the PEI minimum for")} {bal.years_of_service} {tr("years of service:")} {minimumFor(settings, 'vacation', bal.years_of_service)} {tr("vacation days and")} {minimumFor(settings, 'sick', bal.years_of_service)} {tr("paid sick days.")}
                </p>
              )}
              {changes.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-slate-100 pt-2 text-xs text-slate-600">
                  {changes.map((c) => (
                    <li key={c.id}>
                      {showDate(c.created_at.slice(0, 10))}: {c.kind === 'vacation' ? tr("vacation") : tr("sick")} {c.year ?? tr("every year")} → {c.days == null ? tr("company rule") : tr("{{showHours}} days", { showHours: showHours(c.days) })} · “{c.reason}” ({c.created_by_name})
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </Modal>
  )
}
