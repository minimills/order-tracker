// @permission-scope service.calendar.sync
import { useState } from 'react'
import { toast } from 'sonner'
import { buttonClass, inputClass, secondaryButtonClass } from '../form'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { calendarFeedUrl } from '../../lib/service'
import { supabase } from '../../lib/supabase'
import { tr } from '../../i18n'

type App = 'apple' | 'google' | 'outlook'

/** Calendar Connection → "From the app to your phone": the private calendar link for Apple Calendar, Google Calendar or Outlook, with steps. */
export default function PhoneCalendarSync() {
  const [url, setUrl] = useState<string | null>(null)
  const [app, setApp] = useState<App>('apple')
  const [copied, setCopied] = useState(false)

  async function show() {
    if (!supabase) return
    const { data, error } = await supabase.rpc('my_calendar_feed')
    if (error) return toast.error(friendlyError(error))
    setUrl(calendarFeedUrl(data as string))
  }

  async function reset() {
    if (!supabase) return
    if (
      !(await confirmAction(
        tr("Make a new link? The old link stops working at once, so every calendar that uses it (yours too) must be added again with the new link."),
        { get confirmLabel() {
    return tr("Make a New Link")
  }, danger: true },
      ))
    )
      return
    const { data, error } = await supabase.rpc('reset_my_calendar_feed')
    if (error) return toast.error(friendlyError(error))
    setUrl(calendarFeedUrl(data as string))
    toast.success(tr("New link made. The old one no longer works."))
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(tr("The link could not be copied. Select it and copy it by hand."))
    }
  }

  const webcal = url?.replace(/^https?:\/\//, 'webcal://') ?? ''

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-700">
        {tr("Your private calendar link adds your training visits, service calls, travel days and your own entries to the calendar app on your phone or computer, and keeps them up to date by itself.")}
      </p>
      <ul className="list-disc space-y-1 pl-5 text-slate-700">
        <li>
          {tr("It works")} <strong>{tr("one way only")}</strong>{tr(": from the Order Tracker to your phone. Changes made in the phone calendar are not sent back. Change entries here instead.")}
        </li>
        <li>
          {tr("Your phone checks for changes by itself. Apple Calendar and Outlook usually update within an hour;")}{' '}
          <strong>{tr("Google Calendar can take several hours")}</strong> {tr("(sometimes up to a day), and it cannot be made faster.")}
        </li>
        <li>{tr("Keep the link private: anyone who has it can see your calendar. If it was shared by mistake, make a new link below.")}</li>
      </ul>

      {!url ? (
        <button type="button" className={buttonClass} onClick={show}>
          {tr("Show My Calendar Link")}
        </button>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <input aria-label={tr("Your calendar link")} readOnly className={`${inputClass} flex-1 font-mono text-xs`} value={url} onFocus={(e) => e.target.select()} />
            <button type="button" className={secondaryButtonClass} onClick={copy}>
              {copied ? tr("Copied") : tr("Copy Link")}
            </button>
          </div>
          <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label={tr("Calendar app")}>
            {(
              [
                ['apple', 'iPhone / Apple Calendar'],
                ['google', 'Google Calendar / Android'],
                ['outlook', 'Outlook'],
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
          {app === 'apple' && (
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                {tr("On your iPhone, open this page and tap")}{' '}
                <a href={webcal} className="font-medium text-blue-700 underline">
                  {tr("Add to Apple Calendar")}
                </a>
                {tr(", then tap")} <strong>{tr("Subscribe")}</strong> {tr("and")} <strong>{tr("Add")}</strong>.
              </li>
              <li>
                {tr("Or by hand: open")} <strong>{tr("Settings")}</strong> → <strong>{tr("Calendar")}</strong> → <strong>{tr("Accounts")}</strong> →{' '}
                <strong>{tr("Add Account")}</strong> → <strong>{tr("Other")}</strong> → <strong>{tr("Add Subscribed Calendar")}</strong>{tr(", paste the link, tap")}{' '}
                <strong>{tr("Next")}</strong> {tr("and then")} <strong>{tr("Save")}</strong>.
              </li>
              <li>
                {tr("To check for changes more often: Settings → Calendar → Accounts →")} <strong>{tr("Fetch New Data")}</strong> {tr("→ choose")}{' '}
                <strong>{tr("Every 15 minutes")}</strong> {tr("or")} <strong>{tr("Hourly")}</strong>.
              </li>
              <li>{tr("On a Mac: Calendar → File → New Calendar Subscription, paste the link, then choose Auto-refresh: Every hour.")}</li>
            </ol>
          )}
          {app === 'google' && (
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                {tr("On a computer, open")}{' '}
                <a href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" target="_blank" rel="noreferrer" className="font-medium text-blue-700 underline">
                  {tr("Google Calendar → Add calendar → From URL")}
                </a>{' '}
                {tr("(the Google Calendar phone app cannot add links).")}
              </li>
              <li>
                {tr("Paste the link, then click")} <strong>{tr("Add calendar")}</strong>{tr(". It appears under")} <strong>{tr("Other calendars")}</strong>.
              </li>
              <li>
                {tr("On an Android phone: open the Google Calendar app → menu →")} <strong>{tr("Settings")}</strong> {tr("→ tap the new calendar and turn on")}{' '}
                <strong>{tr("Sync")}</strong>.
              </li>
              <li>{tr("Google refreshes subscribed calendars on its own schedule, which can take several hours.")}</li>
            </ol>
          )}
          {app === 'outlook' && (
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                {tr("Outlook on the web (outlook.com or Microsoft 365): open")} <strong>{tr("Calendar")}</strong> → <strong>{tr("Add calendar")}</strong> →{' '}
                <strong>{tr("Subscribe from web")}</strong>{tr(", paste the link, give it a name and click")} <strong>{tr("Import")}</strong>.
              </li>
              <li>
                {tr("Outlook on Windows:")} <strong>{tr("Calendar")}</strong> → <strong>{tr("Add")}</strong> {tr("(or Open Calendar) →")} <strong>{tr("From Internet")}</strong>{tr(", paste the link, click")} <strong>OK</strong> {tr("and confirm.")}
              </li>
              <li>{tr("The Outlook phone app shows it once it is added to the same account on the web or the computer.")}</li>
            </ol>
          )}
          <button type="button" className="text-sm text-red-700 underline" onClick={reset}>
            {tr("Make a New Link (if the link was shared by mistake)")}
          </button>
        </div>
      )}
    </div>
  )
}
