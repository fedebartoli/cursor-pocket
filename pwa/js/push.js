// Push notifications: capability detection, subscription, and sync with the daemon.
import { api } from './api.js';

export class PushError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function base64UrlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameBytes(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.every((v, i) => v === y[i]);
}

export function environment() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return { standalone, ios, hasApis };
}

async function registration() {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new PushError('no_sw', 'Service worker non pronto')), 5000));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

/**
 * State for the UI:
 *  install (iOS not installed), unsupported, denied, off, on
 */
export async function getPushState() {
  const env = environment();
  if (!env.hasApis) return { kind: env.ios && !env.standalone ? 'install' : 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (!sub) return { kind: 'off' };
    const status = await api.post('/api/push/status', { endpoint: sub.endpoint });
    return status.subscribed ? { kind: 'on', devices: status.total } : { kind: 'off' };
  } catch {
    return { kind: 'off' };
  }
}

/** Call DIRECTLY from a user gesture (tap): iOS requires this for permission. */
export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushError(permission === 'denied' ? 'denied' : 'dismissed', 'Permesso non concesso');
  }
  const reg = await registration();
  const { publicKey } = await api.get('/api/push/public-key');
  const key = base64UrlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // If the daemon regenerated VAPID keys, the old subscription is no longer valid: renew it.
  if (sub && !sameBytes(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub = sub ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
}

export async function disablePush() {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  try {
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
  } finally {
    await sub.unsubscribe();
  }
}

export function sendTestPush() {
  return api.post('/api/push/test');
}

/** Silently restore registration on the daemon if the browser already has a subscription. */
export async function resyncPush() {
  const env = environment();
  if (!env.hasApis || Notification.permission !== 'granted') return;
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  } catch {
    // not critical
  }
}
