// Stato "vivo": snapshot dal daemon, aggiornato via SSE (EventSource) con riconnessione e ricarico al ritorno in primo piano.
import { api } from './api.js';

const OFFLINE_GRACE_MS = 3000;

const live = {
  version: -1,
  payload: null, // { version, state, status }
  loaded: false,
  connection: 'connecting', // 'ok' | 'connecting'
  offline: false, // vero solo se non connesso da piu' di OFFLINE_GRACE_MS
  // Diagnostica (mostrata nelle Impostazioni): dove si perde tempo tra il Mac e il telefono.
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
      // un subscriber difettoso non deve fermare gli altri
    }
  }
}

function setBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    // badge non supportato
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
  const lag = typeof payload.at === 'number' ? Math.max(0, Date.now() - payload.at) : null; // stima: dipende dagli orologi
  if (via === 'sse') {
    live.stats.sseEvents += 1;
    live.stats.lastSseAt = Date.now();
    live.stats.lastSseLagMs = lag;
  } else if (live.version >= 0 && payload.version > live.version) {
    // Il controllo periodico ha trovato uno stato che il flusso live non aveva ancora consegnato.
    live.stats.pollWins += 1;
    live.stats.lastPollWinLagMs = lag;
  }
  live.version = payload.version;
  live.payload = payload;
  live.loaded = true;
  setBadge(payload.state?.counts?.attention ?? 0);
  emit();
}

/** Scarica lo snapshot corrente. Lancia ApiError (401 incluso: lo gestisce l'app). */
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
      if (err.status === 401) return; // l'app mostra il login
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
    live.version = -1; // dopo una riconnessione la numerazione puo' ripartire (riavvio del daemon)
    setConnection('ok');
  });
  es.addEventListener('state', (ev) => {
    try {
      apply(JSON.parse(ev.data), false, 'sse');
      setConnection('ok');
    } catch {
      // evento malformato: si ignora
    }
  });
  es.addEventListener('error', () => {
    setConnection('connecting');
    // Se il browser ha rinunciato (CLOSED), si riprova a mano con attesa crescente.
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

// iOS sospende le PWA in background senza avvisare la connessione: al ritorno in primo piano si riparte da capo.
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
