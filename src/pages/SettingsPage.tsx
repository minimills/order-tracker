import PlaceholderPage from '../components/PlaceholderPage'
import { isSupabaseConfigured } from '../lib/supabase'

export default function SettingsPage() {
  return (
    <div>
      <PlaceholderPage title="Settings" description="Machine types, email, AI and other options." />
      <div className="mx-auto mt-6 max-w-5xl rounded-lg border border-slate-200 bg-white p-4 text-sm">
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
