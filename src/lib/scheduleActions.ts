import { toast } from 'sonner'
import { askText } from './confirm'
import { friendlyError } from './format'
import { acceptDeadlines, planSignature, type OrderPlan, type Promised } from './schedule'
import { supabase } from './supabase'

/** Accept the suggested dates: they become the promised ones. */
export async function acceptPlan(orderId: string, plan: OrderPlan, promised: Promised) {
  if (!supabase) return false
  const { error } = await supabase.rpc('accept_schedule', {
    p_order_id: orderId,
    p_ship_date: plan.ship_date,
    p_deadlines: acceptDeadlines(plan, promised),
    p_initial: false,
  })
  if (error) {
    toast.error(friendlyError(error))
    return false
  }
  toast.success('New dates accepted. The original promised date is kept for the delay.')
  // Why the ship date changed (kept in the order's ship date history).
  const reason = await askText('Reason for the new ship date (optional, kept in the ship date history)', { label: 'Reason', confirmLabel: 'Save Changes' })
  if (reason) await supabase.rpc('set_ship_change_reason', { p_order: orderId, p_reason: reason })
  return true
}

/** Keep the promised dates; this suggestion isn't shown again (a different one will be). */
export async function keepPlan(orderId: string, plan: OrderPlan) {
  if (!supabase) return false
  const { error } = await supabase.rpc('keep_schedule', { p_order_id: orderId, p_signature: planSignature(plan) })
  if (error) {
    toast.error(friendlyError(error))
    return false
  }
  toast.success('Promised dates kept.')
  return true
}
