import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuth } from '../lib/auth'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

export default function LoginPage() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  if (session) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from && from !== '/login' ? from : '/dashboard'} replace />
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!supabase) return
    const address = email.trim().toLowerCase()
    setSending(true)
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      // Come back to this same site (works locally and on GitHub Pages).
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    })
    setSending(false)
    if (error) {
      toast.error(`Could not send the link: ${error.message}`)
    } else {
      setSentTo(address)
    }
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
          <div className="mt-6 space-y-3 text-sm">
            <p>
              We sent a sign-in link to <strong>{sentTo}</strong>.
            </p>
            <p className="text-slate-600">
              Open the email and click the link <strong>on this same device and browser</strong>. You can close this
              tab afterwards.
            </p>
            <button type="button" onClick={() => setSentTo(null)} className="text-slate-600 underline">
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-3">
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
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              placeholder="you@minimills.net"
            />
            <button
              type="submit"
              disabled={sending}
              className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {sending ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            <p className="text-xs text-slate-500">No password needed. We email you a link that signs you in.</p>
          </form>
        )}
      </div>
    </div>
  )
}
