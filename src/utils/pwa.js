// PWA + push notification helpers.
//
// SW registration is performed in main.jsx (production-only). These helpers
// drive the push-notification subscribe / unsubscribe flow. Server-side
// delivery lives in supabase/functions/send-alerts (web-push + VAPID
// secrets). The browser side is responsible for:
//
//   1. asking for permission
//   2. creating a PushSubscription via pushManager
//   3. upserting the (endpoint, keys) into the `push_subscriptions` table
//      using the user's JWT — RLS guarantees ownership
//
// VITE_VAPID_PUBLIC_KEY must match the public half of the keypair set as
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Supabase secrets. Generate with
// `npx web-push generate-vapid-keys`.

import { supabase } from '../lib/supabase'

export async function getServiceWorkerRegistration() {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

export async function requestPushPermission() {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

// Returns one of: 'enabled', 'denied', 'unsupported', 'no-vapid', 'no-sw',
// or 'failed' (with a console-logged error). On 'enabled', the
// subscription is persisted in push_subscriptions for the current user.
export async function enablePushNotifications(userId) {
  if (!userId) return 'failed'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'

  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  if (!vapidKey) return 'no-vapid'

  const granted = await requestPushPermission()
  if (!granted) return 'denied'

  const registration = await getServiceWorkerRegistration()
  if (!registration) return 'no-sw'

  let subscription
  try {
    subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })
    }
  } catch (err) {
    console.error('pushManager.subscribe failed:', err)
    return 'failed'
  }

  const json = subscription.toJSON()
  const endpoint = json.endpoint
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!endpoint || !p256dh || !auth) {
    console.error('subscription missing required fields')
    return 'failed'
  }

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: navigator.userAgent || null,
      },
      { onConflict: 'endpoint' },
    )
  if (error) {
    console.error('push_subscriptions upsert failed:', error)
    return 'failed'
  }
  return 'enabled'
}

export async function disablePushNotifications() {
  const registration = await getServiceWorkerRegistration()
  if (!registration) return false
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return true

  const endpoint = subscription.endpoint
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  try {
    await subscription.unsubscribe()
  } catch (err) {
    console.warn('subscription.unsubscribe failed:', err)
  }
  return true
}

export function pushPermissionStatus() {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission // 'granted' | 'denied' | 'default'
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}
