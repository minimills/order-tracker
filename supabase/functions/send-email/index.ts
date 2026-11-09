// Supabase Edge Function "send-email": sends notification emails through our
// cPanel mailbox (SMTP, port 465, SSL), saves a copy in the mailbox's Sent
// folder (IMAP, port 993), and sends phone push notifications.
//
// Secrets (Supabase → Edge Functions → Secrets), never in the app or the repo:
//   SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM_NAME   (required)
//   SMTP_PORT (default 465), IMAP_HOST (default SMTP_HOST), SMTP_SAVE_SENT ("false" to skip the Sent copy)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY                    (phone push)
//   APP_URL (default https://order.minimills.net)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Actions (POST JSON { action, … }):
//   dispatch    – send everything due (called every minute by the database scheduler with
//                 the x-dispatch-key header, or by an admin from Admin → Email)
//   status      – which settings are filled in; { check: true } also tests the mailbox login
//   test        – send a test email ({ to })                                  (admin.email)
//   resend      – send an email from the log again ({ id })                   (admin.email_log)
//   push_key    – the public key phones need to subscribe                     (anyone signed in)
//   test_push   – send a test push to my own devices                          (settings.push)
//   certificate_preview – who a signed commissioning certificate or service report goes to, and the email
//                 ({ certificate_id })                                     (service.certificate.email)
//   certificate_send    – email it with the PDF made by the app attached
//                 ({ certificate_id, pdf_base64, file_name })              (service.certificate.email)
//
// Channels: CHANNEL_SENDERS below has one sender per channel ("email", "push").
// A later SMS channel = a row in notification_channels + one more sender here.
//
// "Verify JWT" must be OFF for this function: the scheduler has no login, so
// the function checks every caller itself (dispatch key or the person's login).
import { createClient } from 'npm:@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer@6.9.16'
import MailComposer from 'npm:nodemailer@6.9.16/lib/mail-composer/index.js'
import { ImapFlow } from 'npm:imapflow@1.0.171'
import webpush from 'npm:web-push@3.6.7'

type Json = Record<string, unknown>
// deno-lint-ignore no-explicit-any
type Any = any
type Env = (key: string) => string | undefined
export type Mail = { from: string; to: string; subject: string; html: string; text: string; attachments?: Json[] }
export type Deps = {
  env: Env
  makeClient: (url: string, key: string, options?: Json) => Any
  /** Sends the message; returns the raw message (for the Sent copy). */
  sendMail: (mail: Mail) => Promise<{ raw: Uint8Array | string }>
  /** Saves the raw message in the mailbox's Sent folder. */
  saveSent: (raw: Uint8Array | string) => Promise<void>
  /** Checks the mailbox login. */
  verifyMail: () => Promise<void>
  /** Sends one push message; throws { statusCode } on failure. */
  sendPush: (sub: { endpoint: string; p256dh: string; auth: string }, payload: string) => Promise<void>
  now?: () => Date
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MAX_ATTEMPTS = 5
const LOGO_CID = 'logo@order-tracker'

// ---------------------------------------------------------------------------
// The email layout: letterhead, heading, the updates, a button, footer.
// ---------------------------------------------------------------------------
type Company = { name?: string; address?: string; phone?: string; email?: string; website?: string; logo?: string; office_email?: string }
type Note = { id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string }

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const halifax = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

export function buttonLabel(link: string | null) {
  if (!link) return 'Open the Order Tracker'
  if (link.includes('card=')) return 'Open the Card'
  if (link.startsWith('/boards/')) return 'Open the Board'
  if (link.startsWith('/orders/')) return 'Open the Order'
  return 'Open the Order Tracker'
}

export function layout(o: { company: Company; appUrl: string; heading: string; intro?: string; notes: Note[]; link: string | null; footerNote: string; button?: boolean }) {
  const button = o.button ?? true
  const c = o.company
  const name = c.name || 'Belfast Mini Mills'
  const url = o.link ? `${o.appUrl}/#${o.link}` : o.appUrl
  const logo = c.logo?.startsWith('data:image/') ? `<img src="cid:${LOGO_CID}" alt="${esc(name)}" style="max-height:56px;display:block;margin-bottom:8px" />` : ''
  const contact = [c.address, c.phone, c.email, c.website].filter(Boolean).map(esc).join(' · ')
  const items = o.notes
    .map(
      (n) => `<tr><td style="padding:10px 0;border-top:1px solid #e2e8f0">
        <div style="font-weight:600;color:#0f172a">${esc(n.title)}</div>
        ${n.body ? `<div style="color:#334155;margin-top:2px">${esc(n.body)}</div>` : ''}
        <div style="color:#64748b;font-size:12px;margin-top:2px">${esc(halifax(n.created_at))}</div>
      </td></tr>`,
    )
    .join('')
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px">
    <tr><td style="padding:20px 24px;border-bottom:4px solid #0f172a">${logo}<div style="font-size:18px;font-weight:700;color:#0f172a">${esc(name)}</div>
      ${contact ? `<div style="color:#64748b;font-size:12px;margin-top:2px">${contact}</div>` : ''}</td></tr>
    <tr><td style="padding:20px 24px">
      <h1 style="font-size:18px;margin:0 0 8px;color:#0f172a">${esc(o.heading)}</h1>
      ${o.intro ? `<p style="margin:0 0 8px;color:#334155">${esc(o.intro)}</p>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
      ${button ? '' : '<!--'}<p style="margin:20px 0 4px"><a href="${esc(url)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${esc(buttonLabel(o.link))}</a></p>${button ? '' : '-->'}
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px">${esc(o.footerNote)}</td></tr>
  </table></td></tr></table></body></html>`
  const text = [
    name,
    contact.replace(/&amp;/g, '&'),
    '',
    o.heading,
    o.intro ?? '',
    '',
    ...o.notes.flatMap((n) => [`- ${n.title}${n.body ? `: ${n.body}` : ''} (${halifax(n.created_at)})`]),
    '',
    button ? `${buttonLabel(o.link)}: ${url}` : '',
    '',
    o.footerNote,
  ].join('\n')
  return { html, text }
}

const FOOTER = 'You receive this email because of your notification settings in the Order Tracker (Settings → Notifications).'

function logoAttachment(company: Company) {
  const m = company.logo?.match(/^data:(image\/[a-z+]+);base64,(.+)$/)
  return m ? [{ filename: 'logo.png', content: m[2], encoding: 'base64', contentType: m[1], cid: LOGO_CID }] : []
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const { env, makeClient } = deps
  const now = deps.now ?? (() => new Date())
  const url = env('SUPABASE_URL')
  const anonKey = env('SUPABASE_ANON_KEY')
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return reply(500, { error: 'The function is missing its Supabase settings.' })
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const db = makeClient(url, serviceKey, noSession)
  const appUrl = (env('APP_URL') || 'https://order.minimills.net').replace(/\/+$/, '')

  let body: Json = {}
  try {
    body = await req.json()
  } catch {
    return reply(400, { error: 'Bad request.' })
  }
  const action = String(body.action ?? '')

  // Who is calling: the database scheduler (dispatch key) or a signed-in person.
  const dispatchKey = req.headers.get('x-dispatch-key')
  let scheduler = false
  if (dispatchKey) {
    const { data } = await db.rpc('check_dispatch_key', { p_key: dispatchKey })
    scheduler = data === true
    if (!scheduler) return reply(401, { error: 'Unknown dispatch key.' })
  }
  const authHeader = req.headers.get('Authorization') ?? ''
  let caller: Any = null
  let callerEmail: string | null = null
  if (!scheduler) {
    if (!authHeader.startsWith('Bearer ')) return reply(401, { error: 'Please sign in again.' })
    caller = makeClient(url, anonKey, { ...noSession, global: { headers: { Authorization: authHeader } } })
    const { data: who, error } = await caller.auth.getUser(authHeader.slice(7))
    if (error || !who?.user?.email) return reply(401, { error: 'Please sign in again.' })
    callerEmail = String(who.user.email).toLowerCase()
  }
  const callerCan = async (fn: string, args: Json) => {
    if (!caller) return false
    const { data } = await caller.rpc(fn, args)
    return data === true
  }

  // Mail settings (secrets)
  const smtpUser = env('SMTP_USER') ?? ''
  const fromName = env('SMTP_FROM_NAME') || 'Belfast Mini Mills'
  const from = `"${fromName.replace(/"/g, '')}" <${smtpUser}>`
  const mailReady = Boolean(env('SMTP_HOST') && smtpUser && env('SMTP_PASSWORD'))
  const pushReady = Boolean(env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY'))
  const saveCopy = (env('SMTP_SAVE_SENT') ?? 'true').toLowerCase() !== 'false'

  const loadCompany = async (): Promise<Company> => {
    const { data } = await db.from('app_settings').select('value').eq('key', 'company').maybeSingle()
    return (data?.value as Company) ?? {}
  }
  const loadEmailSettings = async () => {
    const { data } = await db.from('app_settings').select('value').eq('key', 'email').maybeSingle()
    return { digest_hour: 7, ...((data?.value as Json) ?? {}) } as { digest_hour: number }
  }

  /** Sends one email, saves the Sent copy, writes the email log. */
  const deliver = async (o: { to: string; subject: string; html: string; text: string; kind: string; notificationIds?: string[]; resendOf?: string; company: Company; attachments?: Json[] }) => {
    let status: 'sent' | 'failed' = 'sent'
    let error: string | null = null
    let saved: boolean | null = null
    try {
      if (!mailReady) throw new Error('The mailbox settings (SMTP_HOST, SMTP_USER, SMTP_PASSWORD) are not set in Supabase.')
      const { raw } = await deps.sendMail({ from, to: o.to, subject: o.subject, html: o.html, text: o.text, attachments: [...logoAttachment(o.company), ...(o.attachments ?? [])] })
      if (saveCopy) {
        try {
          await deps.saveSent(raw)
          saved = true
        } catch {
          saved = false // the email went out; only the Sent copy failed
        }
      }
    } catch (e) {
      status = 'failed'
      error = (e as Error).message ?? String(e)
    }
    const { data: log } = await db
      .from('email_log')
      .insert({
        to_email: o.to, subject: o.subject, html: o.html, body_text: o.text, kind: o.kind, status, error,
        saved_to_sent: saved, notification_ids: o.notificationIds ?? [], resend_of: o.resendOf ?? null,
        created_by: callerEmail ?? 'automatic',
      })
      .select('id')
      .single()
    return { status, error, saved, logId: (log?.id as string) ?? null }
  }

  const markDeliveries = async (ids: string[], ok: boolean, error: string | null, logId: string | null, attempts: number) => {
    if (!ids.length) return
    if (ok) {
      await db.from('notification_deliveries').update({ status: 'sent', sent_at: now().toISOString(), email_log_id: logId, last_error: null }).in('id', ids)
    } else {
      const giveUp = attempts + 1 >= MAX_ATTEMPTS
      await db
        .from('notification_deliveries')
        .update({
          status: giveUp ? 'failed' : 'pending',
          attempts: attempts + 1,
          last_error: error,
          not_before: new Date(now().getTime() + (attempts + 1) * 5 * 60_000).toISOString(),
        })
        .in('id', ids)
    }
  }

  type Row = { id: string; user_email: string; group_key: string; attempts: number; notifications: Note | null }
  const pending = async (channel: string, mode: string, filters: (q: Any) => Any, limit = 500): Promise<Row[]> => {
    const q = db
      .from('notification_deliveries')
      .select('id, user_email, group_key, attempts, notifications(id, kind, title, body, link, created_at)')
      .eq('channel', channel)
      .eq('mode', mode)
      .eq('status', 'pending')
    const { data } = await filters(q).order('created_at').limit(limit)
    return ((data ?? []) as Row[]).filter((r) => r.notifications)
  }

  // ---------- Channel senders ----------
  const CHANNEL_SENDERS: Record<string, () => Promise<Json>> = {
    /** Instant emails, grouped per person + card; daily digests at the set hour. */
    email: async () => {
      const company = await loadCompany()
      let sent = 0
      let failed = 0
      // Groups with something due now; each group's other waiting updates go in the same email.
      const due = await pending('email', 'instant', (q) => q.lte('not_before', now().toISOString()), 200)
      const groups = [...new Set(due.map((d) => d.group_key))].slice(0, 50)
      for (const g of groups) {
        const rows = await pending('email', 'instant', (q) => q.eq('group_key', g), 50)
        if (!rows.length) continue
        const notes = rows.map((r) => r.notifications!) as Note[]
        const latest = notes[notes.length - 1]
        const subject = notes.length === 1 ? latest.title : `${notes.length} updates: ${latest.body ?? latest.title}`
        const { html, text } = layout({
          company, appUrl, heading: notes.length === 1 ? latest.title : `${notes.length} updates`,
          intro: notes.length > 1 ? 'Here is everything that changed in the last few minutes.' : undefined,
          notes, link: latest.link, footerNote: FOOTER,
        })
        const r = await deliver({ to: rows[0].user_email, subject, html, text, kind: 'notification', notificationIds: notes.map((n) => n.id), company })
        await markDeliveries(rows.map((x) => x.id), r.status === 'sent', r.error, r.logId, Math.max(...rows.map((x) => x.attempts)))
        if (r.status === 'sent') sent++
        else failed++
      }
      // Daily digest
      const settings = await loadEmailSettings()
      const hour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', hour: 'numeric', hourCycle: 'h23' }).format(now()))
      let digests = 0
      if (hour >= Number(settings.digest_hour ?? 7)) {
        // Midnight today in Halifax (follows daylight saving time).
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now())
        const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Halifax', timeZoneName: 'longOffset' })
          .formatToParts(now())
          .find((p) => p.type === 'timeZoneName')!
          .value.replace('GMT', '') || '+00:00'
        const todayStart = new Date(`${day}T00:00:00${offset}`)
        const rows = await pending('email', 'digest', (q) => q, 2000)
        const people = [...new Set(rows.map((r) => r.user_email))]
        for (const person of people) {
          const { count } = await db
            .from('email_log')
            .select('id', { count: 'exact', head: true })
            .eq('to_email', person)
            .eq('kind', 'digest')
            .eq('status', 'sent')
            .gte('created_at', todayStart.toISOString())
          if ((count ?? 0) > 0) continue
          const mine = rows.filter((r) => r.user_email === person)
          const notes = mine.map((r) => r.notifications!) as Note[]
          const { html, text } = layout({
            company, appUrl, heading: 'Your daily summary', intro: `${notes.length} update${notes.length === 1 ? '' : 's'} since your last summary.`,
            notes, link: '/boards', footerNote: FOOTER,
          })
          const r = await deliver({ to: person, subject: `Daily summary: ${notes.length} update${notes.length === 1 ? '' : 's'}`, html, text, kind: 'digest', notificationIds: notes.map((n) => n.id), company })
          await markDeliveries(mine.map((x) => x.id), r.status === 'sent', r.error, r.logId, Math.max(...mine.map((x) => x.attempts)))
          if (r.status === 'sent') digests++
          else failed++
        }
      }
      return { sent, digests, failed }
    },

    /** Phone push: every device of the person; devices that are gone are removed. */
    push: async () => {
      if (!pushReady) return { skipped: 'push keys not set' }
      const rows = await pending('push', 'instant', (q) => q.lte('not_before', now().toISOString()), 200)
      let sent = 0
      for (const r of rows) {
        const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_email', r.user_email)
        if (!subs?.length) {
          await db.from('notification_deliveries').update({ status: 'skipped', last_error: 'No phone or browser has push turned on.' }).eq('id', r.id)
          continue
        }
        const n = r.notifications!
        const payload = JSON.stringify({ title: n.title, body: n.body ?? '', url: n.link ? `/#${n.link}` : '/', tag: r.group_key })
        let ok = 0
        let lastError: string | null = null
        for (const s of subs) {
          try {
            await deps.sendPush(s, payload)
            ok++
            await db.from('push_subscriptions').update({ last_used_at: now().toISOString(), failed_count: 0 }).eq('id', s.id)
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode
            lastError = (e as Error).message ?? String(e)
            if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id)
          }
        }
        await markDeliveries([r.id], ok > 0, lastError, null, r.attempts)
        if (ok) sent++
      }
      return { sent }
    },
  }

  // ---------- Actions ----------
  switch (action) {
    case 'dispatch': {
      if (!scheduler && !(await callerCan('can_admin', { p_area: 'email' }))) return reply(403, { error: 'Only admins can do this.' })
      const out: Json = {}
      const { data: channels } = await db.from('notification_channels').select('channel').eq('enabled', true)
      for (const { channel } of (channels ?? []) as { channel: string }[]) {
        if (channel === 'app') continue
        const sender = CHANNEL_SENDERS[channel]
        out[channel] = sender ? await sender() : { skipped: 'no sender for this channel yet' }
      }
      return reply(200, { ok: true, ...out })
    }
    case 'status': {
      if (!(await callerCan('can_admin', { p_area: 'email' }))) return reply(403, { error: 'Only admins can do this.' })
      let mailbox: string | null = null
      if (body.check && mailReady) {
        try {
          await deps.verifyMail()
          mailbox = 'ok'
        } catch (e) {
          mailbox = (e as Error).message ?? String(e)
        }
      }
      return reply(200, {
        ok: true,
        smtp_host: Boolean(env('SMTP_HOST')), smtp_user: Boolean(smtpUser), smtp_password: Boolean(env('SMTP_PASSWORD')),
        from_name: Boolean(env('SMTP_FROM_NAME')), save_sent: saveCopy, push: pushReady, app_url: appUrl, mailbox,
      })
    }
    case 'test': {
      if (!(await callerCan('can_admin', { p_area: 'email' }))) return reply(403, { error: 'Only admins can send test emails.' })
      const to = String(body.to ?? callerEmail ?? '').trim().toLowerCase()
      if (!EMAIL.test(to)) return reply(400, { error: 'Enter a full email address.' })
      const company = await loadCompany()
      const { html, text } = layout({
        company, appUrl, heading: 'Test email', intro: 'This is a test email from the Order Tracker. Email sending is set up correctly.',
        notes: [{ id: 'test', kind: 'test', title: 'Everything is working', body: `Sent through ${env('SMTP_HOST') ?? 'the mailbox'} as ${smtpUser}.`, link: null, created_at: now().toISOString() }],
        link: '/dashboard', footerNote: 'Sent from Admin → Email in the Order Tracker.',
      })
      const r = await deliver({ to, subject: 'Test email from the Order Tracker', html, text, kind: 'test', company })
      return r.status === 'sent'
        ? reply(200, { ok: true, message: `Test email sent to ${to}.${r.saved === false ? ' The copy could not be saved in the Sent folder.' : r.saved ? ' A copy was saved in the Sent folder.' : ''}` })
        : reply(502, { error: `The test email could not be sent: ${r.error}` })
    }
    case 'resend': {
      if (!(await callerCan('can_admin', { p_area: 'email_log' }))) return reply(403, { error: 'Only admins can resend emails.' })
      const { data: old } = await db.from('email_log').select('*').eq('id', String(body.id ?? '')).maybeSingle()
      if (!old) return reply(404, { error: 'That email was not found in the log.' })
      const company = await loadCompany()
      const r = await deliver({ to: old.to_email, subject: old.subject, html: old.html ?? '', text: old.body_text ?? '', kind: 'resend', resendOf: old.id, notificationIds: old.notification_ids, company })
      return r.status === 'sent' ? reply(200, { ok: true, message: `Email sent again to ${old.to_email}.` }) : reply(502, { error: `The email could not be sent: ${r.error}` })
    }
    case 'certificate_preview':
    case 'certificate_send': {
      if (!(await callerCan('has_perm', { p_key: 'service.certificate.email', p_level: 'edit' }))) {
        return reply(403, { error: 'You do not have permission to email certificates.' })
      }
      const id = String(body.certificate_id ?? '')
      const { data: cert } = await db
        .from('service_certificates')
        .select('id, order_id, service_call_id, kind, version, status, title, tech_email, tech_name, customer_name, customer_title, locked_at, info')
        .eq('id', id)
        .maybeSingle()
      if (!cert) return reply(404, { error: 'That certificate was not found.' })
      const what = cert.kind === 'service_report' ? 'service report' : 'certificate'
      if (cert.status !== 'signed') return reply(409, { error: `The ${what} can be emailed once both the technician and the customer have signed.` })
      // An order (commissioning certificate) or a service call (service report): its customer gets it.
      const { data: order } = cert.order_id
        ? await db.from('orders').select('order_code, customers(name, emails)').eq('id', cert.order_id).maybeSingle()
        : await db.from('service_calls').select('call_number, customers(name, emails)').eq('card_id', cert.service_call_id).maybeSingle()
      const company = await loadCompany()
      const office = (company.office_email || company.email || '').trim().toLowerCase()
      const customerEmails: string[] = ((order?.customers?.emails as string[] | null) ?? []).map((e) => e.trim().toLowerCase())
      const tech = String(cert.tech_email ?? '').trim().toLowerCase()
      const to = [...new Set([tech, office, ...customerEmails].filter((e) => EMAIL.test(e)))]
      const warnings = [
        !EMAIL.test(tech) ? `No technician email: assign a technician on the ${cert.order_id ? 'order' : 'service call'}.` : '',
        !EMAIL.test(office) ? 'No office email: add it in Admin → Company Details.' : '',
        !customerEmails.some((e) => EMAIL.test(e)) ? `The customer on this ${cert.order_id ? 'order' : 'service call'} has no email address.` : '',
      ].filter(Boolean)
      const code = String(order?.order_code ?? (order?.call_number ? `S-${order.call_number}` : '') ?? cert.info?.order_number ?? '')
      const ref = cert.order_id ? `Order ${code}` : `Service call ${code}`
      const customer = String(order?.customers?.name ?? cert.info?.customer_name ?? '')
      const subject = `${cert.title} – ${ref}${customer ? ` – ${customer}` : ''}`
      const fileName = String(body.file_name || `${cert.title} - ${ref}.pdf`).replace(/[\\/:*?"<>|]+/g, '-')
      const { html, text } = layout({
        company, appUrl, heading: cert.title, button: false,
        intro: `Please find attached the signed ${String(cert.title).toLowerCase()} for ${cert.order_id ? `order ${code}` : `service call ${code}`}${customer ? ` (${customer})` : ''}.`,
        notes: [{
          id: cert.id, kind: 'certificate', title: 'Signed',
          body: `Technician: ${cert.tech_name ?? ''}. Customer: ${cert.customer_name ?? ''}${cert.customer_title ? `, ${cert.customer_title}` : ''}. Attachment: ${fileName}`,
          link: null, created_at: cert.locked_at ?? now().toISOString(),
        }],
        link: null, footerNote: `Sent by ${company.name || 'Belfast Mini Mills'}.${company.email ? ` Questions: ${company.email}` : ''}`,
      })
      if (action === 'certificate_preview') return reply(200, { ok: true, to, subject, html, text, warnings, file_name: fileName })
      if (!to.length) return reply(400, { error: 'There is no one to send it to. ' + warnings.join(' ') })
      const pdf = String(body.pdf_base64 ?? '')
      if (!pdf.startsWith('JVBER') || pdf.length > 7_000_000) return reply(400, { error: 'The PDF could not be attached. Download it to check it, then try again.' })
      const r = await deliver({
        to: to.join(', '), subject, html, text, kind: 'certificate', company,
        attachments: [{ filename: fileName, content: pdf, encoding: 'base64', contentType: 'application/pdf' }],
      })
      await db.from('certificate_sends').insert({ certificate_id: cert.id, to_emails: to, status: r.status, error: r.error, email_log_id: r.logId, sent_by: callerEmail })
      return r.status === 'sent'
        ? reply(200, { ok: true, to, message: `${what === 'certificate' ? 'Certificate' : 'Service report'} sent to ${to.join(', ')}.` })
        : reply(502, { error: `The ${what} could not be sent: ${r.error}` })
    }
    case 'push_key': {
      if (!(await callerCan('is_allowed_user', {}))) return reply(403, { error: 'Please sign in again.' })
      if (!pushReady) return reply(503, { error: 'Phone notifications are not set up yet. Ask an administrator (Admin → Email).' })
      return reply(200, { ok: true, key: env('VAPID_PUBLIC_KEY') })
    }
    case 'test_push': {
      if (!(await callerCan('has_perm', { p_key: 'settings.push', p_level: 'edit' }))) return reply(403, { error: 'You do not have permission for this action.' })
      if (!pushReady) return reply(503, { error: 'Phone notifications are not set up yet. Ask an administrator (Admin → Email).' })
      const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_email', callerEmail)
      if (!subs?.length) return reply(404, { error: 'No phone or browser has notifications turned on for your account yet.' })
      let ok = 0
      for (const s of subs) {
        try {
          await deps.sendPush(s, JSON.stringify({ title: 'Test notification', body: 'Phone notifications are working.', url: '/#/settings', tag: 'test' }))
          ok++
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode
          if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id)
        }
      }
      return ok ? reply(200, { ok: true, message: `Test notification sent to ${ok} device${ok === 1 ? '' : 's'}.` }) : reply(502, { error: 'The test notification could not be delivered. Turn notifications off and on again on this device.' })
    }
    default:
      return reply(400, { error: 'Unknown action.' })
  }
}

// ---------------------------------------------------------------------------
// Real mail, Sent folder and push (Deno on Supabase)
// ---------------------------------------------------------------------------
/** The real mail, Sent folder and push senders (also used by the tests with a local test mailbox). */
export function realSenders(env: Env): Omit<Deps, 'env' | 'makeClient' | 'now'> {
  const smtp = () =>
    nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port: Number(env('SMTP_PORT') || 465),
      secure: true,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASSWORD') },
    })
  return {
    sendMail: async (mail) => {
      const raw = await new MailComposer(mail).compile().build()
      await smtp().sendMail({ envelope: { from: env('SMTP_USER'), to: mail.to }, raw })
      return { raw }
    },
    verifyMail: async () => {
      await smtp().verify()
    },
    saveSent: async (raw) => {
      const client = new ImapFlow({
        host: env('IMAP_HOST') || env('SMTP_HOST'),
        port: Number(env('IMAP_PORT') || 993),
        secure: true,
        auth: { user: env('SMTP_USER'), pass: env('SMTP_PASSWORD') },
        logger: false,
      })
      await client.connect()
      try {
        const boxes = await client.list()
        const sent =
          boxes.find((b: Any) => b.specialUse === '\\Sent') ??
          boxes.find((b: Any) => /^(inbox[./])?sent( items| messages)?$/i.test(b.path))
        await client.append(sent?.path ?? 'INBOX.Sent', raw, ['\\Seen'])
      } finally {
        await client.logout()
      }
    },
    sendPush: async (sub, payload) => {
      webpush.setVapidDetails(`mailto:${env('SMTP_USER') || 'office@minimills.net'}`, env('VAPID_PUBLIC_KEY')!, env('VAPID_PRIVATE_KEY')!)
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 })
    },
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno
if (D?.serve) {
  const env: Env = (k) => D.env.get(k)
  D.serve((req: Request) => handle(req, { env, makeClient: createClient, ...realSenders(env) }))
}
