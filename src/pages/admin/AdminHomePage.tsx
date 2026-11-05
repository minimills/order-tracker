// @permission-scope admin.users, admin.departments, admin.machine_types, admin.dropdowns, admin.stages, admin.records, admin.serials, admin.board, admin.alerts, admin.company, admin.import, admin.archive, admin.activity
import { Link } from 'react-router-dom'
import Can from '../../components/Can'

const sections = [
  { to: '/admin/users', permission: 'admin.users', icon: '👤', title: 'Users', text: 'Who can sign in, their departments, and what each person can see and do.' },
  { to: '/admin/departments', permission: 'admin.departments', icon: '🏭', title: 'Departments', text: 'Office, Fabrication Shop, Shipping… Add, rename, reorder.' },
  { to: '/admin/machine-types', permission: 'admin.machine_types', icon: '⚙️', title: 'Machine types', text: 'Names, codes and next serial numbers.' },
  { to: '/admin/dropdowns', permission: 'admin.dropdowns', icon: '📝', title: 'Dropdown lists', text: 'Voltage, delivery equipment, freight and payment types.' },
  { to: '/admin/stages', permission: 'admin.stages', icon: '🏷', title: 'Stage names', text: 'Rename what people see for each stage, e.g. “Ready / testing”.' },
  { to: '/admin/records', permission: 'admin.records', icon: '🗂', title: 'Orders, customers & machines', text: 'Edit any field, or archive.' },
  { to: '/admin/serials', permission: 'admin.serials', icon: '🔢', title: 'Serial numbers', text: 'Fix one serial by hand, or re-sequence a machine type.' },
  { to: '/admin/board', permission: 'admin.board', icon: '📋', title: 'Shop queue', text: 'Put an order at a set place in the queue, or tidy the whole queue.' },
  { to: '/admin/alerts', permission: 'admin.alerts', icon: '🔔', title: 'Alert settings', text: 'How many days ahead to warn.' },
  { to: '/admin/company', permission: 'admin.company', icon: '🏢', title: 'Company details', text: 'Name, address and logo for printouts.' },
  { to: '/admin/import', permission: 'admin.import', icon: '📥', title: 'Import & backup', text: 'Bring in orders from a spreadsheet, or download everything.' },
  { to: '/admin/archive', permission: 'admin.archive', icon: '🗄', title: 'Archive', text: 'Bring back archived records, or delete them for good.' },
  { to: '/admin/activity', permission: 'admin.activity', icon: '🕘', title: 'Activity', text: 'Every change: who, what and when.' },
]

export default function AdminHomePage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <p className="mt-1 text-sm text-slate-600">Every change here is recorded in Activity.</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((s) => (
          <Can key={s.to} permission={s.permission} level={s.permission === 'admin.activity' ? 'view' : 'edit'}>
          <Link to={s.to} className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400 hover:shadow-sm">
            <div className="font-medium">
              <span className="mr-2" aria-hidden="true">
                {s.icon}
              </span>
              {s.title}
            </div>
            <div className="mt-1 text-sm text-slate-600">{s.text}</div>
          </Link>
          </Can>
        ))}
      </div>
    </div>
  )
}
