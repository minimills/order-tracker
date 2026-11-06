// Supabase Edge Function "admin-users": Admin → Users makes, re-sends and
// removes real login accounts. Sign-ups stay OFF in Supabase; only this
// function (with the service role key, which Supabase provides to every Edge
// Function automatically) creates logins.
//
// Actions (POST JSON):
//   { action: "create", email, name?, role?, departments?, start_page?, perms?, perms_source?, redirect_to? }
//   { action: "resend", email, redirect_to? }
//   { action: "remove", email }
//
// Who may call it: signed-in people allowed to use Admin → Users (checked here
// with the caller's own login, and again by the database functions, which run
// as the caller). The service key is used ONLY for the login account itself.
import { createClient } from 'npm:@supabase/supabase-js@2'

type Json = Record<string, unknown>
type Env = (key: string) => string | undefined
// deno-lint-ignore no-explicit-any
type Client = any
type Deps = { env: Env; makeClient: (url: string, key: string, options?: Json) => Client }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const FOREVER = '876000h' // ~100 years: the login stays blocked

export async function handle(req: Request, { env, makeClient }: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const url = env('SUPABASE_URL')
  const anonKey = env('SUPABASE_ANON_KEY')
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return reply(500, { error: 'The function is missing its Supabase settings.' })

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return reply(401, { error: 'Please sign in again.' })
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  // The admin who clicked: everything in our own tables is done as them.
  const caller = makeClient(url, anonKey, { ...noSession, global: { headers: { Authorization: authHeader } } })
  // Login accounts (Supabase Auth admin API): service role, never sent to the browser.
  const service = makeClient(url, serviceKey, noSession)
  // Sends the 6-digit code email (never creates an account).
  const mailer = makeClient(url, anonKey, noSession)

  const { data: who, error: whoError } = await caller.auth.getUser(authHeader.slice(7))
  if (whoError || !who?.user) return reply(401, { error: 'Please sign in again.' })
  const { data: allowed, error: permError } = await caller.rpc('can_admin', { p_area: 'users' })
  if (permError || allowed !== true) return reply(403, { error: 'Only admins can manage users (Admin → Users).' })

  let body: Json
  try {
    body = await req.json()
  } catch {
    return reply(400, { error: 'Bad request.' })
  }
  const email = String(body.email ?? '').trim().toLowerCase()
  if (!EMAIL.test(email)) return reply(400, { error: 'Enter a full email address, e.g. name@minimills.net' })
  const redirectTo = typeof body.redirect_to === 'string' && /^https?:\/\//.test(body.redirect_to) ? body.redirect_to : undefined

  const onList = async () => {
    const { data } = await caller.from('allowed_users').select('email').eq('email', email).maybeSingle()
    return Boolean(data)
  }
  const loginId = async (): Promise<string | null> => {
    const { data } = await service.rpc('admin_auth_user_id', { p_email: email })
    return (data as string | null) ?? null
  }
  /** Makes sure a working login exists (made, or found and un-blocked). */
  const ensureLogin = async (): Promise<{ id: string; made: boolean } | { error: string }> => {
    const made = await service.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name: body.name ?? null } })
    if (!made.error && made.data?.user) return { id: made.data.user.id, made: true }
    const exists = made.error?.code === 'email_exists' || /already (been )?registered|already exists/i.test(made.error?.message ?? '')
    if (!exists) return { error: `The login could not be made: ${made.error?.message ?? 'unknown error'}` }
    const id = await loginId()
    if (!id) return { error: 'This email already has a login, but it could not be found. Try again.' }
    const { error } = await service.auth.admin.updateUserById(id, { ban_duration: 'none', email_confirm: true })
    if (error) return { error: `The login could not be turned back on: ${error.message}` }
    return { id, made: false }
  }
  const sendCode = async (): Promise<string | null> => {
    const { error } = await mailer.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } })
    if (!error) return null
    if (error.status === 429 || /rate limit|security purposes/i.test(error.message)) return 'Supabase only sends a few emails per hour; try “Resend login code” in a little while.'
    return error.message
  }

  switch (body.action) {
    case 'create': {
      if (await onList()) return reply(409, { error: `${email} already has access to the app.` })
      const login = await ensureLogin()
      if ('error' in login) return reply(400, { error: login.error })
      const { error } = await caller.rpc('admin_add_user', {
        p_email: email,
        p_name: body.name ?? null,
        p_role: body.role ?? 'staff',
        p_departments: Array.isArray(body.departments) ? body.departments : [],
        p_start_page: body.start_page ?? null,
        p_perms: body.perms ?? null,
        p_perms_source: body.perms_source ?? null,
      })
      if (error) {
        // All or nothing: undo a login made a moment ago.
        if (login.made) await service.auth.admin.deleteUser(login.id)
        return reply(error.code === '23505' ? 409 : 400, { error: error.message })
      }
      const mailProblem = await sendCode()
      return reply(200, {
        ok: true,
        reused: !login.made,
        message: mailProblem
          ? `${email} was added, but the login code email could not be sent: ${mailProblem}`
          : `${email} was added and a 6-digit login code was emailed to them.`,
        emailed: !mailProblem,
      })
    }
    case 'resend': {
      if (!(await onList())) return reply(404, { error: `${email} is not on the users list. Add them first.` })
      // People added before logins were made here get their login now.
      const login = await ensureLogin()
      if ('error' in login) return reply(400, { error: login.error })
      const mailProblem = await sendCode()
      if (mailProblem) return reply(502, { error: `The email could not be sent: ${mailProblem}` })
      return reply(200, { ok: true, message: `A new 6-digit login code was emailed to ${email}.` })
    }
    case 'remove': {
      const { error } = await caller.rpc('admin_remove_user', { p_email: email })
      if (error) return reply(400, { error: error.message })
      // Block the login too (kept, not deleted, so their history stays linked).
      const id = await loginId()
      if (id) {
        const { error: banError } = await service.auth.admin.updateUserById(id, { ban_duration: FOREVER })
        if (banError) return reply(200, { ok: true, message: `${email} was removed from the users list, but their login could not be blocked: ${banError.message}` })
      }
      return reply(200, { ok: true, message: `${email} can no longer sign in. Their past changes stay in the activity log.` })
    }
    default:
      return reply(400, { error: 'Unknown action.' })
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno
if (D?.serve) D.serve((req: Request) => handle(req, { env: (k) => D.env.get(k), makeClient: createClient }))
