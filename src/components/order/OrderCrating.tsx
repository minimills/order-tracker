import { useState } from 'react'
import { toast } from 'sonner'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import Can from '../Can'
import { narrowInputClass } from '../form'
import { tr } from '../../i18n'

/**
 * "Crated: Yes / No" on the Order page (0050). No = the production board has
 * no Crating stage and the order shows no crating boxes. Turning it off when
 * crates are already recorded asks first (the crates are kept, only hidden).
 */
export default function OrderCrating({ orderId, crating, onChanged }: { orderId: string; crating: boolean; onChanged: () => void }) {
  const { can } = usePermissions()
  const [busy, setBusy] = useState(false)

  async function change(next: boolean) {
    if (!supabase) return
    if (
      !next &&
      !(await confirmAction(tr("Set this order to not crated? The Crating stage is taken off the production board and every crating box is hidden for this order."), {
        get confirmLabel() {
    return tr("Set to Not Crated")
  },
      }))
    )
      return
    setBusy(true)
    let { error } = await supabase.rpc('set_order_crating', { p_order: orderId, p_crating: next, p_confirm: false })
    if (error && (error as { hint?: string }).hint === 'crates_exist') {
      const go = await confirmAction(tr("{{message}} Continue?", { message: error.message }), { get confirmLabel() {
    return tr("Set to Not Crated")
  }, danger: true })
      if (!go) {
        setBusy(false)
        return
      }
      ;({ error } = await supabase.rpc('set_order_crating', { p_order: orderId, p_crating: next, p_confirm: true }))
    }
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(next ? tr("The order is crated: the Crating stage and crating boxes are back.") : tr("The order is not crated: crating is hidden for this order."))
    onChanged()
  }

  return (
    <Can permission="order.field.crating">
      {can('order.field.crating', 'edit') ? (
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          {tr("Crated")}
          <select aria-label={tr("Will this order be crated?")} className={`${narrowInputClass} py-1`} value={crating ? 'yes' : 'no'} disabled={busy} onChange={(e) => change(e.target.value === 'yes')}>
            <option value="yes">{tr("Yes")}</option>
            <option value="no">{tr("No")}</option>
          </select>
        </label>
      ) : (
        <span className="text-sm text-slate-600">{tr("Crated:")} {crating ? tr("Yes") : tr("No")}</span>
      )}
    </Can>
  )
}
