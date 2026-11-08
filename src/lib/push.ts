/**
 * Phone and browser push notifications (free, no SMS). The app is installable
 * ("Add to Home Screen"); public/sw.js shows the notifications. Subscriptions
 * are saved in push_subscriptions; the Edge Function "send-email" sends them.
 */
import { callFunction } from './edgeFunction'
import { supabase } from './supabase'

export type PushSupport = {
  supported: boolean
  /** iPhone / iPad: push only works once the app is added to the Home Screen. */
  ios: boolean
  /** Opened from the Home Screen (installed). */
  installed: boolean
  permission: NotificationPermission | 'unsupported'
}

export function pushSupport(): PushSupport {
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  return { supported, ios, installed, permission: 'Notification' in window ? Notification.permission : 'unsupported' }
}

export function deviceName() {
  const ua = navigator.userAgent
  const os = /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Android/i.test(ua) ? 'Android phone' : /Mac/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows computer' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser'
  return `${os} (${browser})`
}

/** Registers the service worker (called once when the app starts). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* push is optional; the app works without it */
    })
  })
}

function keyToBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
const toB64url = (buf: ArrayBuffer | null) =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : ''

/** The subscription of this device, if push is turned on here. */
export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** Asks for permission, subscribes this device and saves it. */
export async function enablePushHere(): Promise<{ ok: boolean; message: string }> {
  const s = pushSupport()
  if (!s.supported) return { ok: false, message: 'This browser cannot receive notifications. On an iPhone, add the app to your Home Screen first (see the steps below).' }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, message: 'Notifications were not allowed. Allow them for this app in your phone or browser settings, then try again.' }
  const key = await callFunction<{ key: string }>('send-email', { action: 'push_key' })
  if (!key.ok) return { ok: false, message: key.message }
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'))
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key.data.key) }))
  const { error } = await supabase!.from('push_subscriptions').upsert(
    { endpoint: sub.endpoint, p256dh: toB64url(sub.getKey('p256dh')), auth: toB64url(sub.getKey('auth')), device_name: deviceName() },
    { onConflict: 'endpoint' },
  )
  if (error) return { ok: false, message: error.message }
  return { ok: true, message: 'Notifications are enabled on this device.' }
}

/** Turns push off on this device. */
export async function disablePushHere() {
  const sub = await currentSubscription()
  if (!sub) return
  await supabase!.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}
