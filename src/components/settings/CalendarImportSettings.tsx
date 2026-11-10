// @permission-scope service.calendar.import
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import Icon from '../Icon'
import { buttonClass, inputClass, secondaryButtonClass } from '../form'
import { useAuth } from '../../lib/auth'
import { confirmAction } from '../../lib/confirm'
import { callFunction } from '../../lib/edgeFunction'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Link_ = {
  url: string
  status: 'pending' | 'ok' | 'error'
  last_synced_at: string | null
  last_attempt_at: string | null
  last_error: string | null
  event_count: number
}
type App = 'apple' | 'google'

const when = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short' })

/** My settings → Calendar: link a work calendar from the phone so its entries show in the app. */
export default function CalendarImportSettings() {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [link, setLink] = useState<Link_ | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [app, setApp] = useState<App>('apple')

  const load = useCallback(async () => {
    if (!supabase || !me) return
    const { data } = await supabase
      .from('calendar_imports')
      .select('url, status, last_synced_at, last_attempt_at, last_error, event_count')
      .eq('user_email', me)
      .maybeSingle()
    setLink((data as Link_ | null) ?? null)
    setLoaded(true)
  }, [me])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function syncNow(quiet = false) {
    setBusy(true)
    const r = await callFunction('calendar-import', { action: 'sync_mine' })
    setBusy(false)
    if (!r.ok) toast.error(r.message)
    else if (!quiet) toast.success(r.message || 'Phone calendar read.')
    load()
  }

  async function save() {
    if (!supabase) return
    if (!url.trim()) return toast.error('Paste the calendar link first.')
    setBusy(true)
    const { error } = await supabase.rpc('set_my_calendar_import', { p_url: url.trim() })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setEditing(false)
    setUrl('')
    toast.success('Link saved. Reading the calendar now…')
    await syncNow(true)
  }

  async function remove() {
    if (!supabase) return
    if (
      !(await confirmAction('Remove the link? The entries read from your phone calendar disappear from the app. Your phone calendar itself is not changed.', {
        confirmLabel: 'Remove Link',
        danger: true,
      }))
    )
      return
    const { error } = await supabase.rpc('remove_my_calendar_import')
    if (error) return toast.error(friendlyError(error))
    toast.success('Link removed.')
    load()
  }

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h2 className="text-base font-semibold">Calendar</h2>
      <p className="text-slate-700">
        Show the work entries from your phone in the Order Tracker’s{' '}
        <Link to="/service/calendar" className="text-blue-700 underline">
          Technician Calendar
        </Link>
        . Make a separate calendar on your phone just for work (for example “BMM – to app”) and paste its private link here.
        Entries you put in that calendar appear in the app within 15 minutes, marked “From phone”.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-slate-700">
        <li>
          Only that one calendar is read, never your other calendars. Entries from the phone can only be changed on the phone; the
          office can set their type and link them to a customer or order.
        </li>
        <li>Entries made in the app still go to your phone through your calendar link on the Technician Calendar page. Phone entries are never sent back, so nothing appears twice.</li>
      </ul>

      {loaded && link && !editing && (
        <div className={`space-y-1 rounded-md border p-3 ${link.status === 'error' ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'}`}>
          <p className="flex items-center gap-2 font-medium">
            <Icon name="phone" />
            {link.status === 'error' ? 'The link is not working' : link.status === 'pending' ? 'Linked, not read yet' : 'Linked'}
          </p>
          <p className="break-all font-mono text-xs text-slate-600">{link.url.replace(/(private-)[^/]+/, '$1…').replace(/(published\/\d+\/).{6,}/, '$1…')}</p>
          <p className="text-slate-700">
            Last synced: {link.last_synced_at ? when.format(new Date(link.last_synced_at)) : 'not yet'}
            {link.status === 'ok' ? ` · ${link.event_count} ${link.event_count === 1 ? 'entry' : 'entries'}` : ''}
          </p>
          {link.status === 'error' && link.last_error && (
            <p className="text-red-800" role="alert">
              {link.last_error} Entries read before stay in the app until the link works again or is removed.
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => syncNow()}>
              {busy ? 'Reading…' : 'Sync Now'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)}>
              Replace Link
            </button>
            <button type="button" className="text-red-700 underline" onClick={remove}>
              Remove Link
            </button>
          </div>
        </div>
      )}

      {loaded && (!link || editing) && (
        <div className="space-y-2">
          <label htmlFor="cal-import-url" className="block font-medium">
            Private calendar link
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="cal-import-url"
              className={`${inputClass} flex-1 font-mono text-xs`}
              placeholder="webcal://… or https://…"
              value={url}
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="button" className={buttonClass} disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save Link'}
            </button>
            {editing && (
              <button type="button" className={secondaryButtonClass} onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Calendar app">
        {(
          [
            ['apple', 'Apple Calendar (iPhone or Mac)'],
            ['google', 'Google Calendar'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={app === k}
            className={`-mb-px border-b-2 px-3 py-2 ${app === k ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}
            onClick={() => setApp(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {app === 'apple' ? (
        <div className="space-y-2">
          <p className="font-medium">On an iPhone</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Open the <strong>Calendar</strong> app and tap <strong>Calendars</strong> at the bottom, then <strong>Add Calendar</strong> →{' '}
              <strong>Add Calendar</strong>.
            </li>
            <li>
              Name it <strong>BMM – to app</strong>, choose the <strong>iCloud</strong> account (not “On My iPhone”), and tap{' '}
              <strong>Done</strong>.
            </li>
            <li>
              Back in <strong>Calendars</strong>, tap the round <strong>i</strong> button next to BMM – to app, turn on <strong>Public Calendar</strong>,
              tap <strong>Share Link…</strong> and then <strong>Copy</strong>.
            </li>
            <li>Paste the link above and tap Save Link. Put work entries in this calendar from now on.</li>
          </ol>
          <p className="font-medium">On a Mac</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              In <strong>Calendar</strong>, choose <strong>File</strong> → <strong>New Calendar</strong> → <strong>iCloud</strong> and name it{' '}
              <strong>BMM – to app</strong>.
            </li>
            <li>
              Right-click the calendar (or Control-click) → <strong>Share Calendar…</strong>, turn on <strong>Public Calendar</strong>, then copy the
              link that appears (or right-click it again → <strong>Copy URL to Share</strong>).
            </li>
            <li>Paste the link above and click Save Link.</li>
          </ol>
          <p className="text-slate-600">“Public” means anyone with the link can see this one calendar. Keep it for work entries only, and do not share the link.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              On a computer, open <strong>calendar.google.com</strong>. Next to <strong>Other calendars</strong>, click <strong>+</strong> →{' '}
              <strong>Create new calendar</strong>, name it <strong>BMM – to app</strong> and click <strong>Create calendar</strong>.
            </li>
            <li>
              Click the gear → <strong>Settings</strong>. On the left under <strong>Settings for my calendars</strong>, click{' '}
              <strong>BMM – to app</strong>.
            </li>
            <li>
              Scroll to <strong>Integrate calendar</strong> and copy the <strong>Secret address in iCal format</strong> (click the copy button next to it).
            </li>
            <li>Paste the link above and click Save Link. The new calendar also appears in the Google Calendar app on your phone; put work entries in it.</li>
          </ol>
          <p className="text-slate-600">
            The secret address lets anyone who has it see this one calendar. If it was shared by mistake, click <strong>Reset</strong> next to it
            in Google Calendar, then use Replace Link here with the new address.
          </p>
        </div>
      )}
    </section>
  )
}
