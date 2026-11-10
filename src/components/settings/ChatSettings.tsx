// @permission-scope settings.quiet_hours, settings.chat_status
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, narrowInputClass } from '../form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type S = { hide_status: boolean; quiet_enabled: boolean; quiet_start: string; quiet_end: string }
const DEFAULTS: S = { hide_status: false, quiet_enabled: false, quiet_start: '21:00', quiet_end: '07:00' }

/** My settings: quiet hours (no phone notifications) and hiding my online status in chat. */
export default function ChatSettings() {
  const [s, setS] = useState<S>(DEFAULTS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase
      ?.from('chat_settings')
      .select('hide_status, quiet_enabled, quiet_start, quiet_end')
      .maybeSingle()
      .then(({ data }) => data && setS({ ...(data as S), quiet_start: String(data.quiet_start).slice(0, 5), quiet_end: String(data.quiet_end).slice(0, 5) }))
  }, [])

  async function save(patch: Partial<S>) {
    if (!supabase) return
    setSaving(true)
    const { error } = await supabase.rpc('set_my_chat_settings', { p: patch })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Saved.')
  }

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <Can permission="settings.quiet_hours" level="edit">
        <div className="space-y-2">
          <h2 className="text-base font-semibold">Quiet Hours</h2>
          <p className="text-slate-600">No phone notifications during these hours (Halifax time). Messages still appear in the bell and in Chat.</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.quiet_enabled} onChange={(e) => setS({ ...s, quiet_enabled: e.target.checked })} />
            Use quiet hours
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From" htmlFor="qh-start">
              <input
                id="qh-start"
                type="time"
                className={`${narrowInputClass} w-32`}
                value={s.quiet_start}
                onChange={(e) => setS({ ...s, quiet_start: e.target.value })}
              />
            </Field>
            <Field label="Until" htmlFor="qh-end">
              <input
                id="qh-end"
                type="time"
                className={`${narrowInputClass} w-32`}
                value={s.quiet_end}
                onChange={(e) => setS({ ...s, quiet_end: e.target.value })}
              />
            </Field>
            <button
              type="button"
              className={buttonClass}
              disabled={saving}
              onClick={() => save({ quiet_enabled: s.quiet_enabled, quiet_start: s.quiet_start, quiet_end: s.quiet_end })}
            >
              Save Changes
            </button>
          </div>
        </div>
      </Can>
      <Can permission="settings.chat_status" level="edit">
        <div className="space-y-1 border-t border-slate-100 pt-3">
          <h2 className="text-base font-semibold">Chat Status</h2>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.hide_status}
              onChange={(e) => {
                setS({ ...s, hide_status: e.target.checked })
                void save({ hide_status: e.target.checked })
              }}
            />
            Hide my online / away status from others
          </label>
          <p className="text-slate-500">Takes effect the next time Chat is opened.</p>
        </div>
      </Can>
    </section>
  )
}
