// @permission-scope admin.users, admin.departments, admin.machine_types, admin.dropdowns, admin.stages, admin.order_defaults, admin.scheduling, admin.holidays, admin.groups, admin.board_templates, admin.email, admin.email_log, admin.checklists, admin.build_checklists, admin.production, admin.templates, admin.chat, admin.records, admin.serials, admin.board, admin.alerts, admin.company, admin.import, admin.archive, admin.activity, admin.status
import { Link } from 'react-router-dom'
import Can from '../../components/Can'
import Icon from '../../components/Icon'
import SettingsSearch from '../../components/SettingsSearch'
import { ADMIN_PAGES, ADMIN_VIEW_ONLY } from '../../lib/adminPages'

/** The Admin home: every admin page this person may open, in a grid that fills the width. */
export default function AdminHomePage() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Admin</h1>
          <p className="mt-1 text-sm text-slate-600">Company-wide settings. Every change here is recorded in Activity.</p>
        </div>
        <SettingsSearch />
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))]">
        {ADMIN_PAGES.map((s) => (
          <Can key={s.to} permission={s.permission} level={ADMIN_VIEW_ONLY.has(s.permission) ? 'view' : 'edit'}>
            <Link to={s.to} className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400 hover:shadow-sm">
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
