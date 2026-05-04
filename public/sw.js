const CACHE = 'pharma-edge-v1'
const ASSETS = ['/', '/manifest.json']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  // Network-first for navigations to keep the SPA shell fresh; cache-first
  // for everything else.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')))
    return
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
})

// ---------------------------------------------------------------------------
// Push notifications
//
// The push delivery pipeline (push_subscriptions table + web-push library
// + VAPID private key) is not yet built. These handlers will fire once
// that infrastructure exists; until then they are a no-op safety net.
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'Pharma Edge'
  const options = {
    body: data.body || 'New update',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    actions: data.actions || [],
    vibrate: [200, 100, 200],
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const win of windows) {
        if (win.url.endsWith(target) && 'focus' in win) return win.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})
