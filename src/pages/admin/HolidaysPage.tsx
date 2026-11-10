// @permission-scope admin.holidays
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../../components/form'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { HOLIDAY_KIND, holidayApiUrl, rangeText, showDateTime, type Holiday } from '../../lib/notices'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'

type Settings = { province?: string; last_import_at?: string; last_import_count?: number; last_error?: string | null }
type Status = { scheduled: boolean; pg_cron: boolean; pg_net: boolean }
const PROVINCES: [string, string][] = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'], ['NL', 'Newfoundland and Labrador'],
  ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'],
  ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
]
const COLUMNS = 'id, name, start_date, end_date, kind, day_off, hidden, notes, source, edited'
const blank = () => ({ id: '', name: '', start_date: todayISO(), end_date: '', kind: 'company' as Holiday['kind'], day_off: true, notes: '' })

/**
 * Admin → Company Holidays: PEI statutory holidays (imported from
 * canada-holidays.ca), company holidays and office closures. Days off are used
 * for ship dates and shown on the Notice Board.
 */
export default function HolidaysPage() {
  const [list, setList] = useState<Holiday[]>([])
  const [settings, setSettings] = useState<Settings>({})
  const [status, setStatus] = useState<Status | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const [h, s, st] = await Promise.all([
      supabase.from('company_holidays').select(COLUMNS).order('start_date'),
      supabase.from('app_settings').select('value').eq('key', 'holidays').maybeSingle(),
      supabase.rpc('holiday_schedule_status'),
    ])
    setList((h.data as Holiday[]) ?? [])
    setSettings((s.data?.value as Settings) ?? {})
    setStatus((st.data as Status) ?? null)
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const province = settings.province ?? 'PE'

  /** Reads this year and next year from canada-holidays.ca (in the browser, or through the database if the browser can't). */
  async function importNow() {
    if (!supabase) return
    setBusy(true)
    const year = Number(todayISO().slice(0, 4))
    let saved = 0
    try {
      for (const y of [year, year + 1]) {
        const res = await fetch(holidayApiUrl(province, y))
        if (!res.ok) throw new Error(`canada-holidays.ca answered with code ${res.status}`)
        const { data, error } = await supabase.rpc('apply_statutory_holidays', { p_year: y, p_payload: await res.json() })
        if (error) throw error
        saved += Number(data ?? 0)
      }
      toast.success(`${saved} statutory holidays checked for ${year} and ${year + 1}.`)
    } catch (e) {
      // The browser could not reach the site: ask the database to fetch it instead.
      const { error } = await supabase.rpc('request_statutory_holidays')
      if (error) {
        toast.error(`The holidays could not be imported. ${friendlyError(e as { message?: string })}`)
      } else {
        await new Promise((r) => window.setTimeout(r, 4000))
        const { data } = await supabase.rpc('collect_statutory_holidays')
        if (Number(data ?? 0) > 0) toast.success('Statutory holidays imported.')
        else toast.message('The import has been requested. Reload this page in a minute to see the holidays.')
      }
    }
    setBusy(false)
    void load()
  }

  async function run(fn: () => PromiseLike<{ error: { message?: string; code?: string } | null }>, done: string) {
    setBusy(true)
    const { error } = await fn()
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(done)
    void load()
  }

  async function save() {
    if (!form || !supabase) return
    if (!form.name.trim()) return toast.error('Enter the name.')
    const end = form.end_date || form.start_date
    if (end < form.start_date) return toast.error('The end date must be on or after the start date.')
    const row = { name: form.name.trim(), start_date: form.start_date, end_date: end, kind: form.kind, day_off: form.day_off, notes: form.notes.trim() || null }
    await run(
      () => (form.id ? supabase!.from('company_holidays').update(row).eq('id', form.id) : supabase!.from('company_holidays').insert(row)),
      form.id ? 'Holiday saved.' : 'Holiday added.',
    )
    setForm(null)
  }

  const today = todayISO()
  const shown = list.filter((h) => (showHidden || !h.hidden) && (showPast || h.end_date >= today))
  const years = [...new Set(shown.map((h) => h.start_date.slice(0, 4)))]

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <AdminPageHeader
        title="Company Holidays"
        aside={
          <button type="button" className={buttonClass} onClick={() => setForm(blank())}>
            Add Holiday or Closure
          </button>
        }
      >
        Statutory holidays, company holidays and office closures. Days marked as a day off are skipped when ship dates are worked out, and the next
        ones are shown on the Notice Board.
      </AdminPageHeader>

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Statutory Holidays</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Province" htmlFor="hol-prov">
            <select
              id="hol-prov"
              className={`${narrowInputClass} w-64`}
              value={province}
              onChange={(e) => run(() => supabase!.rpc('set_holiday_province', { p_province: e.target.value }), 'Province saved. Select Import Now to load its holidays.')}
            >
              {PROVINCES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={importNow}>
            {busy ? 'Importing…' : 'Import Now'}
          </button>
        </div>
        <p className="text-sm text-slate-600">
          Imports this year and next year from canada-holidays.ca. Entries you have changed by hand are never overwritten.
          {settings.last_import_at && ` Last import: ${showDateTime(settings.last_import_at)}.`}
        </p>
        {settings.last_error && <p className="text-sm text-red-700">The last automatic import did not work: {settings.last_error}</p>}
        {status && (
          <p className="text-sm">
            {status.scheduled ? (
              <span className="text-green-800">Yearly refresh is on: every December 31 the next two years are imported.</span>
            ) : (
              <span className="flex flex-wrap items-center gap-2 text-amber-800">
                The yearly refresh (every December 31) is not on.
                <button
                  type="button"
                  className={secondaryButtonClass}
                  disabled={busy}
                  onClick={() => run(() => supabase!.rpc('start_holiday_schedule'), 'Yearly refresh turned on.')}
                >
                  Turn On Yearly Refresh
                </button>
                {(!status.pg_cron || !status.pg_net) && <span className="text-xs">It needs the pg_cron and pg_net extensions (Supabase → Database → Extensions).</span>}
              </span>
            )}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">All Holidays and Closures</h2>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className="h-4 w-4" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
              Show past
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className="h-4 w-4" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Show hidden
            </label>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-slate-500">No holidays have been added. Select Import Now to load the statutory holidays.</p>
        ) : (
          years.map((y) => (
            <div key={y} className="mb-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-500">{y}</h3>
              <ul className="divide-y divide-slate-100 text-sm">
                {shown
                  .filter((h) => h.start_date.startsWith(y))
                  .map((h) => (
                    <li key={h.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-2 ${h.hidden ? 'opacity-50' : ''}`}>
                      <span className="w-40 shrink-0 font-medium">{rangeText(h.start_date, h.end_date)}</span>
                      <span className="min-w-0 flex-1">
                        {h.name}
                        <span className="block text-xs text-slate-500">
                          {HOLIDAY_KIND[h.kind]} · {h.day_off ? 'Day off' : 'Open as usual'}
                          {h.source !== 'manual' && (h.edited ? ' · imported, changed by hand' : ' · imported')}
                          {h.hidden && ' · hidden'}
                          {h.notes && ` · ${h.notes}`}
                        </span>
                      </span>
                      <span className="flex gap-3 text-xs">
                        <button
                          type="button"
                          className="underline"
                          onClick={() => setForm({ id: h.id, name: h.name, start_date: h.start_date, end_date: h.end_date, kind: h.kind, day_off: h.day_off, notes: h.notes ?? '' })}
                        >
                          {ACTION.edit}
                        </button>
                        <button
                          type="button"
                          className="underline"
                          disabled={busy}
                          onClick={() => run(() => supabase!.from('company_holidays').update({ hidden: !h.hidden }).eq('id', h.id), h.hidden ? 'Shown again.' : 'Hidden. It no longer counts as a day off.')}
                        >
                          {h.hidden ? 'Show' : 'Hide'}
                        </button>
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {form && (
        <Modal
          title={form.id ? 'Edit Holiday' : 'Add Holiday or Closure'}
          onClose={() => setForm(null)}
          busy={busy}
          footer={
            <>
              <button type="button" className={secondaryButtonClass} onClick={() => setForm(null)} disabled={busy}>
                {ACTION.cancel}
              </button>
              <button type="button" className={buttonClass} onClick={save} disabled={busy}>
                {busy ? ACTION.saving : form.id ? ACTION.save : ACTION.add}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Name" htmlFor="hol-name">
              <input id="hol-name" className={inputClass} maxLength={120} placeholder="for example Christmas break" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start date" htmlFor="hol-start">
                <input id="hol-start" type="date" className={inputClass} value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
              </Field>
              <Field label="End date" htmlFor="hol-end" hint="Leave empty for one day.">
                <input id="hol-end" type="date" className={inputClass} min={form.start_date} value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
              </Field>
            </div>
            <Field label="Type" htmlFor="hol-kind">
              <select id="hol-kind" className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Holiday['kind'] })}>
                {(Object.keys(HOLIDAY_KIND) as Holiday['kind'][]).map((k) => (
                  <option key={k} value={k}>
                    {HOLIDAY_KIND[k]}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.day_off} onChange={(e) => setForm({ ...form, day_off: e.target.checked })} />
              <span>
                Day off: the shop is closed
                <span className="block text-xs text-slate-500">Ship dates and deadlines skip these days.</span>
              </span>
            </label>
            <Field label="Notes (optional)" htmlFor="hol-notes">
              <input id="hol-notes" className={inputClass} maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  )
}
