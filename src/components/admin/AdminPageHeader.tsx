import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** Title block used on every admin page, with a link back to the Admin home. */
/* @layout-helper */
export default function AdminPageHeader({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <Link to="/admin" className="text-sm text-slate-600 underline">
          ← Admin
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
        {children && <div className="mt-1 max-w-3xl text-sm text-slate-600">{children}</div>}
      </div>
      {aside}
    </div>
  )
}
