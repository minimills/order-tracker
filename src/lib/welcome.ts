import { callFunction } from './edgeFunction'
import { fillTemplate, fillTemplateHtml, loadEmailTemplates } from './emailTemplates'
import { allowedBy, type Perms } from './permissions'
import { NAV_ITEMS } from './permissions/nav'
import { supabase } from './supabase'
import { tr } from '../i18n'

// The welcome email for a new user (template in Admin → Email Templates).

export type WelcomeUser = { email: string; name: string | null; role: 'admin' | 'staff' }
export const PORTAL_URL = 'https://order.minimills.net'

/** The pages a person can open, as lines for the welcome email. */
export function welcomeFeatures(role: 'admin' | 'staff', perms: Perms) {
  if (role === 'admin') return tr("- Everything: you are an administrator.")
  const pages = NAV_ITEMS.filter(
    (p) => p.to !== '/admin' && (!p.permission || allowedBy(perms, p.permission, p.level)) && (!p.anyOf || p.anyOf.some((k) => allowedBy(perms, k, p.level))),
  ).map((p) => `- ${p.label}`)
  return pages.length ? pages.join('\n') : tr("- Your pages are being set up. You will see them as soon as an administrator allows them.")
}

/** The welcome email for one person, from the template in Admin → Email Templates. */
export async function composeWelcome(user: WelcomeUser, perms: Perms, companyName: string) {
  const tpl = await loadEmailTemplates()
  const { data: sender } = supabase ? await supabase.rpc('current_user_name') : { data: '' }
  const values = {
    name: user.name?.trim() || user.email,
    email: user.email,
    portal_url: PORTAL_URL,
    features: welcomeFeatures(user.role, perms),
    sender_name: typeof sender === 'string' ? sender : '',
    company_name: companyName || 'Belfast Mini Mills',
  }
  return { subject: fillTemplate(tpl.welcome.subject, values), body: fillTemplateHtml(tpl.welcome.body, values) }
}

export async function sendWelcome(email: string, subject: string, body: string) {
  return callFunction<{ message?: string }>('send-email', { action: 'welcome_send', email, subject, body })
}

