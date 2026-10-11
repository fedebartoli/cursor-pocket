// Service worker di Cursor Pocket: guscio dell'app in cache (network-first), notifiche push, tocco sulla notifica.
// Quando serve questo file, il daemon sostituisce due segnaposto (doppio trattino basso, in maiuscolo) con l'hash dei
// file della PWA (a ogni modifica il worker si aggiorna) e con l'elenco di tutti i file dell'app, cosi' l'app parte
// anche con il Mac spento.
const BUILD = '__BUILD_ID__';
const CACHE = `cp-shell-${BUILD}`;
let PRECACHE = ['/'];
try {
  PRECACHE = JSON.parse('__PRECACHE__');
} catch {
  // file letto senza sostituzione (es. aperto direttamente da disco): resta il solo guscio
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

// Mai in cache: API, flusso SSE, healthz e il worker stesso. I dati delle chat non finiscono mai su disco.
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

// iOS richiede che OGNI push mostri una notifica: showNotification viene sempre chiamata, anche con payload anomalo.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}; // es. JSON "null" o un numero
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
        // badge non supportato
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
      // La navigazione si chiede a TUTTE le finestre dell'app (su iOS puo' esserci anche una scheda di Safari rimasta
      // aperta) e PRIMA del focus: portare in primo piano puo' fallire e non deve impedire di cambiare chat.
      for (const w of mine) {
        try {
          w.postMessage({ type: 'navigate', hash: url.slice(1) });
        } catch {
          // finestra gia' chiusa
        }
      }
      const best = mine.find((w) => w.focused) ?? mine.find((w) => w.visibilityState === 'visible') ?? mine[0];
      try {
        await best.focus();
      } catch {
        try {
          await self.clients.openWindow(url);
        } catch {
          // niente da fare: la navigazione e' gia' stata richiesta
        }
      }
    })(),
  );
});
