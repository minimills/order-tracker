// @permission-scope admin.machine_types
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { friendlyError } from '../../lib/format'
import { STEPS, stepTime, type StepKey, type StepStat, type TypeBuild } from '../../lib/schedule'
import { supabase } from '../../lib/supabase'
import { inputClass, secondaryButtonClass } from '../form'

type Row = TypeBuild & { archived: boolean }
type Draft = Record<StepKey, string>

const toDraft = (t: TypeBuild): Draft => Object.fromEntries(STEPS.map((s) => [s.key, t.build_days?.[s.key] != null ? String(t.build_days[s.key]) : ''])) as Draft

/**
 * Default working days per step for each machine type. The schedule uses the
 * average of the last 5 completed builds instead once there are at least 3.
 */
export default function BuildTimesSection() {
  const [rows, setRows] = useState<Row[]>([])
  const [stats, setStats] = useState<StepStat[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    if (!supabase) return
    const [t, s] = await Promise.all([
      supabase.from('machine_types').select('id, name, build_days, archived').eq('archived', false).order('name'),
      supabase.from('machine_type_step_stats').select('*'),
    ])
    if (t.error) return toast.error(friendlyError(t.error))
    const list = (t.data as Row[]) ?? []
    setRows(list)
    setStats((s.data as StepStat[] | null) ?? [])
    setDrafts(Object.fromEntries(list.map((x) => [x.id, toDraft(x)])))
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function save(t: Row) {
    if (!supabase) return
    const d = drafts[t.id]
    const value: Partial<Record<StepKey, number>> = {}
    for (const s of STEPS) {
      const raw = d[s.key].trim()
      if (raw === '') continue
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || n > 365) return toast.error(`${t.name}: ${s.label} must be between 0 and 365 days.`)
      value[s.key] = Math.round(n)
    }
    setSaving(t.id)
    const { error } = await supabase.from('machine_types').update({ build_days: value }).eq('id', t.id)
    setSaving(null)
    if (error) return toast.error(friendlyError(error))
    toast.success(`Build times saved for ${t.name}.`)
    setRows((all) => all.map((r) => (r.id === t.id ? { ...r, build_days: value } : r)))
  }

  const shown = rows.filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase()))

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" data-setting="build-times">
      <h2 className="text-base font-semibold">Build Times (Working Days per Step)</h2>
      <p className="mt-1 text-sm text-slate-600">
        The default time each step takes for one machine. Once a type has at least 3 completed builds of a step, the
        schedule uses the average of the last 5 instead; the line under each box shows which is used.
      </p>
      <input
        aria-label="Find a machine type"
        className={`${inputClass} mt-3 max-w-xs`}
        placeholder="Find a machine type"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1 pr-3 font-normal">Machine type</th>
              {STEPS.map((s) => (
                <th key={s.key} className="px-1 py-1 font-normal">
                  {s.label}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((t) => {
              const d = drafts[t.id] ?? toDraft(t)
              const changed = STEPS.some((s) => d[s.key] !== toDraft(t)[s.key])
              return (
                <tr key={t.id} className="align-top">
                  <td className="py-2 pr-3 font-medium">{t.name}</td>
                  {STEPS.map((s) => {
                    const used = stepTime(t, s.key, stats)
                    return (
                      <td key={s.key} className="px-1 py-2">
                        <input
                          aria-label={`${t.name} – ${s.label} (days)`}
                          inputMode="numeric"
                          className={`${inputClass} w-20`}
                          value={d[s.key]}
                          placeholder="0"
                          onChange={(e) => setDrafts((all) => ({ ...all, [t.id]: { ...d, [s.key]: e.target.value } }))}
                        />
                        <div className={`mt-0.5 text-[11px] ${used.source === 'average' ? 'text-blue-700' : 'text-slate-500'}`}>
                          {used.source === 'average' ? `average of ${used.builds}: ${used.days}` : 'default used'}
                        </div>
                      </td>
                    )
                  })}
                  <td className="py-2 pl-2">
                    <button type="button" className={secondaryButtonClass} disabled={!changed || saving === t.id} onClick={() => save(t)}>
                      {saving === t.id ? 'Saving…' : 'Save Changes'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
