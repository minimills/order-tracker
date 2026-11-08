import { supabase } from './supabase'

export type FunctionResult<T = Record<string, unknown>> = { ok: true; data: T; message: string } | { ok: false; message: string }

/**
 * Calls a Supabase Edge Function. Functions answer errors as
 * { error: "plain words" }; that sentence is passed on as the message.
 */
export async function callFunction<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<FunctionResult<T>> {
  if (!supabase) return { ok: false, message: 'The app is not connected to the database.' }
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (!error) return { ok: true, data: data as T, message: String((data as { message?: string })?.message ?? '') }
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
    return { ok: false, message: `The “${name}” Edge Function is not set up in Supabase yet (see Admin → Email), or it could not be reached.` }
  return { ok: false, message: error.message }
}
