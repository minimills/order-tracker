// @permission-scope admin.users, admin.departments, admin.machine_types, admin.dropdowns, admin.stages, admin.order_defaults, admin.scheduling, admin.groups, admin.board_templates, admin.checklists, admin.records, admin.serials, admin.board, admin.alerts, admin.company, admin.import, admin.archive, admin.activity
import { Link } from 'react-router-dom'
import Can from '../../components/Can'
import Icon from '../../components/Icon'

const sections = [
  { to: '/admin/users', permission: 'admin.users', icon: 'user' as const, title: 'Users', text: 'Who can sign in, their departments, and what each person can see and do.' },
  { to: '/admin/departments', permission: 'admin.departments', icon: 'factory' as const, title: 'Departments', text: 'Create, rename, reorder and archive departments.' },
  { to: '/admin/machine-types', permission: 'admin.machine_types', icon: 'cog' as const, title: 'Machine Types', text: 'Names, codes and next serial numbers.' },
  { to: '/admin/dropdowns', permission: 'admin.dropdowns', icon: 'dropdown' as const, title: 'Dropdown Lists', text: 'Voltage, delivery equipment, freight and payment types.' },
  { to: '/admin/stages', permission: 'admin.stages', icon: 'tag' as const, title: 'Stage Names', text: 'Rename what people see for each stage, for example “Ready / testing”.' },
  { to: '/admin/checklists', permission: 'admin.checklists', icon: 'checklist' as const, title: 'Checklists', text: 'Final check templates: general items for every machine, plus extras per machine type.' },
  { to: '/admin/groups', permission: 'admin.groups', icon: 'users' as const, title: 'Groups', text: 'Groups of people (for example Procurement, Techs) for sharing boards and notifications.' },
  { to: '/admin/board-templates', permission: 'admin.board_templates', icon: 'template' as const, title: 'Board Templates', text: 'Stages, labels and checklists new boards can start with.' },
  { to: '/admin/order-defaults', permission: 'admin.order_defaults', icon: 'receipt' as const, title: 'Order Defaults', text: 'Currency, voltage, crate and payment due days for new orders.' },
  { to: '/admin/scheduling', permission: 'admin.scheduling', icon: 'calendar' as const, title: 'Scheduling', text: 'Working days, holidays, buffer, and how machines are built.' },
  { to: '/admin/records', permission: 'admin.records', icon: 'records' as const, title: 'Orders, Customers and Machines', text: 'Edit any field, or archive a record.' },
  { to: '/admin/serials', permission: 'admin.serials', icon: 'hash' as const, title: 'Serial Numbers', text: 'Correct a single serial number, or renumber a machine type.' },
  { to: '/admin/board', permission: 'admin.board', icon: 'queue' as const, title: 'Shop Queue', text: 'Move an order to a set place in the queue, or renumber the whole queue.' },
  { to: '/admin/alerts', permission: 'admin.alerts', icon: 'bell' as const, title: 'Alert Settings', text: 'How many days in advance alerts appear.' },
  { to: '/admin/company', permission: 'admin.company', icon: 'building' as const, title: 'Company Details', text: 'Name, address and logo for printouts.' },
  { to: '/admin/import', permission: 'admin.import', icon: 'download' as const, title: 'Import and Backup', text: 'Import orders from a spreadsheet, or download a full backup.' },
  { to: '/admin/archive', permission: 'admin.archive', icon: 'archive' as const, title: 'Archive', text: 'Restore archived records, or delete them permanently.' },
  { to: '/admin/activity', permission: 'admin.activity', icon: 'history' as const, title: 'Activity', text: 'Every change: who made it, what changed and when.' },
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
              <Icon name={s.icon} className="mr-2 h-4 w-4 align-[-2px] text-slate-500" />
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
