import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

/** Supabase lets you ask for a new code once a minute. */
const RESEND_WAIT_SECONDS = 60

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none disabled:bg-slate-100'
const buttonClass =
  'w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60'

/** Turns a Supabase sign-in error into a sentence a person can act on. */
function friendly(error: { message?: string; code?: string; status?: number }) {
  const msg = (error.message ?? '').toLowerCase()
  if (error.code === 'otp_expired' || msg.includes('expired') || msg.includes('invalid')) {
    return 'That code is wrong or has expired. Check the latest email, or ask for a new code.'
  }
  if (error.status === 429 || msg.includes('rate limit') || msg.includes('security purposes')) {
    return 'Too many tries. Please wait a minute, then try again.'
  }
  if (msg.includes('signups not allowed') || msg.includes('not allowed for otp')) {
    return 'This email is not set up for the app yet. Ask an admin to add you.'
  }
  return error.message || 'Something went wrong. Please try again.'
}

/**
 * Sign in with a one-time code: enter your email, we email a 6-digit code,
 * type it here. No password and no link to click.
 */
export default function LoginPage() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waitSeconds, setWaitSeconds] = useState(0)
  const codeInput = useRef<HTMLInputElement>(null)

  // Count down until a new code may be requested.
  useEffect(() => {
    if (waitSeconds <= 0) return
    const timer = setTimeout(() => setWaitSeconds((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitSeconds])

  useEffect(() => {
    if (sentTo) codeInput.current?.focus()
  }, [sentTo])

  if (session) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />
  }

  async function sendCode(address: string) {
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.auth.signInWithOtp({
      email: address,
      // If the email still contains a link, it brings you back to this site.
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    })
    setBusy(false)
    if (e) {
      setError(friendly(e))
      return
    }
    setSentTo(address)
    setCode('')
    setWaitSeconds(RESEND_WAIT_SECONDS)
  }

  async function onEmail(e: FormEvent) {
    e.preventDefault()
    const address = email.trim().toLowerCase()
    if (!address) return
    await sendCode(address)
  }

  async function onCode(e: FormEvent) {
    e.preventDefault()
    if (!supabase || !sentTo) return
    const token = code.replace(/\D/g, '')
    if (token.length < 6) {
      setError('Enter the code from the email (6 digits).')
      return
    }
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.verifyOtp({ email: sentTo, token, type: 'email' })
    setBusy(false)
    // On success the session arrives and this page sends you on to the app.
    if (err) setError(friendly(err))
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-lg font-semibold">Belfast Mini Mills</div>
        <div className="text-sm text-slate-500">Order tracker</div>

        {!isSupabaseConfigured ? (
          <p className="mt-6 text-sm text-amber-800">
            Not connected to the database yet. Fill in <code>.env.local</code> (see README), then restart the app.
          </p>
        ) : loading ? (
          <p className="mt-6 text-sm text-slate-500">Loading…</p>
        ) : sentTo ? (
          <form onSubmit={onCode} className="mt-6 space-y-3" noValidate>
            <p className="text-sm">
              We emailed a sign-in code to <strong>{sentTo}</strong>.
            </p>
            <label className="block text-sm font-medium" htmlFor="code">
              Code from the email
            </label>
            <input
              ref={codeInput}
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ''))}
              className={`${inputClass} text-center font-mono text-2xl tracking-[0.4em]`}
              placeholder="123456"
              disabled={busy}
            />
            {error && <p className="text-sm text-red-700">{error}</p>}
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <button
                type="button"
                className="text-slate-600 underline disabled:text-slate-400 disabled:no-underline"
                disabled={busy || waitSeconds > 0}
                onClick={() => sendCode(sentTo)}
              >
                {waitSeconds > 0 ? `Send a new code in ${waitSeconds}s` : 'Send a new code'}
              </button>
              <button
                type="button"
                className="text-slate-600 underline"
                onClick={() => {
                  setSentTo(null)
                  setError(null)
                }}
              >
                Use a different email
              </button>
            </div>
            <p className="text-xs text-slate-500">
              The code works once and expires after a while. Check your spam folder if it doesn’t arrive.
            </p>
          </form>
        ) : (
          <form onSubmit={onEmail} className="mt-6 space-y-3">
            <label className="block text-sm font-medium" htmlFor="email">
              Your email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="you@minimills.net"
            />
            {error && <p className="text-sm text-red-700">{error}</p>}
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? 'Sending…' : 'Email me a sign-in code'}
            </button>
            <p className="text-xs text-slate-500">No password needed. We email you a 6-digit code to type in here.</p>
          </form>
        )}
      </div>
    </div>
  )
}
