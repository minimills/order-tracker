import { Link } from 'react-router-dom'

const sections = [
  { to: '/admin/users', icon: '👤', title: 'Users', text: 'Who can sign in, and whether they are admin or staff.' },
  { to: '/admin/machine-types', icon: '⚙️', title: 'Machine types', text: 'Names, codes and next serial numbers.' },
  { to: '/admin/dropdowns', icon: '📝', title: 'Dropdown lists', text: 'Voltage, delivery equipment, freight and payment types.' },
  { to: '/admin/records', icon: '🗂', title: 'Orders, customers & machines', text: 'Edit any field, or archive.' },
  { to: '/admin/serials', icon: '🔢', title: 'Serial numbers', text: 'Fix one serial by hand, or re-sequence a machine type.' },
  { to: '/admin/board', icon: '📋', title: 'Shop queue', text: 'Put an order at a set place in the queue, or tidy the whole queue.' },
  { to: '/admin/alerts', icon: '🔔', title: 'Alert settings', text: 'How many days ahead to warn.' },
  { to: '/admin/company', icon: '🏢', title: 'Company details', text: 'Name, address and logo for printouts.' },
  { to: '/admin/import', icon: '📥', title: 'Import & backup', text: 'Bring in orders from a spreadsheet, or download everything.' },
  { to: '/admin/archive', icon: '🗄', title: 'Archive', text: 'Bring back archived records, or delete them for good.' },
  { to: '/admin/activity', icon: '🕘', title: 'Activity', text: 'Every change: who, what and when.' },
]

export default function AdminHomePage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <p className="mt-1 text-sm text-slate-600">Only admins can see these pages. Every change here is recorded in Activity.</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((s) => (
          <Link key={s.to} to={s.to} className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400 hover:shadow-sm">
            <div className="font-medium">
              <span className="mr-2" aria-hidden="true">
                {s.icon}
              </span>
              {s.title}
            </div>
            <div className="mt-1 text-sm text-slate-600">{s.text}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
