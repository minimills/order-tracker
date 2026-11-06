import { supabase } from './supabase'

type Result = { ok: true; message: string; emailed?: boolean } | { ok: false; message: string }

/**
 * Calls the "admin-users" Edge Function (makes, re-sends and removes logins
 * with the Supabase admin API; sign-ups stay off). The function checks on the
 * server that the caller may manage users.
 */
export async function adminUsers(action: 'create' | 'resend' | 'remove', body: Record<string, unknown>): Promise<Result> {
  if (!supabase) return { ok: false, message: 'Not connected to the database.' }
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action, redirect_to: window.location.origin + window.location.pathname, ...body },
  })
  if (!error) return { ok: true, message: (data as { message: string }).message, emailed: (data as { emailed?: boolean }).emailed }
  // The function answers errors as { error: "plain words" }.
  const response = (error as { context?: Response }).context
  if (response && typeof response.json === 'function') {
    try {
      const j = (await response.json()) as { error?: string }
      if (j.error) return { ok: false, message: j.error }
    } catch {
      /* not JSON */
    }
  }
  if (/failed to send|fetch|not found|404/i.test(error.message))
    return { ok: false, message: 'The “admin-users” Edge Function is not set up in Supabase yet (see the setup steps), or it could not be reached.' }
  return { ok: false, message: error.message }
}
