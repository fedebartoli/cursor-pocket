// Live state: snapshot from the daemon, updated via SSE (EventSource) with reconnect and reload on foreground.
import { api } from './api.js';

const OFFLINE_GRACE_MS = 3000;

const live = {
  version: -1,
  payload: null, // { version, state, status }
  loaded: false,
  connection: 'connecting', // 'ok' | 'connecting'
  offline: false, // true only if disconnected for longer than OFFLINE_GRACE_MS
  // Diagnostics (shown in Settings): where time is lost between Mac and phone.
  stats: { sseEvents: 0, lastSseAt: 0, lastSseLagMs: null, pollWins: 0, lastPollWinLagMs: null, lastRttMs: null, lastRefreshAt: 0 },
};

const subscribers = new Set();
let stream = null;
let retry = 0;
let restartTimer = null;
let offlineTimer = null;
let running = false;

export const getLive = () => live;

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit() {
  for (const fn of subscribers) {
    try {
      fn(live);
    } catch {
      // a faulty subscriber must not stop the others
    }
  }
}

function setBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    // badge not supported
  }
}

function setConnection(value) {
  if (live.connection === value) return;
  live.connection = value;
  clearTimeout(offlineTimer);
  if (value === 'ok') {
    live.offline = false;
  } else {
    offlineTimer = setTimeout(() => {
      live.offline = true;
      emit();
    }, OFFLINE_GRACE_MS);
  }
  emit();
}

function apply(payload, force = false, via = 'poll') {
  if (!payload || typeof payload.version !== 'number') return;
  if (!force && payload.version <= live.version) return;
  const lag = typeof payload.at === 'number' ? Math.max(0, Date.now() - payload.at) : null; // estimate: depends on clocks
  if (via === 'sse') {
    live.stats.sseEvents += 1;
    live.stats.lastSseAt = Date.now();
    live.stats.lastSseLagMs = lag;
  } else if (live.version >= 0 && payload.version > live.version) {
    // Periodic poll found state the live stream had not delivered yet.
    live.stats.pollWins += 1;
    live.stats.lastPollWinLagMs = lag;
  }
  live.version = payload.version;
  live.payload = payload;
  live.loaded = true;
  setBadge(payload.state?.counts?.attention ?? 0);
  emit();
}

/** Fetch the current snapshot. Throws ApiError (401 included: handled by the app). */
export async function refresh() {
  const t0 = performance.now();
  const payload = await api.get('/api/state');
  live.stats.lastRttMs = Math.round(performance.now() - t0);
  live.stats.lastRefreshAt = Date.now();
  apply(payload, true, 'poll');
  setConnection('ok');
  return payload;
}

function closeStream() {
  if (stream) {
    stream.close();
    stream = null;
  }
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  if (!running) return;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry++, 5));
  restartTimer = setTimeout(async () => {
    if (!running) return;
    try {
      await refresh();
    } catch (err) {
      if (err.status === 401) return; // app shows login
      setConnection('connecting');
      scheduleRestart();
      return;
    }
    openStream();
  }, delay);
}

function openStream() {
  closeStream();
  const es = new EventSource('/api/events');
  stream = es;
  es.addEventListener('open', () => {
    retry = 0;
    live.version = -1; // after reconnect numbering may restart (daemon restart)
    setConnection('ok');
  });
  es.addEventListener('state', (ev) => {
    try {
      apply(JSON.parse(ev.data), false, 'sse');
      setConnection('ok');
    } catch {
      // malformed event: ignore
    }
  });
  es.addEventListener('error', () => {
    setConnection('connecting');
    // If the browser gave up (CLOSED), retry manually with backoff.
    if (es.readyState === EventSource.CLOSED) scheduleRestart();
  });
}

export async function startLive() {
  running = true;
  try {
    await refresh();
  } catch (err) {
    if (err.status === 401) return;
    setConnection('connecting');
  }
  openStream();
}

export function stopLive() {
  running = false;
  clearTimeout(restartTimer);
  clearTimeout(offlineTimer);
  closeStream();
  live.payload = null;
  live.loaded = false;
  live.version = -1;
  live.connection = 'connecting';
  live.offline = false;
}

// iOS suspends PWAs in background without closing the connection: on foreground, start over.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  refresh()
    .then(openStream)
    .catch((err) => {
      if (err.status !== 401) {
        setConnection('connecting');
        scheduleRestart();
      }
    });
});
