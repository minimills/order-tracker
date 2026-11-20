import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadSender, type SenderInfo } from '../../lib/sender'
import { usePermissions } from '../../lib/permissions'

/**
 * Shown in every email preview: the address the email goes out from (the
 * person's own mailbox, or the office mailbox with their name and Reply-To),
 * and whether a copy goes to a Sent folder.
 */
/* @layout-helper */
export default function SenderLine({ showLink = true }: { showLink?: boolean }) {
  const { can } = usePermissions()
  const [info, setInfo] = useState<SenderInfo | null | undefined>(undefined)
  useEffect(() => {
    loadSender().then(setInfo)
  }, [])
  if (info === undefined) return <p className="text-xs text-slate-500">Checking which address this email comes from…</p>
  if (info === null) return <p className="text-xs text-slate-500">The sending address could not be checked. The email is sent from the office mailbox.</p>
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700" data-testid="sender-line">
      <p>
        <span className="font-medium">From:</span> {info.name} &lt;<span className="break-all">{info.address}</span>&gt;
        {info.via === 'own' ? ' (your own mailbox)' : ' (the office mailbox)'}
      </p>
      {info.reply_to && (
        <p>
          <span className="font-medium">Replies go to:</span> <span className="break-all">{info.reply_to}</span>
        </p>
      )}
      <p className="text-slate-500">
        {info.saves_sent ? (info.via === 'own' ? 'A copy is saved in your Sent folder.' : 'A copy is saved in the office Sent folder.') : 'No copy is saved in a Sent folder.'}
        {showLink && can('settings.mailbox') && (
          <>
            {' '}
            <Link to="/settings?find=my-email" className="underline">
              {info.via === 'own' ? 'Change in Settings → Email' : 'Send from your own address: Settings → Email'}
            </Link>
          </>
        )}
      </p>
    </div>
  )
}
