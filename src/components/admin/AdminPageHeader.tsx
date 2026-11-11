import type { ReactNode } from 'react'
import SettingsSearch from '../SettingsSearch'

/** Title block used on every admin page, with the settings search (the breadcrumbs above lead back to Admin). */
/* @layout-helper */
export default function AdminPageHeader({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="space-y-3 [grid-column:1/-1]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {children && <div className="mt-1 max-w-3xl text-sm text-slate-600">{children}</div>}
        </div>
        <SettingsSearch />
      </div>
      {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
    </div>
  )
}
