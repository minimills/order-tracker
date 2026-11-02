import { format } from 'date-fns'
import { useState } from 'react'
import { toast } from 'sonner'
import PlaceholderPage from '../components/PlaceholderPage'

export default function DashboardPage() {
  const [today] = useState(() => new Date())
  return (
    <div>
      <PlaceholderPage title="Dashboard" description="Today at a glance: alerts, payments due and upcoming shipments." />
      <div className="mx-auto mt-6 flex max-w-5xl flex-wrap items-center gap-4 text-sm text-slate-600">
        <span>Today is {format(today, 'EEEE, MMMM d, yyyy')}</span>
        <button
          type="button"
          onClick={() => toast.success('Pop-up messages are working.')}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-white hover:bg-slate-700"
        >
          Test a pop-up message
        </button>
      </div>
    </div>
  )
}
