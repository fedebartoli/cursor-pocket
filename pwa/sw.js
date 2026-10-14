// Cursor Pocket service worker: cached app shell (network-first), push notifications, notification tap.
// When this file is served, the daemon replaces two placeholders (double underscore, uppercase) with the PWA file
// hash (worker updates on every change) and the list of all app files, so the app starts even with the Mac off.
const BUILD = '__BUILD_ID__';
const CACHE = `cp-shell-${BUILD}`;
let PRECACHE = ['/'];
try {
  PRECACHE = JSON.parse('__PRECACHE__');
} catch {
  // file read without substitution (e.g. opened directly from disk): shell only
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url)))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('cp-shell-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

// Never cached: API, SSE stream, healthz, and the worker itself. Chat data never hits disk.
function cacheable(url) {
  return url.origin === self.location.origin && !url.pathname.startsWith('/api/') && url.pathname !== '/healthz' && url.pathname !== '/sw.js';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !cacheable(new URL(req.url))) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// iOS requires EVERY push to show a notification: showNotification is always called, even with bad payload.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}; // e.g. JSON "null" or a number
  const title = typeof data.title === 'string' && data.title ? data.title : 'Cursor Pocket';
  const url = typeof data.url === 'string' && data.url.startsWith('/#/') ? data.url : '/#/';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url },
  };
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag;

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      const count = Number(data.badge);
      try {
        if (Number.isFinite(count) && count > 0) await self.navigator.setAppBadge?.(Math.min(count, 99));
        else await self.navigator.clearAppBadge?.();
      } catch {
        // badge not supported
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/#/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const mine = windows.filter((w) => new URL(w.url).origin === self.location.origin);
      if (!mine.length) {
        await self.clients.openWindow(url);
        return;
      }
      // Ask ALL app windows to navigate (on iOS a leftover Safari tab may exist)
      // and BEFORE focus: bringing to front can fail and must not block changing chat.
      for (const w of mine) {
        try {
          w.postMessage({ type: 'navigate', hash: url.slice(1) });
        } catch {
          // window already closed
        }
      }
      const best = mine.find((w) => w.focused) ?? mine.find((w) => w.visibilityState === 'visible') ?? mine[0];
      try {
        await best.focus();
      } catch {
        try {
          await self.clients.openWindow(url);
        } catch {
          // nothing left to do: navigation was already requested
        }
      }
    })(),
  );
});
