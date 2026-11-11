// @permission-scope admin.alerts
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { buttonClass, Field } from '../components/form'
import { DEFAULT_THRESHOLDS, useAlerts, type AlertThresholds } from '../lib/alerts'
import { usePermissions } from '../lib/permissions'
import { friendlyError } from '../lib/format'
import { supabase } from '../lib/supabase'

type Draft = Record<keyof AlertThresholds, string>

const toDraft = (t: AlertThresholds): Draft => ({
  payment_warn_days: String(t.payment_warn_days),
  payment_urgent_days: String(t.payment_urgent_days),
  ship_warn_days: String(t.ship_warn_days),
})

/** Settings > Alerts: how many days ahead to warn. Admins can change it. */
export default function AlertSettingsPage() {
  // Full admins, or people given this admin page.
  const isAdmin = usePermissions().can('admin.alerts', 'edit')
  const { refresh } = useAlerts()
  const [draft, setDraft] = useState<Draft>(toDraft(DEFAULT_THRESHOLDS))
  const [errors, setErrors] = useState<Partial<Draft>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'alerts')
      .maybeSingle()
      .then(({ data }) => {
        setDraft(toDraft({ ...DEFAULT_THRESHOLDS, ...((data?.value as Partial<AlertThresholds>) ?? {}) }))
        setLoading(false)
      })
  }, [])

  function check(d: Draft) {
    const e: Partial<Draft> = {}
    for (const key of Object.keys(d) as (keyof Draft)[]) {
      const n = Number(d[key])
      if (!/^\d+$/.test(d[key].trim()) || n > 365) e[key] = 'Enter a whole number from 0 to 365.'
    }
    if (!e.payment_urgent_days && !e.payment_warn_days && Number(d.payment_urgent_days) > Number(d.payment_warn_days))
      e.payment_urgent_days = 'This should not be more than the first warning.'
    return e
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    const e = check(draft)
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    const value: AlertThresholds = {
      payment_warn_days: Number(draft.payment_warn_days),
      payment_urgent_days: Number(draft.payment_urgent_days),
      ship_warn_days: Number(draft.ship_warn_days),
    }
    const { error } = await supabase.from('app_settings').upsert({ key: 'alerts', value })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Alert settings saved.')
    refresh()
  }

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: e.target.value })
  const days = (key: keyof Draft) => (
    <div className="flex items-center gap-2">
      <input
        id={key}
        inputMode="numeric"
        className="w-24 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none disabled:bg-slate-100"
        value={draft[key]}
        onChange={set(key)}
        disabled={!isAdmin || loading}
      />
      <span className="text-sm text-slate-600">days</span>
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-slate-600 underline">
          ← Admin
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Alerts</h1>
        <p className="mt-1 text-sm text-slate-600">
          How far ahead the bell warns you. Overdue payments, payments due today, passed ship dates and unknown voltage
          on confirmed orders are always shown.
          {!isAdmin && ' Only admins can change these.'}
        </p>
      </div>

      <form onSubmit={save} className="max-w-3xl space-y-5 rounded-lg border border-slate-200 bg-white p-5" noValidate>
        <Field
          label="Warn about a payment when it is due within"
          htmlFor="payment_warn_days"
          error={errors.payment_warn_days}
          hint="First warning (yellow). Default 7."
        >
          {days('payment_warn_days')}
        </Field>
        <Field
          label="Warn again when it is due within"
          htmlFor="payment_urgent_days"
          error={errors.payment_urgent_days}
          hint="Second warning (yellow). Default 3. A payment due today or overdue is red."
        >
          {days('payment_urgent_days')}
        </Field>
        <Field
          label="Warn about an expected ship date within"
          htmlFor="ship_warn_days"
          error={errors.ship_warn_days}
          hint="Default 14. A ship date that has passed without being marked shipped is red."
        >
          {days('ship_warn_days')}
        </Field>
        {isAdmin && (
          <div className="flex justify-end">
            <button type="submit" className={buttonClass} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        )}
      </form>

      <p className="text-sm text-slate-600">
        Snoozing or dismissing an alert only affects you; other people still see it. The app checks for new alerts every
        10 minutes while it is open.
      </p>
    </div>
  )
}
