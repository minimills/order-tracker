// @permission-scope settings.push
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { confirmAction } from '../../lib/confirm'
import { callFunction } from '../../lib/edgeFunction'
import { friendlyError } from '../../lib/format'
import { currentSubscription, disablePushHere, enablePushHere, pushSupport } from '../../lib/push'
import { supabase } from '../../lib/supabase'
import { buttonClass, secondaryButtonClass } from '../form'
import { tr } from '../../i18n'

type Device = { id: string; endpoint: string; device_name: string | null; created_at: string; last_used_at: string | null }

/** Settings → Phone Notifications: free push messages on phones (and computers), with set-up steps. */
export default function PhoneNotifications() {
  const support = pushSupport()
  const [devices, setDevices] = useState<Device[]>([])
  const [here, setHere] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState<'iphone' | 'android' | null>(support.ios ? 'iphone' : /Android/i.test(navigator.userAgent) ? 'android' : null)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('push_subscriptions').select('id, endpoint, device_name, created_at, last_used_at').order('created_at')
    setDevices((data as Device[]) ?? [])
    setHere((await currentSubscription())?.endpoint ?? null)
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  const enabledHere = here !== null && devices.some((d) => d.endpoint === here)

  async function enable() {
    setBusy(true)
    const r = await enablePushHere()
    setBusy(false)
    if (r.ok) toast.success(r.message)
    else toast.error(r.message, { duration: 10000 })
    load()
  }
  async function test() {
    setBusy(true)
    const r = await callFunction('send-email', { action: 'test_push' })
    setBusy(false)
    if (r.ok) toast.success(r.message)
    else toast.error(r.message, { duration: 10000 })
  }
  async function remove(d: Device) {
    if (!(await confirmAction(tr("Stop phone notifications on {{value}}?", { value: d.device_name ?? tr("this device") }), { get confirmLabel() {
    return tr("Disable")
  } }))) return
    if (d.endpoint === here) await disablePushHere()
    else {
      const { error } = await supabase!.from('push_subscriptions').delete().eq('id', d.id)
      if (error) return toast.error(friendlyError(error))
    }
    toast.success(tr("Phone notifications disabled on that device."))
    load()
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h2 className="font-semibold">{tr("Phone Notifications")}</h2>
      <p className="mt-1 text-slate-600">
        {tr("Free notifications on your phone, like a text message but without SMS costs. Choose which types arrive on your phone in the Notifications table above (column “Phone push”).")}
      </p>

      <div className="mt-3 rounded-md bg-slate-50 p-3">
        <div className="font-medium">{tr("This device")}</div>
        {!support.supported ? (
          <p className="mt-1 text-slate-700">
            {support.ios && !support.installed
              ? tr("On an iPhone, phone notifications only work after the app is added to your Home Screen. Follow the iPhone steps below, then open the app from its Home Screen icon and return to this page.")
              : tr("This browser cannot receive notifications. Use Safari on an iPhone (added to the Home Screen) or Chrome on an Android phone.")}
          </p>
        ) : enabledHere ? (
          <p className="mt-1 text-green-800">{tr("Notifications are enabled on this device.")}</p>
        ) : support.permission === 'denied' ? (
          <p className="mt-1 text-amber-800">{tr("Notifications are blocked for this app. Allow them in your phone or browser settings, then reload this page.")}</p>
        ) : (
          <p className="mt-1 text-slate-700">{tr("Notifications are not enabled on this device yet.")}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {support.supported && !enabledHere && support.permission !== 'denied' && (
            <button type="button" className={buttonClass} disabled={busy} onClick={enable}>
              {tr("Enable on This Device")}
            </button>
          )}
          {devices.length > 0 && (
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={test}>
              {tr("Send a Test Notification")}
            </button>
          )}
        </div>
      </div>

      {devices.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-slate-500">{tr("Devices with notifications enabled")}</div>
          <ul className="mt-1 divide-y divide-slate-100">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
                <span>
                  {d.device_name ?? tr("Device")}
                  {d.endpoint === here && <span className="text-slate-500"> {tr("(this device)")}</span>}
                </span>
                <button type="button" className="text-xs text-red-700 underline" onClick={() => remove(d)}>
                  {tr("Disable")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <div className="text-xs font-medium text-slate-500">{tr("How to set it up")}</div>
        <div className="mt-1 flex gap-2">
          <button type="button" className={secondaryButtonClass} aria-expanded={help === 'iphone'} onClick={() => setHelp(help === 'iphone' ? null : 'iphone')}>
            {tr("iPhone Steps")}
          </button>
          <button type="button" className={secondaryButtonClass} aria-expanded={help === 'android'} onClick={() => setHelp(help === 'android' ? null : 'android')}>
            {tr("Android Steps")}
          </button>
        </div>
        {help === 'iphone' && (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-700">
            <li>{tr("Make sure the iPhone has iOS 16.4 or newer (Settings → General → About → iOS Version).")}</li>
            <li>{tr("Open")} <strong>Safari</strong> {tr("and go to")} <strong>https://order.minimills.net</strong>{tr(". Sign in.")}</li>
            <li>{tr("Tap the")} <strong>{tr("Share")}</strong> {tr("button (the square with an arrow pointing up) at the bottom of the screen.")}</li>
            <li>{tr("Scroll down and tap")} <strong>{tr("Add to Home Screen")}</strong>{tr(", then tap")} <strong>{tr("Add")}</strong>.</li>
            <li>{tr("Close Safari and open")} <strong>{tr("BMM Orders")}</strong> {tr("from your Home Screen. Sign in again if asked.")}</li>
            <li>{tr("Go to")} <strong>{tr("Settings")}</strong> {tr("in the app and tap")} <strong>{tr("Enable on This Device")}</strong>.</li>
            <li>{tr("When the iPhone asks, tap")} <strong>{tr("Allow")}</strong>.</li>
            <li>{tr("Tap")} <strong>{tr("Send a Test Notification")}</strong> {tr("to check that it works.")}</li>
            <li>{tr("If nothing arrives, check iPhone Settings → Notifications → BMM Orders and make sure notifications are allowed and Focus mode is off.")}</li>
          </ol>
        )}
        {help === 'android' && (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-700">
            <li>{tr("Open")} <strong>Chrome</strong> {tr("and go to")} <strong>https://order.minimills.net</strong>{tr(". Sign in.")}</li>
            <li>{tr("Tap the")} <strong>{tr("menu")}</strong> {tr("(three dots at the top right) and tap")} <strong>{tr("Add to Home screen")}</strong> {tr("or")} <strong>{tr("Install app")}</strong>{tr(", then")} <strong>{tr("Install")}</strong>.</li>
            <li>{tr("Open")} <strong>{tr("BMM Orders")}</strong> {tr("from your Home Screen (optional, but it then works like an app).")}</li>
            <li>{tr("Go to")} <strong>{tr("Settings")}</strong> {tr("in the app and tap")} <strong>{tr("Enable on This Device")}</strong>.</li>
            <li>{tr("When Android asks, tap")} <strong>{tr("Allow")}</strong>.</li>
            <li>{tr("Tap")} <strong>{tr("Send a Test Notification")}</strong> {tr("to check that it works.")}</li>
            <li>{tr("If nothing arrives, check Android Settings → Apps → Chrome (or BMM Orders) → Notifications and make sure they are allowed.")}</li>
          </ol>
        )}
      </div>
    </section>
  )
}
