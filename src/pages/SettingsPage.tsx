import { Link } from 'react-router-dom'
import { isSupabaseConfigured } from '../lib/supabase'

const sections = [
  { to: '/settings/machine-types', title: 'Machine types', text: 'Names, codes and next serial numbers.' },
]

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400 hover:shadow-sm"
          >
            <div className="font-medium">{s.title}</div>
            <div className="mt-1 text-sm text-slate-600">{s.text}</div>
          </Link>
        ))}
      </div>
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        Database connection:{' '}
        {isSupabaseConfigured ? (
          <span className="font-medium text-green-700">settings found</span>
        ) : (
          <span className="font-medium text-amber-700">not set up (.env.local missing)</span>
        )}
      </div>
    </div>
  )
}
