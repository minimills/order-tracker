import { useCallback, useEffect, useState } from 'react'
import { addDaysISO } from './dates'
import { supabase } from './supabase'

/** Timesheets (migrations 0044–0047). The weekly arithmetic is the same as `timesheet_week_rows()` in SQL: keep the two in step. */

export type Tier = { after_years: number; days: number }
export type PayrollSettings = {
  week_start: number
  overtime_weekly_hours: number
  overtime_rate: number
  banked_overtime_credit: number
  hours_per_day: number
  vacation_tiers: Tier[]
  sick_tiers: Tier[]
  stat_min_days_employed: number
  paid_holiday_kinds: string[]
  employer_cost_pct: number
  pei_minimum: { overtime_weekly_hours: number; vacation_tiers: Tier[]; sick_tiers: Tier[] }
}

export const DEFAULT_PAYROLL: PayrollSettings = {
  week_start: 1,
  overtime_weekly_hours: 44,
  overtime_rate: 1.5,
  banked_overtime_credit: 1.5,
  hours_per_day: 8,
  vacation_tiers: [
    { after_years: 1, days: 10 },
    { after_years: 5, days: 15 },
  ],
  sick_tiers: [{ after_years: 1, days: 3 }],
  stat_min_days_employed: 30,
  paid_holiday_kinds: ['statutory'],
  employer_cost_pct: 0,
  pei_minimum: {
    overtime_weekly_hours: 44,
    vacation_tiers: [
      { after_years: 1, days: 10 },
      { after_years: 5, days: 15 },
    ],
    sick_tiers: [
      { after_years: 1, days: 1 },
      { after_years: 2, days: 2 },
      { after_years: 3, days: 3 },
    ],
  },
}

export async function loadPayrollSettings(): Promise<PayrollSettings> {
  if (!supabase) return DEFAULT_PAYROLL
  const { data } = await supabase.rpc('payroll_settings')
  return { ...DEFAULT_PAYROLL, ...((data as Partial<PayrollSettings> | null) ?? {}) }
}

export function usePayrollSettings() {
  const [s, setS] = useState<PayrollSettings>(DEFAULT_PAYROLL)
  useEffect(() => {
    loadPayrollSettings().then(setS)
  }, [])
  return s
}

/** Days for a number of years of service (the highest tier reached). */
export function tierDays(tiers: Tier[], years: number) {
  return tiers.filter((t) => years >= t.after_years).reduce((m, t) => Math.max(m, t.days), 0)
}

/** Every year of service where the company rule gives less than the PEI minimum (checked up to 40 years). */
export function belowMinimum(rule: Tier[], minimum: Tier[]) {
  const points = [...new Set([...rule, ...minimum].map((t) => t.after_years))].sort((a, b) => a - b)
  return points.filter((y) => tierDays(rule, y) < tierDays(minimum, y)).map((y) => ({ years: y, rule: tierDays(rule, y), minimum: tierDays(minimum, y) }))
}

/** Warnings for Admin → Payroll Settings (and per employee) when something gives less than the PEI minimum. */
export function minimumProblems(s: PayrollSettings): string[] {
  const out: string[] = []
  if (s.overtime_weekly_hours > s.pei_minimum.overtime_weekly_hours) {
    out.push(`Overtime starts after ${s.overtime_weekly_hours} hours a week, later than the PEI standard of ${s.pei_minimum.overtime_weekly_hours} hours.`)
  }
  if (s.overtime_rate < 1.5) out.push(`Overtime is paid at ${s.overtime_rate} times the rate; PEI requires at least 1.5 times.`)
  for (const b of belowMinimum(s.vacation_tiers, s.pei_minimum.vacation_tiers)) {
    out.push(`After ${b.years} year${b.years === 1 ? '' : 's'} of service the rule gives ${b.rule} vacation days; the PEI minimum is ${b.minimum}.`)
  }
  for (const b of belowMinimum(s.sick_tiers, s.pei_minimum.sick_tiers)) {
    out.push(`After ${b.years} year${b.years === 1 ? '' : 's'} of service the rule gives ${b.rule} paid sick days; the PEI minimum is ${b.minimum}.`)
  }
  if (!s.paid_holiday_kinds.includes('statutory')) out.push('Statutory holidays are not paid. PEI requires holiday pay for eligible employees.')
  return out
}

/** The minimum for one employee's years of service. */
export function minimumFor(s: PayrollSettings, kind: 'vacation' | 'sick', years: number) {
  return tierDays(kind === 'vacation' ? s.pei_minimum.vacation_tiers : s.pei_minimum.sick_tiers, years)
}

// ---------------------------------------------------------------------------
// Weeks and hours
// ---------------------------------------------------------------------------
export const KINDS = [
  { key: 'work', label: 'Worked' },
  { key: 'vacation', label: 'Vacation' },
  { key: 'sick', label: 'Sick' },
  { key: 'banked', label: 'Banked time used' },
  { key: 'unpaid', label: 'Unpaid time off' },
] as const
export type EntryKind = (typeof KINDS)[number]['key']
export const kindLabel = (k: string) => KINDS.find((x) => x.key === k)?.label ?? k

export const TIME_OFF_KINDS = [
  { key: 'vacation', label: 'Vacation' },
  { key: 'sick', label: 'Sick' },
  { key: 'banked', label: 'Banked time' },
  { key: 'unpaid', label: 'Unpaid time off' },
] as const
export const timeOffLabel = (k: string) => TIME_OFF_KINDS.find((x) => x.key === k)?.label ?? k

/** ISO day of the week (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export function isoDow(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay()
  return d === 0 ? 7 : d
}

/** The first day of the pay week holding a date. */
export function weekStartOf(iso: string, weekStart = 1) {
  return addDaysISO(iso, -((isoDow(iso) - weekStart + 7) % 7))
}

export const weekDays = (start: string) => Array.from({ length: 7 }, (_, i) => addDaysISO(start, i))

/** Hours from a start, an end (past midnight allowed) and an unpaid break in minutes. */
export function hoursFrom(start: string, end: string, breakMinutes: number) {
  if (!start || !end) return null
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins <= 0) mins += 24 * 60
  mins -= breakMinutes || 0
  return mins < 0 ? null : Math.round((mins / 60) * 100) / 100
}

/** "8", "7.5", "7.25" (no trailing zeros). */
export function showHours(h: number | null | undefined) {
  if (h == null || Number.isNaN(Number(h))) return '—'
  return String(Math.round(Number(h) * 100) / 100)
}

export type WeekRow = {
  employee_id: string
  employee_name: string
  user_email: string | null
  pay_type: 'hourly' | 'salaried'
  department_id: string | null
  week_start: string
  week_id: string | null
  status: 'open' | 'approved'
  approved_by_name: string | null
  worked: number
  banked_used: number
  vacation: number
  sick: number
  unpaid: number
  stat: number
  earned_regular: number
  earned_overtime: number
  credited: number
  threshold: number
  over_by_banked: number
  ot_choice: 'overtime' | 'regular' | null
  ot_choice_by_name: string | null
  ot_choice_at: string | null
  overtime: number
  regular: number
  paid_regular: number
  paid_overtime: number
  needs_review: boolean
  entries: number
  imported: boolean
}

const num = (v: unknown) => Number(v ?? 0)
export function toWeekRow(r: Record<string, unknown>): WeekRow {
  const n = ['worked', 'banked_used', 'vacation', 'sick', 'unpaid', 'stat', 'earned_regular', 'earned_overtime', 'credited', 'threshold', 'over_by_banked', 'overtime', 'regular', 'paid_regular', 'paid_overtime']
  const out = { ...r } as Record<string, unknown>
  for (const k of n) out[k] = num(r[k])
  return out as WeekRow
}

export async function loadWeekRows(from: string, to: string, employee?: string): Promise<WeekRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('timesheet_week_rows', { p_from: from, p_to: to, p_employee: employee ?? null })
  if (error) throw error
  return ((data as Record<string, unknown>[]) ?? []).map(toWeekRow)
}

/**
 * The week in the browser before saving (same rules as the database):
 * overtime = worked over the threshold, plus the hours banked time used adds
 * over it unless "Regular pay" was chosen. Salaried employees have no overtime.
 */
export function previewWeek(e: { kind: string; hours: number }[], threshold: number, payType: string, choice: 'overtime' | 'regular' | null) {
  const sum = (k: string) => e.filter((x) => x.kind === k).reduce((s, x) => s + (Number(x.hours) || 0), 0)
  const worked = sum('work')
  const banked = sum('banked')
  const otBase = Math.max(0, worked - threshold)
  const extra = Math.max(0, worked + banked - threshold) - otBase
  const overtime = payType !== 'hourly' ? 0 : choice === 'regular' ? otBase : otBase + extra
  return { worked, banked, vacation: sum('vacation'), sick: sum('sick'), unpaid: sum('unpaid'), total: worked + banked, extra, overtime, regular: worked + banked - overtime }
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
export type Employee = {
  id: string
  user_email: string | null
  name: string
  pay_type: 'hourly' | 'salaried'
  department_id: string | null
  start_date: string | null
  end_date: string | null
  hours_per_day: number | null
  import_names: string[]
  notes: string | null
  archived: boolean
}

export function useEmployees(includeArchived = false) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    if (!supabase) return
    let q = supabase.from('employees').select('id, user_email, name, pay_type, department_id, start_date, end_date, hours_per_day, import_names, notes, archived').order('name')
    if (!includeArchived) q = q.eq('archived', false)
    const { data } = await q
    setEmployees((data as Employee[]) ?? [])
    setLoading(false)
  }, [includeArchived])
  useEffect(() => {
    // reload() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    reload()
  }, [reload])
  return { employees, loading, reload }
}

export type Balances = {
  year: number
  hours_per_day: number
  years_of_service: number
  banked: { earned: number; used: number; balance: number }
  vacation: { entitlement: number; used_days: number; used_hours: number; left: number }
  sick: { entitlement: number; used_days: number; used_hours: number; left: number }
  unpaid_hours: number
}

export async function loadBalances(employee: string, year: number): Promise<Balances | null> {
  if (!supabase) return null
  const { data } = await supabase.rpc('employee_balances', { p_employee: employee, p_year: year })
  return (data as Balances | null) ?? null
}

export type Person = { email: string; name: string }
export function useTsPeople() {
  const [people, setPeople] = useState<Person[]>([])
  useEffect(() => {
    supabase?.rpc('ts_people').then(({ data }) => setPeople((data as Person[]) ?? []))
  }, [])
  return people
}

/** Months between two dates as YYYY-MM keys. */
export function monthsBetween(from: string, to: string) {
  const out: string[] = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const [ty, tm] = to.slice(0, 7).split('-').map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

export const STATUS_WORDS: Record<string, string> = { pending: 'Waiting for a decision', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' }
