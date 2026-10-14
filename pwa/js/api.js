// Client delle API del daemon. Il cookie di sessione e' HttpOnly: il JavaScript non lo vede mai.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unauthorizedHandlers = new Set();

/** Registra un callback chiamato quando una richiesta protetta risponde 401 (sessione scaduta o revocata). */
export function onUnauthorized(fn) {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
}

// Un collegamento che non risponde (es. VPN in riconnessione) non deve lasciare l'app ferma per sempre.
// Le azioni (invio, nuova chat) possono richiedere piu' tempo: il daemon aspetta Cursor, non si abbandona a meta'.
const REQUEST_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 60_000; // fino a 8 MB: su una rete lenta serve tempo, ma non all'infinito
const timeoutSignal = (ms) => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
};

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      signal: timeoutSignal(path === '/api/session' ? 10_000 : method === 'GET' ? REQUEST_TIMEOUT_MS : ACTION_TIMEOUT_MS),
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Daemon non raggiungibile');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // risposta senza corpo JSON
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/pair') for (const fn of unauthorizedHandlers) fn();
    throw new ApiError(res.status, data?.error || 'http', data?.message || `Errore ${res.status}`);
  }
  return data;
}

/** Carica un'immagine (corpo = i byte, tipo image/*). Risolve con { id, size }. */
async function upload(blob) {
  let res;
  try {
    res = await fetch('/api/uploads', { signal: timeoutSignal(UPLOAD_TIMEOUT_MS), method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  } catch {
    throw new ApiError(0, 'network', 'Daemon non raggiungibile');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // risposta senza corpo JSON
  }
  if (!res.ok) {
    if (res.status === 401) for (const fn of unauthorizedHandlers) fn();
    throw new ApiError(res.status, data?.error || 'http', data?.message || `Errore ${res.status}`);
  }
  return data;
}

export const api = {
  upload,
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  del: (path, body = {}) => request('DELETE', path, body),
};
