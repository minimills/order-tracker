import { dtf, tr } from '../../i18n'
// @permission-scope service.calendar.import
import { useCallback, useEffect, useState } from 'react'
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

const when = dtf({ timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short' })

/**
 * Calendar → Calendar Connection → "From your phone to the app":
 * link a work calendar from the phone so its entries show in the app.
 * `version` reloads it (after Refresh Now on the page); `onSynced` tells the page.
 */
export default function CalendarImportSettings({ version = 0, onSynced }: { version?: number; onSynced?: () => void }) {
  const { session } = useAuth()
  const me = session?.user.email?.toLowerCase() ?? ''
  const [link, setLink] = useState<Link_ | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [app, setApp] = useState<App>('apple')
  const [steps, setSteps] = useState(false)

  const load = useCallback(async () => {
    if (!supabase || !me) return
    const { data } = await supabase
      .from('calendar_imports')
      .select('url, status, last_synced_at, last_attempt_at, last_error, event_count')
      .eq('user_email', me)
      .maybeSingle()
    setLink((data as Link_ | null) ?? null)
    setLoaded(true)
    // version: reload after the page's Refresh Now.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [me, version])

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
    else if (!quiet) toast.success(r.message || tr("Phone calendar read."))
    load()
    onSynced?.()
  }

  async function save() {
    if (!supabase) return
    if (!url.trim()) return toast.error(tr("Paste the calendar link first."))
    setBusy(true)
    const { error } = await supabase.rpc('set_my_calendar_import', { p_url: url.trim() })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    setEditing(false)
    setUrl('')
    toast.success(tr("Link saved. Reading the calendar now…"))
    await syncNow(true)
  }

  async function remove() {
    if (!supabase) return
    if (
      !(await confirmAction(tr("Remove the link? The entries read from your phone calendar disappear from the app. Your phone calendar itself is not changed."), {
        get confirmLabel() {
    return tr("Remove Link")
  },
        danger: true,
      }))
    )
      return
    const { error } = await supabase.rpc('remove_my_calendar_import')
    if (error) return toast.error(friendlyError(error))
    toast.success(tr("Link removed."))
    load()
    onSynced?.()
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-700">
        {tr("Show the work entries from your phone on this calendar. Make a separate calendar on your phone just for work (for example “BMM – to app”) and paste its private link here. Entries you put in that calendar appear in the app within 5 minutes, marked “From phone”.")}
      </p>
      <ul className="list-disc space-y-1 pl-5 text-slate-700">
        <li>
          {tr("Only that one calendar is read, never your other calendars. Entries from the phone can only be changed on the phone; the office can set their type and link them to a customer or order.")}
        </li>
        <li>{tr("Entries made in the app still go to your phone through “From the app to your phone” below. Phone entries are never sent back, so nothing appears twice.")}</li>
      </ul>

      {loaded && link && !editing && (
        <div className={`space-y-1 rounded-md border p-3 ${link.status === 'error' ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'}`}>
          <p className="flex items-center gap-2 font-medium">
            <Icon name="phone" />
            {link.status === 'error' ? tr("The link is not working") : link.status === 'pending' ? tr("Linked, not read yet") : tr("Linked")}
          </p>
          <p className="break-all font-mono text-xs text-slate-600">{link.url.replace(/(private-)[^/]+/, '$1…').replace(/(published\/\d+\/).{6,}/, '$1…')}</p>
          <p className="text-slate-700">
            {tr("Last synced")} {link.last_synced_at ? when.format(new Date(link.last_synced_at)) : tr("not yet")} {tr("(checked every 5 minutes)")}
            {link.status === 'ok' ? ` · ${link.event_count} ${link.event_count === 1 ? tr("entry") : tr("entries")}` : ''}
          </p>
          {link.status === 'error' && link.last_error && (
            <p className="text-red-800" role="alert">
              {link.last_error} {tr("Entries read before stay in the app until the link works again or is removed.")}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => syncNow()}>
              {busy ? tr("Reading…") : tr("Refresh Now")}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)}>
              {tr("Replace Link")}
            </button>
            <button type="button" className="text-red-700 underline" onClick={remove}>
              {tr("Remove Link")}
            </button>
          </div>
        </div>
      )}

      {loaded && (!link || editing) && (
        <div className="space-y-2">
          <label htmlFor="cal-import-url" className="block font-medium">
            {tr("Private calendar link")}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="cal-import-url"
              className={`${inputClass} flex-1 font-mono text-xs`}
              placeholder={tr("webcal://… or https://…")}
              value={url}
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="button" className={buttonClass} disabled={busy} onClick={save}>
              {busy ? tr("Saving…") : tr("Save Link")}
            </button>
            {editing && (
              <button type="button" className={secondaryButtonClass} onClick={() => setEditing(false)}>
                {tr("Cancel")}
              </button>
            )}
          </div>
        </div>
      )}

      <button type="button" className="font-medium text-blue-700 underline" aria-expanded={steps} onClick={() => setSteps(!steps)}>
        {steps ? tr("▾ Hide the steps for getting the link") : tr("▸ Show the steps for getting the link")}
      </button>
      {steps && (
        <>
      <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label={tr("Calendar app")}>
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
          <p className="font-medium">{tr("On an iPhone")}</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              {tr("Open the")} <strong>{tr("Calendar")}</strong> {tr("app and tap")} <strong>{tr("Calendars")}</strong> {tr("at the bottom, then")} <strong>{tr("Add Calendar")}</strong> →{' '}
              <strong>{tr("Add Calendar")}</strong>.
            </li>
            <li>
              {tr("Name it")} <strong>{tr("BMM – to app")}</strong>{tr(", choose the")} <strong>iCloud</strong> {tr("account (not “On My iPhone”), and tap")}{' '}
              <strong>{tr("Done")}</strong>.
            </li>
            <li>
              {tr("Back in")} <strong>{tr("Calendars")}</strong>{tr(", tap the round")} <strong>i</strong> {tr("button next to BMM – to app, turn on")} <strong>{tr("Public Calendar")}</strong>{tr(", tap")} <strong>{tr("Share Link…")}</strong> {tr("and then")} <strong>{tr("Copy")}</strong>.
            </li>
            <li>{tr("Paste the link above and tap Save Link. Put work entries in this calendar from now on.")}</li>
          </ol>
          <p className="font-medium">{tr("On a Mac")}</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              {tr("In")} <strong>{tr("Calendar")}</strong>{tr(", choose")} <strong>{tr("File")}</strong> → <strong>{tr("New Calendar")}</strong> → <strong>iCloud</strong> {tr("and name it")}{' '}
              <strong>{tr("BMM – to app")}</strong>.
            </li>
            <li>
              {tr("Right-click the calendar (or Control-click) →")} <strong>{tr("Share Calendar…")}</strong>{tr(", turn on")} <strong>{tr("Public Calendar")}</strong>{tr(", then copy the link that appears (or right-click it again →")} <strong>{tr("Copy URL to Share")}</strong>).
            </li>
            <li>{tr("Paste the link above and click Save Link.")}</li>
          </ol>
          <p className="text-slate-600">{tr("“Public” means anyone with the link can see this one calendar. Keep it for work entries only, and do not share the link.")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              {tr("On a computer, open")} <strong>calendar.google.com</strong>{tr(". Next to")} <strong>{tr("Other calendars")}</strong>{tr(", click")} <strong>+</strong> →{' '}
              <strong>{tr("Create new calendar")}</strong>{tr(", name it")} <strong>{tr("BMM – to app")}</strong> {tr("and click")} <strong>{tr("Create calendar")}</strong>.
            </li>
            <li>
              {tr("Click the gear →")} <strong>{tr("Settings")}</strong>{tr(". On the left under")} <strong>{tr("Settings for my calendars")}</strong>{tr(", click")}{' '}
              <strong>{tr("BMM – to app")}</strong>.
            </li>
            <li>
              {tr("Scroll to")} <strong>{tr("Integrate calendar")}</strong> {tr("and copy the")} <strong>{tr("Secret address in iCal format")}</strong> {tr("(click the copy button next to it).")}
            </li>
            <li>{tr("Paste the link above and click Save Link. The new calendar also appears in the Google Calendar app on your phone; put work entries in it.")}</li>
          </ol>
          <p className="text-slate-600">
            {tr("The secret address lets anyone who has it see this one calendar. If it was shared by mistake, click")} <strong>{tr("Reset")}</strong> {tr("next to it in Google Calendar, then use Replace Link here with the new address.")}
          </p>
        </div>
      )}
        </>
      )}
    </div>
  )
}
