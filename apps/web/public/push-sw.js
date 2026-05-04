// Lightweight service worker that handles WebPush notifications only.
// Not a full PWA service worker (offline support lives in a separate SW
// when plan 08 ships). Receives JSON payloads from the worker's
// pushNotify and surfaces them via the Notifications API.

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Rose', body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Rose', {
      body: payload.body || '',
      tag: payload.tag,
      icon: '/rose.svg',
      badge: '/rose.svg',
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing tab if one's open on the target URL.
      for (const c of clients) {
        if (c.url.endsWith(target) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
