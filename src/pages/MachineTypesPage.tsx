import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { formatSerial, friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { MachineType } from '../lib/types'

type Usage = { machine_type_id: string; machines_count: number; highest_serial_number: number | null }

type Draft = { name: string; code: string; next: string }

const codePattern = /^[A-Z0-9]*$/

function toDraft(t: MachineType): Draft {
  return { name: t.name, code: t.code ?? '', next: String(t.next_serial_number) }
}

/** Checks a draft; returns error messages by field. */
function check(d: Draft, others: MachineType[]) {
  const e: Partial<Record<keyof Draft, string>> = {}
  const name = d.name.trim()
  const code = d.code.trim().toUpperCase()
  if (!name) e.name = 'Enter a name.'
  else if (others.some((t) => t.name.toLowerCase() === name.toLowerCase())) e.name = 'Another type has this name.'
  if (!codePattern.test(code)) e.code = 'Use only capital letters and numbers, e.g. LCR.'
  else if (code && others.some((t) => t.code === code)) e.code = 'Another type uses this code.'
  if (!/^\d+$/.test(d.next.trim()) || Number(d.next) < 1) e.next = 'Enter a whole number, 1 or more.'
  return e
}

export default function MachineTypesPage() {
  const { isAdmin } = useAuth()
  const [types, setTypes] = useState<MachineType[]>([])
  const [usage, setUsage] = useState<Record<string, Usage>>({})
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [errors, setErrors] = useState<Record<string, Partial<Record<keyof Draft, string>>>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [newType, setNewType] = useState<Draft>({ name: '', code: '', next: '1' })
  const [newErrors, setNewErrors] = useState<Partial<Record<keyof Draft, string>>>({})

  const load = useCallback(async () => {
    if (!supabase) return
    const [t, u] = await Promise.all([
      supabase.from('machine_types').select('id, name, code, next_serial_number, archived').order('name'),
      supabase.from('machine_type_usage').select('*'),
    ])
    if (t.error) toast.error(friendlyError(t.error))
    const list = (t.data as MachineType[]) ?? []
    setTypes(list)
    setDrafts(Object.fromEntries(list.map((x) => [x.id, toDraft(x)])))
    setUsage(Object.fromEntries(((u.data as Usage[]) ?? []).map((x) => [x.machine_type_id, x])))
    setErrors({})
    setLoading(false)
  }, [])

  useEffect(() => {
    // load() only sets state after the database answers, so this is fine.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const isChanged = (t: MachineType) => {
    const d = drafts[t.id]
    if (!d) return false
    const o = toDraft(t)
    return d.name.trim() !== o.name || d.code.trim().toUpperCase() !== o.code || d.next.trim() !== o.next
  }

  async function save(t: MachineType) {
    if (!supabase) return
    const d = drafts[t.id]
    const e = check(d, types.filter((x) => x.id !== t.id))
    setErrors((all) => ({ ...all, [t.id]: e }))
    if (Object.keys(e).length) return
    const code = d.code.trim().toUpperCase()
    const used = usage[t.id]?.machines_count ?? 0
    if (t.code && code !== t.code && used > 0) {
      const ok = window.confirm(
        `${used} machine(s) already have ${t.code} serials. They keep their old serials; only new machines get ${code || 'no'} serials. Change the code?`,
      )
      if (!ok) return
    }
    setSavingId(t.id)
    const { error } = await supabase
      .from('machine_types')
      .update({ name: d.name.trim(), code: code || null, next_serial_number: Number(d.next) })
      .eq('id', t.id)
    setSavingId(null)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${d.name.trim()} saved.`)
    load()
  }

  async function setArchived(t: MachineType, archived: boolean) {
    if (!supabase) return
    const { error } = await supabase.from('machine_types').update({ archived }).eq('id', t.id)
    if (error) return toast.error(friendlyError(error))
    toast.success(archived ? `${t.name} archived. It won't be offered for new orders.` : `${t.name} is back.`)
    load()
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    const e = check(newType, types)
    setNewErrors(e)
    if (Object.keys(e).length) return
    setSavingId('new')
    const { error } = await supabase.from('machine_types').insert({
      name: newType.name.trim(),
      code: newType.code.trim().toUpperCase() || null,
      next_serial_number: Number(newType.next),
    })
    setSavingId(null)
    if (error) return toast.error(friendlyError(error))
    toast.success(`${newType.name.trim()} added.`)
    setNewType({ name: '', code: '', next: '1' })
    load()
  }

  const visible = types.filter((t) => showArchived || !t.archived)

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-slate-600 underline">
          ← Admin
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Machine types</h1>
        <p className="mt-1 text-sm text-slate-600">
          The code and next serial number decide the serials new machines get, e.g. code LCR and next number 2073 gives
          LCR-2073.
          {!isAdmin && ' Only admins can make changes.'}
        </p>
      </div>

      {isAdmin && (
        <form onSubmit={add} className="rounded-lg border border-slate-200 bg-white p-4" noValidate>
          <h2 className="mb-3 text-base font-semibold">Add a machine type</h2>
          <div className="grid gap-3 md:grid-cols-[1fr_8rem_9rem_auto]">
            <Field label="Name" htmlFor="new-name" error={newErrors.name}>
              <input
                id="new-name"
                className={inputClass}
                value={newType.name}
                onChange={(e) => setNewType({ ...newType, name: e.target.value })}
              />
            </Field>
            <Field label="Code" htmlFor="new-code" error={newErrors.code} hint="Can be left empty for now.">
              <input
                id="new-code"
                className={`${inputClass} uppercase`}
                value={newType.code}
                onChange={(e) => setNewType({ ...newType, code: e.target.value })}
              />
            </Field>
            <Field label="Next serial number" htmlFor="new-next" error={newErrors.next}>
              <input
                id="new-next"
                inputMode="numeric"
                className={inputClass}
                value={newType.next}
                onChange={(e) => setNewType({ ...newType, next: e.target.value })}
              />
            </Field>
            <div className="flex items-start md:pt-6">
              <button type="submit" className={buttonClass} disabled={savingId === 'new'}>
                {savingId === 'new' ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="flex items-center justify-end">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {loading ? (
        <p className="text-center text-slate-500">Loading…</p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          <div className="hidden grid-cols-[1fr_7rem_8rem_12rem_9rem] gap-3 px-4 py-2 text-xs text-slate-500 md:grid">
            <span>Name</span>
            <span>Code</span>
            <span>Next serial no.</span>
            <span>Machines / highest serial</span>
            <span />
          </div>
          {visible.map((t) => {
            const d = drafts[t.id] ?? toDraft(t)
            const e = errors[t.id] ?? {}
            const u = usage[t.id]
            const set = (field: keyof Draft, v: string) => setDrafts((all) => ({ ...all, [t.id]: { ...d, [field]: v } }))
            const nextNum = Number(d.next)
            const highest = u?.highest_serial_number ?? null
            const lowWarning = highest !== null && nextNum <= highest && !e.next
            const code = d.code.trim().toUpperCase()
            return (
              <div
                key={t.id}
                className={`grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-[1fr_7rem_8rem_12rem_9rem] md:items-start ${
                  t.archived ? 'bg-slate-50 text-slate-500' : ''
                }`}
              >
                <Field label="Name" error={e.name} className="col-span-2 md:col-span-1 [&>label]:md:hidden">
                  <input
                    aria-label="Name"
                    className={inputClass}
                    value={d.name}
                    disabled={!isAdmin}
                    onChange={(ev) => set('name', ev.target.value)}
                  />
                </Field>
                <Field label="Code" error={e.code} className="[&>label]:md:hidden">
                  <input
                    aria-label="Code"
                    className={`${inputClass} uppercase`}
                    value={d.code}
                    placeholder="—"
                    disabled={!isAdmin}
                    onChange={(ev) => set('code', ev.target.value)}
                  />
                </Field>
                <Field
                  label="Next serial no."
                  error={e.next}
                  className="[&>label]:md:hidden"
                  hint={code && !e.next && nextNum >= 1 ? `Next: ${formatSerial(code, nextNum)}` : undefined}
                >
                  <input
                    aria-label="Next serial number"
                    inputMode="numeric"
                    className={inputClass}
                    value={d.next}
                    disabled={!isAdmin}
                    onChange={(ev) => set('next', ev.target.value)}
                  />
                </Field>
                <div className="col-span-2 text-sm md:col-span-1 md:pt-2">
                  {u?.machines_count ? (
                    <>
                      {u.machines_count} machine{u.machines_count === 1 ? '' : 's'}
                      {highest !== null && t.code && <> · highest {formatSerial(t.code, highest)}</>}
                    </>
                  ) : (
                    <span className="text-slate-400">No machines yet</span>
                  )}
                  {lowWarning && (
                    <p className="mt-1 text-xs text-amber-700">
                      Numbers up to {highest} are already used; taken numbers will be skipped. You probably want{' '}
                      {highest + 1}.
                    </p>
                  )}
                </div>
                {isAdmin && (
                  <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1">
                    {isChanged(t) && (
                      <>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={savingId === t.id}
                          onClick={() => save(t)}
                        >
                          {savingId === t.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          className="text-xs underline"
                          onClick={() => {
                            setDrafts((all) => ({ ...all, [t.id]: toDraft(t) }))
                            setErrors((all) => ({ ...all, [t.id]: {} }))
                          }}
                        >
                          Undo
                        </button>
                      </>
                    )}
                    {!isChanged(t) && (
                      <button type="button" className={secondaryButtonClass} onClick={() => setArchived(t, !t.archived)}>
                        {t.archived ? 'Bring back' : 'Archive'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
