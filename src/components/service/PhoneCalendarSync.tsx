// @permission-scope service.calendar.sync
import { useState } from 'react'
import { toast } from 'sonner'
import { buttonClass, inputClass, secondaryButtonClass } from '../form'
import { confirmAction } from '../../lib/confirm'
import { friendlyError } from '../../lib/format'
import { calendarFeedUrl } from '../../lib/service'
import { supabase } from '../../lib/supabase'

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
        'Make a new link? The old link stops working at once, so every calendar that uses it (yours too) must be added again with the new link.',
        { confirmLabel: 'Make a New Link', danger: true },
      ))
    )
      return
    const { data, error } = await supabase.rpc('reset_my_calendar_feed')
    if (error) return toast.error(friendlyError(error))
    setUrl(calendarFeedUrl(data as string))
    toast.success('New link made. The old one no longer works.')
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('The link could not be copied. Select it and copy it by hand.')
    }
  }

  const webcal = url?.replace(/^https?:\/\//, 'webcal://') ?? ''

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-700">
        Your private calendar link adds your training visits, service calls, travel days and your own entries to the calendar app on
        your phone or computer, and keeps them up to date by itself.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-slate-700">
        <li>
          It works <strong>one way only</strong>: from the Order Tracker to your phone. Changes made in the phone calendar are not
          sent back. Change entries here instead.
        </li>
        <li>
          Your phone checks for changes by itself. Apple Calendar and Outlook usually update within an hour;{' '}
          <strong>Google Calendar can take several hours</strong> (sometimes up to a day), and it cannot be made faster.
        </li>
        <li>Keep the link private: anyone who has it can see your calendar. If it was shared by mistake, make a new link below.</li>
      </ul>

      {!url ? (
        <button type="button" className={buttonClass} onClick={show}>
          Show My Calendar Link
        </button>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Your calendar link" readOnly className={`${inputClass} flex-1 font-mono text-xs`} value={url} onFocus={(e) => e.target.select()} />
            <button type="button" className={secondaryButtonClass} onClick={copy}>
              {copied ? 'Copied' : 'Copy Link'}
            </button>
          </div>
          <div className="flex gap-1 border-b border-slate-200" role="tablist" aria-label="Calendar app">
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
                On your iPhone, open this page and tap{' '}
                <a href={webcal} className="font-medium text-blue-700 underline">
                  Add to Apple Calendar
                </a>
                , then tap <strong>Subscribe</strong> and <strong>Add</strong>.
              </li>
              <li>
                Or by hand: open <strong>Settings</strong> → <strong>Calendar</strong> → <strong>Accounts</strong> →{' '}
                <strong>Add Account</strong> → <strong>Other</strong> → <strong>Add Subscribed Calendar</strong>, paste the link, tap{' '}
                <strong>Next</strong> and then <strong>Save</strong>.
              </li>
              <li>
                To check for changes more often: Settings → Calendar → Accounts → <strong>Fetch New Data</strong> → choose{' '}
                <strong>Every 15 minutes</strong> or <strong>Hourly</strong>.
              </li>
              <li>On a Mac: Calendar → File → New Calendar Subscription, paste the link, then choose Auto-refresh: Every hour.</li>
            </ol>
          )}
          {app === 'google' && (
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                On a computer, open{' '}
                <a href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" target="_blank" rel="noreferrer" className="font-medium text-blue-700 underline">
                  Google Calendar → Add calendar → From URL
                </a>{' '}
                (the Google Calendar phone app cannot add links).
              </li>
              <li>
                Paste the link, then click <strong>Add calendar</strong>. It appears under <strong>Other calendars</strong>.
              </li>
              <li>
                On an Android phone: open the Google Calendar app → menu → <strong>Settings</strong> → tap the new calendar and turn on{' '}
                <strong>Sync</strong>.
              </li>
              <li>Google refreshes subscribed calendars on its own schedule, which can take several hours.</li>
            </ol>
          )}
          {app === 'outlook' && (
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                Outlook on the web (outlook.com or Microsoft 365): open <strong>Calendar</strong> → <strong>Add calendar</strong> →{' '}
                <strong>Subscribe from web</strong>, paste the link, give it a name and click <strong>Import</strong>.
              </li>
              <li>
                Outlook on Windows: <strong>Calendar</strong> → <strong>Add</strong> (or Open Calendar) → <strong>From Internet</strong>,
                paste the link, click <strong>OK</strong> and confirm.
              </li>
              <li>The Outlook phone app shows it once it is added to the same account on the web or the computer.</li>
            </ol>
          )}
          <button type="button" className="text-sm text-red-700 underline" onClick={reset}>
            Make a New Link (if the link was shared by mistake)
          </button>
        </div>
      )}
    </div>
  )
}
