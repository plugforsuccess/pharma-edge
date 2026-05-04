// PWA + push notification helpers.
//
// SW registration lives in main.jsx (production-only). These helpers are
// for the push-notification permission/subscription flow once delivery is
// wired up. NOTE: there is no server-side push delivery yet — see CLAUDE.md
// for the push_subscriptions + web-push backlog item. Calling
// `subscribeToPush` succeeds in the browser but the resulting subscription
// is never persisted, so no push will ever arrive until that's built.

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

export async function subscribeToPush() {
  const registration = await getServiceWorkerRegistration()
  if (!registration) return null

  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  if (!vapidKey) {
    console.warn('VITE_VAPID_PUBLIC_KEY not set — push subscription disabled')
    return null
  }

  try {
    const existing = await registration.pushManager.getSubscription()
    if (existing) return existing
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    })
  } catch (err) {
    console.error('subscribeToPush failed:', err)
    return null
  }
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}
