// @permission-scope settings.quiet_hours, settings.chat_status, settings.chat_swipe
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, narrowInputClass } from '../form'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { SWIPE_ACTIONS, type SwipeAction } from '../../lib/chat'

type S = { hide_status: boolean; quiet_enabled: boolean; quiet_start: string; quiet_end: string; swipe_left: SwipeAction; swipe_right: SwipeAction }
const DEFAULTS: S = { hide_status: false, quiet_enabled: false, quiet_start: '21:00', quiet_end: '07:00', swipe_left: 'archive', swipe_right: 'delete' }

/**
 * My settings: quiet hours (no phone notifications) and hiding my online
 * status in chat. `part` shows only one of them (quiet hours live on the
 * Notifications page, chat status on Settings).
 */
export default function ChatSettings({
  part,
  className = 'space-y-4 rounded-lg border border-slate-200 bg-white p-4 text-sm',
}: {
  part?: 'quiet' | 'status' | 'swipe'
  className?: string
}) {
  const [s, setS] = useState<S>(DEFAULTS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase
      ?.from('chat_settings')
      .select('hide_status, quiet_enabled, quiet_start, quiet_end, swipe_left, swipe_right')
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
    <section className={className} data-setting={part === 'quiet' ? 'quiet-hours' : part === 'status' ? 'chat-status' : part === 'swipe' ? 'chat-swipe' : undefined}>
      {part === 'swipe' && (
        <Can permission="settings.chat_swipe" level="edit">
          <div className="space-y-2">
            <h2 className="text-base font-semibold">Chat Swipe Actions</h2>
            <p className="text-slate-600">On a phone, swipe a conversation in the list to do this. On a computer the same actions appear when you point at a conversation.</p>
            {(
              [
                ['swipe_left', 'Swipe left', 'sw-left'],
                ['swipe_right', 'Swipe right', 'sw-right'],
              ] as const
            ).map(([key, label, idAttr]) => (
              <Field key={key} label={label} htmlFor={idAttr}>
                <select
                  id={idAttr}
                  className={`${narrowInputClass} w-56`}
                  value={s[key]}
                  onChange={(e) => {
                    const v = e.target.value as SwipeAction
                    setS({ ...s, [key]: v })
                    void save({ [key]: v })
                  }}
                >
                  {SWIPE_ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        </Can>
      )}
      {part !== 'status' && part !== 'swipe' && (
        <Can permission="settings.quiet_hours" level="edit">
          <div className="space-y-2">
            <h2 className="text-base font-semibold">Quiet Hours</h2>
            <p className="text-slate-600">
              No phone push or desktop notifications during these hours (Halifax time). Everything still appears in the bell. Urgent notices are always sent.
            </p>
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
      )}
      {part !== 'quiet' && part !== 'swipe' && (
        <Can permission="settings.chat_status" level="edit">
          <div className={`space-y-1 ${part ? '' : 'border-t border-slate-100 pt-3'}`}>
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
      )}
    </section>
  )
}
