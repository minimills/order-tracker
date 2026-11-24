// @permission-scope crating.handoff
/* Drawn only inside <Can permission="crating.handoff"> on the Order page; crating_handoff_status and set_crating_assignee check again. */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../Can'
import { inputClass, Section } from '../form'
import { activityTime } from '../../lib/activity'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { tr } from '../../i18n'

type Status = {
  crating: boolean
  assignee: string | null
  assignee_name: string | null
  machines_needing: number
  machines_missing: { id: string; serial: string | null; machine: string | null }[]
  crates: number
  crates_incomplete: { id: string; missing: string[] }[]
  complete: boolean
  ready_at: string | null
  notified_at: string | null
  notified_to_name: string | null
  shipping_contact_name: string | null
}

/**
 * Order page: who crates this order, what is still missing (machines without
 * a crate, crates without sheets, time, size or weight), and whether the
 * person who arranges shipping was told the quote information is ready.
 * `version` changes whenever the crates change, so the status is read again.
 */
export default function CratingHandoff({ orderId, version }: { orderId: string; version: string }) {
  const [s, setS] = useState<Status | null>(null)
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [again, setAgain] = useState(0)

  useEffect(() => {
    if (!supabase) return
    let off = false
    // The status is worked out when the crates are saved (at the end of the save); read it a moment later.
    const t = window.setTimeout(() => {
      supabase!.rpc('crating_handoff_status', { p_order: orderId }).then(({ data, error }) => {
        if (off) return
        if (error) return toast.error(friendlyError(error))
        setS(data as Status)
      })
    }, 300)
    return () => {
      off = true
      window.clearTimeout(t)
    }
  }, [orderId, version, again])

  useEffect(() => {
    supabase?.rpc('crating_people').then(({ data }) => setPeople((data as { email: string; name: string }[] | null) ?? []))
  }, [])

  async function assign(email: string) {
    if (!supabase) return
    const { error } = await supabase.rpc('set_crating_assignee', { p_order: orderId, p_email: email || null })
    if (error) return toast.error(friendlyError(error))
    toast.success(email ? tr("Crating assigned. They are told in the app.") : tr("Nobody is assigned to crating now."))
    setAgain((n) => n + 1)
  }

  if (!s || !s.crating) return null
  const crateWord = (n: number) => `${n} crate${n === 1 ? '' : 's'}`
  return (
    <Section title={tr("Crating Hand-off")}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-600">{tr("Crated by")}</span>
          <Can permission="crating.assign" level="edit" fallback={<span className="font-medium">{s.assignee_name ?? tr("Nobody assigned")}</span>}>
            <select aria-label={tr("Person who crates this order")} className={`${inputClass} w-56`} value={s.assignee ?? ''} onChange={(e) => assign(e.target.value)}>
              <option value="">{tr("Nobody assigned")}</option>
              {s.assignee && !people.some((p) => p.email === s.assignee) && <option value={s.assignee}>{s.assignee_name ?? s.assignee}</option>}
              {people.map((p) => (
                <option key={p.email} value={p.email}>
                  {p.name}
                </option>
              ))}
            </select>
          </Can>
        </div>

        {s.complete ? (
          <div className="rounded-md border border-green-300 bg-green-50 p-3 text-green-900" role="status">
            <p className="font-medium">{tr("Every crate is entered (")}{crateWord(s.crates)}{tr("): ready for a shipping quote.")}</p>
            <p className="text-xs">
              {s.notified_at
                ? tr("{{value}} was told {{value2}} (in the app, by phone push and email).", { value: s.notified_to_name ?? tr("The person who arranges shipping"), value2: activityTime.format(new Date(s.notified_at)) })
                : s.shipping_contact_name
                  ? tr("{{shipping_contact_name}} will be told.", { shipping_contact_name: s.shipping_contact_name })
                  : tr("Nobody was told: choose the person who arranges shipping in Admin → Freight Settings.")}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
            <p className="font-medium">
              {s.crates === 0 ? tr("No crates entered yet.") : tr("{{crateWord}} entered; the shipping quote information is not complete yet.", { crateWord: crateWord(s.crates) })}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              {s.machines_missing.map((m) => (
                <li key={m.id}>
                  {m.machine ?? tr("Machine")} {m.serial ?? ''}{tr(": no crate yet")}
                </li>
              ))}
              {s.crates_incomplete.map((c, i) => (
                <li key={c.id}>
                  {tr("A crate")}{s.crates_incomplete.length > 1 ? ` (${i + 1})` : ''} {tr("is missing its")} {c.missing.join(', ')}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs">
              {tr("When every crate has its plywood sheets, time, size and weight,")} {s.shipping_contact_name ?? tr("the person who arranges shipping")} {tr("is told automatically.")}
            </p>
          </div>
        )}

        <Can permission="freight.quote">
          <Link to={`/freight/quote?order=${orderId}`} className="inline-block text-sm font-medium text-blue-700 underline">
            {tr("Open the Freight Quote Request")}
          </Link>
        </Can>
      </div>
    </Section>
  )
}
