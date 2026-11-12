// @permission-scope notices.closures.post
import { useState } from 'react'
import { toast } from 'sonner'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { CLOSURE_KINDS, refreshClosureAlerts, toLocalInput, type ClosureAlert, type ClosureKind } from '../../lib/notices'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import { buttonClass, Field, inputClass, Modal, secondaryButtonClass } from '../form'

/**
 * Post a closure / delay alert, or an update to one. Either way everyone is
 * notified again (in the app, by phone push and by email).
 */
export default function ClosureAlertDialog({ alert, onClose, onSaved }: { alert: ClosureAlert | null; onClose: () => void; onSaved: () => void }) {
  const today = todayISO()
  const [kind, setKind] = useState<ClosureKind>(alert?.kind ?? 'closed_weather')
  const [title, setTitle] = useState(alert?.title ?? CLOSURE_KINDS[0].title)
  const [reason, setReason] = useState(alert?.reason ?? '')
  const [start, setStart] = useState(alert?.start_date ?? today)
  const [end, setEnd] = useState(alert?.end_date ?? today)
  const [next, setNext] = useState(toLocalInput(alert?.next_update_at ?? null))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!supabase) return
    if (!title.trim()) return setError('Enter a title, for example “Office closed due to weather”.')
    if (end < start) return setError('The last affected date cannot be before the first.')
    if (alert && !message.trim()) return setError('Write the update for everyone.')
    const nextAt = next ? new Date(next) : null
    if (nextAt && Number.isNaN(nextAt.getTime())) return setError('Enter the time of the next update.')
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.rpc('save_closure_alert', {
      p: { id: alert?.id ?? null, kind, title: title.trim(), reason: reason.trim(), start_date: start, end_date: end, next_update_at: nextAt?.toISOString() ?? null, message: message.trim() },
    })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success(alert ? 'Update posted. Everyone has been notified.' : 'Alert posted. Everyone has been notified.')
    void refreshClosureAlerts()
    onSaved()
  }

  return (
    <Modal
      title={alert ? 'Post an Update' : 'Post a Closure or Delay Alert'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={save} disabled={busy}>
            {busy ? 'Sending…' : alert ? 'Post Update and Notify Everyone' : 'Post Alert and Notify Everyone'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">
          Everyone receives this in the app, by phone push (even during quiet hours) and by email. It shows as a banner at the top of every page until you end it or its last date has passed.
        </p>
        <Field label="Type" htmlFor="ca-kind">
          <select
            id="ca-kind"
            className={inputClass}
            value={kind}
            onChange={(e) => {
              const k = e.target.value as ClosureKind
              const was = CLOSURE_KINDS.find((x) => x.value === kind)?.title
              setKind(k)
              if (!title.trim() || title === was) setTitle(CLOSURE_KINDS.find((x) => x.value === k)?.title ?? '')
            }}
          >
            {CLOSURE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" htmlFor="ca-title">
          <input id="ca-title" className={inputClass} maxLength={120} value={title} placeholder="For example Office closed due to weather" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Reason" htmlFor="ca-reason">
          <textarea id="ca-reason" rows={2} className={inputClass} maxLength={2000} value={reason} placeholder="For example Snow storm; roads are closed" onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First affected date" htmlFor="ca-start">
            <input id="ca-start" type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Last affected date" htmlFor="ca-end">
            <input id="ca-end" type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Next update at (optional)" htmlFor="ca-next">
          <input id="ca-next" type="datetime-local" className={inputClass} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={alert ? 'Update for everyone' : 'Message (optional)'} htmlFor="ca-message">
          <textarea
            id="ca-message"
            rows={3}
            className={inputClass}
            maxLength={2000}
            value={message}
            placeholder={alert ? 'For example The office stays closed tomorrow.' : 'Anything people should know or do'}
            onChange={(e) => setMessage(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
