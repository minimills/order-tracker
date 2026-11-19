import { callFunction } from './edgeFunction'

// Which address the signed-in person's emails go out from (see the
// send-email Edge Function, action sender_info, and Settings → Email).
export type SenderInfo = { via: 'own' | 'office'; name: string; address: string; reply_to: string | null; saves_sent: boolean; ready: boolean }

let cached: Promise<SenderInfo | null> | null = null

/** Loaded once per visit (forgetSender() after the mailbox settings change). */
export function loadSender() {
  cached ??= callFunction<SenderInfo>('send-email', { action: 'sender_info' }).then((r) => (r.ok ? r.data : null))
  return cached
}

export function forgetSender() {
  cached = null
}

export type Mailbox = {
  from_address: string
  from_name: string | null
  smtp_host: string
  smtp_port: number
  smtp_security: 'ssl' | 'starttls'
  smtp_username: string
  has_password: boolean
  save_sent: boolean
  imap_host: string | null
  imap_port: number
  status: 'untested' | 'ok' | 'error'
  last_tested_at: string | null
  last_error: string | null
}
