// PWA service worker, run in an isolated context with a fake `self`.
// iOS-critical: every push MUST show a notification, tap must open the right chat, chat data
// must never end up in the cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SW_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../pwa/sw.js');
const ORIGIN = 'https://mac.tailnet.ts.net';

function loadWorker({ windows = [], fetchImpl, shell = false, badgeFails = false } = {}) {
  const listeners = {};
  const calls = { notifications: [], badge: [], opened: [], cached: [], added: [] };
  const sandbox = {
    console,
    URL,
    Response,
    Promise,
    JSON,
    Number,
    Math,
    Array,
    Object,
    String,
    location: { origin: ORIGIN },
    caches: {
      open: async () => ({
        put: async (req) => calls.cached.push(typeof req === 'string' ? req : req.url),
        add: async (url) => calls.added.push(url),
        match: async (r) => (shell && r === '/' ? new Response('GUSCIO') : undefined),
      }),
      keys: async () => ['cp-shell-vecchia', 'altro', 'cp-shell-test'],
      delete: async (k) => calls.cached.push(`delete:${k}`),
    },
    fetch: fetchImpl ?? (async () => new Response('rete')),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting() {},
    registration: {
      showNotification: async (title, options) => {
        calls.notifications.push({ title, options });
      },
    },
    navigator: {
      setAppBadge: async (n) => {
        if (badgeFails) throw new Error('non supportato');
        calls.badge.push(['set', n]);
      },
      clearAppBadge: async () => {
        if (badgeFails) throw new Error('non supportato');
        calls.badge.push(['clear']);
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (u) => {
        calls.opened.push(u);
      },
    },
  };
  sandbox.self = sandbox;
  const src = fs.readFileSync(SW_PATH, 'utf8').replaceAll('__BUILD_ID__', 'test').replaceAll('__PRECACHE__', '["/","/js/app.js","/css/app.css"]');
  vm.runInNewContext(src, sandbox);
  return { listeners, calls };
}

async function fire(listener, event) {
  const waits = [];
  listener({ ...event, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}

function pushEvent(data) {
  if (data === undefined) return { data: null };
  if (data instanceof Error) {
    return {
      data: {
        json: () => {
          throw data;
        },
      },
    };
  }
  return { data: { json: () => data } };
}

test('valid push: shows notification with title, body, tag and URL, and sets badge', async () => {
  const { listeners, calls } = loadWorker();
  await fire(listeners.push, pushEvent({ title: 'Domanda in attesa', body: 'Chat - app\nCome procedo?', tag: 'chat-1', url: '/#/chat/1', badge: 3 }));
  assert.equal(calls.notifications.length, 1);
  const n = calls.notifications[0];
  assert.equal(n.title, 'Domanda in attesa');
  assert.equal(n.options.body, 'Chat - app\nCome procedo?');
  assert.equal(n.options.tag, 'chat-1');
  assert.equal(n.options.data.url, '/#/chat/1');
  assert.deepEqual(calls.badge, [['set', 3]]);
});

test('malformed push (broken JSON, empty, wrong field types): still shows a notification (iOS requires it)', async () => {
  for (const data of [new SyntaxError('x'), undefined, {}, { title: 42, body: { a: 1 }, tag: 7, url: 5 }, null]) {
    const { listeners, calls } = loadWorker();
    await fire(listeners.push, pushEvent(data));
    assert.equal(calls.notifications.length, 1, JSON.stringify(data));
    assert.equal(calls.notifications[0].title, 'Cursor Pocket');
    assert.equal(calls.notifications[0].options.data.url, '/#/');
    assert.equal(calls.notifications[0].options.body, '');
  }
});

test('push: external or unexpected URLs are not accepted', async () => {
  for (const url of ['https://evil.example/', 'javascript:alert(1)', '//evil', '/api/state', '#/chat/1']) {
    const { listeners, calls } = loadWorker();
    await fire(listeners.push, pushEvent({ title: 't', url }));
    assert.equal(calls.notifications[0].options.data.url, '/#/', url);
  }
});

test('push: zero badge clears it, huge values capped at 99', async () => {
  let w = loadWorker();
  await fire(w.listeners.push, pushEvent({ title: 't', badge: 0 }));
  assert.deepEqual(w.calls.badge, [['clear']]);
  w = loadWorker();
  await fire(w.listeners.push, pushEvent({ title: 't', badge: 500 }));
  assert.deepEqual(w.calls.badge, [['set', 99]]);
  w = loadWorker();
  await fire(w.listeners.push, pushEvent({ title: 't', badge: 'x' }));
  assert.deepEqual(w.calls.badge, [['clear']]);
});

test('push: badge API failure does not break push handling', async () => {
  const { listeners, calls } = loadWorker({ badgeFails: true });
  await fire(listeners.push, pushEvent({ title: 'Chat finita', badge: 2 })); // would fail the test here if it threw
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, 'Chat finita');
});

test('notification click: focuses open window and requests navigation', async () => {
  const log = [];
  const win = { url: `${ORIGIN}/`, focus: async () => log.push('focus'), postMessage: (m) => log.push(m) };
  const other = { url: 'https://altro.example/', focus: async () => log.push('ERRORE'), postMessage: () => log.push('ERRORE') };
  const { listeners, calls } = loadWorker({ windows: [other, win] });
  let closed = false;
  await fire(listeners.notificationclick, { notification: { close: () => (closed = true), data: { url: '/#/chat/abc-123' } } });
  assert.equal(closed, true);
  // JSON: message is created in the worker isolated context (different prototypes)
  // navigation is requested before focus (focus can fail on iOS)
  assert.deepEqual(JSON.parse(JSON.stringify(log)), [{ type: 'navigate', hash: '#/chat/abc-123' }, 'focus']);
  assert.deepEqual(calls.opened, []);
});

test('notification click: if focus fails navigation is still requested (fallback openWindow); multiple windows: all get the message', async () => {
  const log = [];
  const broken = { url: `${ORIGIN}/`, focus: async () => { throw new Error('focus non consentito'); }, postMessage: (m) => log.push(['a', m.type]) };
  const visible = { url: `${ORIGIN}/#/chat/x`, visibilityState: 'visible', focus: async () => log.push('focus-visible'), postMessage: (m) => log.push(['b', m.type]) };
  const one = loadWorker({ windows: [broken] });
  await fire(one.listeners.notificationclick, { notification: { close() {}, data: { url: '/#/chat/abc' } } });
  assert.deepEqual(log, [['a', 'navigate']]);
  assert.deepEqual(one.calls.opened, ['/#/chat/abc']);
  log.length = 0;
  const two = loadWorker({ windows: [broken, visible] });
  await fire(two.listeners.notificationclick, { notification: { close() {}, data: { url: '/#/chat/abc' } } });
  assert.deepEqual(log, [['a', 'navigate'], ['b', 'navigate'], 'focus-visible']);
  assert.deepEqual(two.calls.opened, []);
});

test('notification click: with no open windows opens the app at the notification URL', async () => {
  const { listeners, calls } = loadWorker({ windows: [] });
  await fire(listeners.notificationclick, { notification: { close() {}, data: { url: '/#/chat/xyz' } } });
  assert.deepEqual(calls.opened, ['/#/chat/xyz']);
  const again = loadWorker({ windows: [] });
  await fire(again.listeners.notificationclick, { notification: { close() {}, data: undefined } });
  assert.deepEqual(again.calls.opened, ['/#/']);
});

test('fetch: API, healthz, the worker itself, non-GET and other origins do NOT use the cache', () => {
  const { listeners } = loadWorker();
  const intercepted = (request) => {
    let hit = false;
    listeners.fetch({ request, respondWith: () => (hit = true) });
    return hit;
  };
  const get = (p, extra = {}) => ({ method: 'GET', url: `${ORIGIN}${p}`, mode: 'cors', ...extra });
  assert.equal(intercepted(get('/api/state')), false);
  assert.equal(intercepted(get('/api/events')), false);
  assert.equal(intercepted(get('/api/chats/00000000-0000-4000-8000-000000000001')), false);
  assert.equal(intercepted(get('/healthz')), false);
  assert.equal(intercepted(get('/sw.js')), false);
  assert.equal(intercepted({ method: 'POST', url: `${ORIGIN}/js/app.js`, mode: 'cors' }), false);
  assert.equal(intercepted({ method: 'GET', url: 'https://altro.example/js/app.js', mode: 'cors' }), false);
  assert.equal(intercepted(get('/js/app.js')), true);
  assert.equal(intercepted(get('/', { mode: 'navigate' })), true);
});

test('fetch: network first; offline serves shell for navigations and 503 for the rest', async () => {
  const online = loadWorker();
  let res;
  online.listeners.fetch({ request: { method: 'GET', url: `${ORIGIN}/css/app.css`, mode: 'cors' }, respondWith: (p) => (res = p) });
  const ok = await res;
  assert.equal(await ok.text(), 'rete');

  const offline = loadWorker({ fetchImpl: async () => Promise.reject(new TypeError('offline')), shell: true });
  let nav;
  offline.listeners.fetch({ request: { method: 'GET', url: `${ORIGIN}/`, mode: 'navigate' }, respondWith: (p) => (nav = p) });
  assert.equal(await (await nav).text(), 'GUSCIO');
  let other;
  offline.listeners.fetch({ request: { method: 'GET', url: `${ORIGIN}/js/inesistente.js`, mode: 'cors' }, respondWith: (p) => (other = p) });
  assert.equal((await other).status, 503);
});

test('install and activate: precache all files, remove old caches (own only)', async () => {
  const { listeners, calls } = loadWorker();
  await fire(listeners.install, {});
  assert.deepEqual(calls.added, ['/', '/js/app.js', '/css/app.css']);
  await fire(listeners.activate, {});
  assert.ok(calls.cached.includes('delete:cp-shell-vecchia'));
  assert.ok(!calls.cached.includes('delete:altro'), 'does not touch foreign caches');
  assert.ok(!calls.cached.includes('delete:cp-shell-test'), 'does not delete current cache');
});

test('without placeholder substitution the worker still starts (shell only)', async () => {
  const sandbox = { URL, Response, Promise, JSON, location: { origin: ORIGIN }, listeners: {}, added: [] };
  Object.assign(sandbox, {
    caches: { open: async () => ({ add: async (u) => sandbox.added.push(u) }), keys: async () => [], delete: async () => true },
    addEventListener: (t, f) => (sandbox.listeners[t] = f),
    skipWaiting() {},
    clients: { claim: async () => {} },
  });
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox);
  await fire(sandbox.listeners.install, {});
  assert.deepEqual(sandbox.added, ['/']);
});
