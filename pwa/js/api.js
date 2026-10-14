// Daemon API client. Session cookie is HttpOnly: JavaScript never sees it.
import { hasMessage, t } from './i18n/index.js';

export class ApiError extends Error {
  constructor(status, code, message, { detail, params } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (detail) this.detail = detail;
    if (params && Object.keys(params).length) this.params = params;
  }
}

const unauthorizedHandlers = new Set();

function localizedApiMessage(data, status) {
  const code = data?.error || 'http';
  const detail = data?.detail;
  const params = data?.params ?? {};
  if (detail && hasMessage(`error.${detail}`)) return t(`error.${detail}`, params);
  if (hasMessage(`error.${code}`)) return t(`error.${code}`, params);
  if (typeof data?.message === 'string' && data.message) return data.message;
  return t('api.httpError', { status });
}

/** Register a callback invoked when a protected request returns 401 (session expired or revoked). */
export function onUnauthorized(fn) {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
}

// A link that does not respond (e.g. VPN reconnecting) must not leave the app stuck forever.
// Actions (send, new chat) can take longer: the daemon waits for Cursor, we do not bail halfway.
const REQUEST_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 60_000; // up to 8 MB: slow networks need time, but not forever
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
    throw new ApiError(0, 'network', t('api.daemonUnreachable'));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // response without JSON body
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/pair') for (const fn of unauthorizedHandlers) fn();
    const code = data?.error || 'http';
    throw new ApiError(res.status, code, localizedApiMessage(data, res.status), { detail: data?.detail, params: data?.params });
  }
  return data;
}

/** Upload an image (body = bytes, type image/*). Resolves with { id, size }. */
async function upload(blob) {
  let res;
  try {
    res = await fetch('/api/uploads', { signal: timeoutSignal(UPLOAD_TIMEOUT_MS), method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  } catch {
    throw new ApiError(0, 'network', t('api.daemonUnreachable'));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // response without JSON body
  }
  if (!res.ok) {
    if (res.status === 401) for (const fn of unauthorizedHandlers) fn();
    const code = data?.error || 'http';
    throw new ApiError(res.status, code, localizedApiMessage(data, res.status), { detail: data?.detail, params: data?.params });
  }
  return data;
}

export const api = {
  upload,
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  del: (path, body = {}) => request('DELETE', path, body),
};
