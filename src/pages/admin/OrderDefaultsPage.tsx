// @permission-scope admin.order_defaults
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass } from '../../components/form'
import { friendlyError } from '../../lib/format'
import { DEFAULT_ORDER_DEFAULTS, type OrderDefaults } from '../../lib/schedule'
import { supabase } from '../../lib/supabase'
import { CURRENCIES } from '../../lib/types'
import { loadSetting } from '../../lib/useSchedule'
import { useOptionList } from '../../lib/useOptionList'

/** What a new order starts with (everything can still be changed on the form). */
export default function OrderDefaultsPage() {
  const [f, setF] = useState<OrderDefaults>(DEFAULT_ORDER_DEFAULTS)
  const [saving, setSaving] = useState(false)
  const voltage = useOptionList('voltage', f.voltage)
  useEffect(() => {
    loadSetting('order_defaults', DEFAULT_ORDER_DEFAULTS).then(setF)
  }, [])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const days = (n: number) => Number.isInteger(n) && n >= 0 && n <= 365
    if (!days(f.down_payment_days) || !days(f.balance_days_before_ship)) return toast.error('Days must be whole numbers from 0 to 365.')
    setSaving(true)
    const { error } = await supabase.from('app_settings').upsert({ key: 'order_defaults', value: f })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Order defaults saved.')
  }

  const num = (key: 'down_payment_days' | 'balance_days_before_ship') => (e: { target: { value: string } }) =>
    setF({ ...f, [key]: Number(e.target.value) })

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <AdminPageHeader title="Order Defaults">
        What a new order starts with. Everything can still be changed on the New order form. Calculated dates follow the
        weekend rule: Saturday moves back to Friday, Sunday forward to Monday.
      </AdminPageHeader>
      <form onSubmit={save} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency when the customer is in Canada" htmlFor="od-cad">
            <select id="od-cad" className={inputClass} value={f.currency_canada} onChange={(e) => setF({ ...f, currency_canada: e.target.value })}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Currency for every other country" htmlFor="od-usd">
            <select id="od-usd" className={inputClass} value={f.currency_other} onChange={(e) => setF({ ...f, currency_other: e.target.value })}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Voltage" htmlFor="od-volt">
            <select id="od-volt" className={inputClass} value={f.voltage} onChange={(e) => setF({ ...f, voltage: e.target.value })}>
              {voltage.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </Field>
          <Field label="“Crate” on each machine" htmlFor="od-crate">
            <select id="od-crate" className={inputClass} value={f.crate ? 'yes' : 'no'} onChange={(e) => setF({ ...f, crate: e.target.value === 'yes' })}>
              <option value="yes">Enabled (machines are crated)</option>
              <option value="no">Disabled</option>
            </select>
          </Field>
          <Field label="Down payment due (days after the order is created)" htmlFor="od-down">
            <input id="od-down" type="number" min={0} max={365} className={inputClass} value={f.down_payment_days} onChange={num('down_payment_days')} />
          </Field>
          <Field label="Balance due (days before the expected ship date)" htmlFor="od-bal">
            <input id="od-bal" type="number" min={0} max={365} className={inputClass} value={f.balance_days_before_ship} onChange={num('balance_days_before_ship')} />
          </Field>
        </div>
        <div className="flex justify-end">
          <button type="submit" className={buttonClass} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
