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

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
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

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  del: (path, body = {}) => request('DELETE', path, body),
};
