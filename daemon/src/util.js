// Dependency-free utility functions.
import crypto from 'node:crypto';

export const b64u = {
  encode(buf) {
    return Buffer.from(buf).toString('base64url');
  },
  decode(str) {
    return Buffer.from(String(str), 'base64url');
  },
};

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function clampStr(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

export function safeJsonParse(text, fallback = null) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Last component of a path (also handles trailing slashes). */
export function basenameOf(p) {
  if (!p) return '';
  const parts = String(p).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function parentNameOf(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Converte un valore (stringa ISO o numero) in millisecondi epoch, oppure null. */
export function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}
