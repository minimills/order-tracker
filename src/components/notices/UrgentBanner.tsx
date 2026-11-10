import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { friendlyError } from '../../lib/format'
import { acknowledgeNotice, useUrgentNotices } from '../../lib/notices'
import { usePermissions } from '../../lib/permissions'
import Can from '../Can'
import Icon from '../Icon'

/** A red banner at the top of every page while an Urgent notice for me is not acknowledged. */
export default function UrgentBanner() {
  const { can } = usePermissions()
  const list = useUrgentNotices(can('notices.banner'))
  const [busy, setBusy] = useState(false)
  if (!list.length) return null
  const first = list[0]

  async function acknowledge() {
    setBusy(true)
    const { error } = await acknowledgeNotice(first.id)
    setBusy(false)
    if (error) toast.error(friendlyError(error))
    else toast.success('Thank you. The notice is acknowledged.')
  }

  return (
    <Can permission="notices.banner">
      <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-red-700 px-4 py-2.5 text-sm text-white md:px-8 print:hidden">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Icon name="alert" className="h-5 w-5 shrink-0" />
          <span className="min-w-0">
            <span className="font-semibold">Urgent notice: </span>
            {first.title}
            {first.author_name && <span className="text-red-100"> · posted by {first.author_name}</span>}
            {list.length > 1 && <span className="text-red-100"> · and {list.length - 1} more</span>}
          </span>
        </span>
        <span className="flex shrink-0 gap-2">
          <Link to={`/notices?notice=${first.id}`} className="rounded-md border border-white/60 px-3 py-1 font-medium hover:bg-white/10">
            Read Notice
          </Link>
          <Can permission="notices.acknowledge" level="edit">
            <button type="button" disabled={busy} onClick={acknowledge} className="rounded-md bg-white px-3 py-1 font-semibold text-red-800 hover:bg-red-50 disabled:opacity-60">
              Acknowledge
            </button>
          </Can>
        </span>
      </div>
    </Can>
  )
}
