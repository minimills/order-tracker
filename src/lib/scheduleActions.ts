import { toast } from 'sonner'
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
  toast.success('New dates accepted.')
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
