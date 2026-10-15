// Authentication: one-time pairing code + HttpOnly session cookie.
//
//  - `npm run pair` (on the Mac) generates an 8-character code, valid a few minutes, single use. Only the hash is stored.
//  - The phone POSTs the code to /api/pair and receives a random session cookie (256 bits). Only the hash is stored.
//  - Failed attempts are rate-limited (global: behind `tailscale serve` all requests come from 127.0.0.1).
import crypto from 'node:crypto';
import { b64u, sha256Hex } from './util.js';

export const COOKIE_NAME = 'cp_session';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 (32 symbols)
const CODE_LEN = 8;
const SESSION_IDLE_MS = 90 * 24 * 3_600_000;
const TOUCH_EVERY_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;

export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const deviceId = (tokenHash) => sha256Hex(`device:${tokenHash}`).slice(0, 16);

export function sessionCookie(token, { secure }) {
  const maxAge = Math.floor(SESSION_IDLE_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearedCookie({ secure }) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export class Auth {
  #store;
  #cfg;
  #now;
  #failures = [];

  constructor({ store, config, now = Date.now }) {
    this.#store = store;
    this.#cfg = config;
    this.#now = now;
  }

  /** Create a single-use pairing code. Plaintext is returned ONCE only. */
  createPairingCode() {
    const now = this.#now();
    this.#store.prunePairing(now - 24 * 3_600_000);
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    const expiresAt = now + this.#cfg.pairingTtlMs;
    this.#store.addPairingCode(sha256Hex(code), expiresAt);
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  #blockedFor() {
    const now = this.#now();
    this.#failures = this.#failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (this.#failures.length < MAX_FAILURES) return 0;
    return FAILURE_WINDOW_MS - (now - this.#failures[0]);
  }

  /**
   * Exchange a pairing code for a session.
   * @returns {{ok: true, token: string} | {ok: false, reason: 'rate_limited'|'invalid', retryAfterMs?: number}}
   */
  pair(codeInput, { label = null } = {}) {
    const wait = this.#blockedFor();
    if (wait > 0) return { ok: false, reason: 'rate_limited', retryAfterMs: wait };
    const code = normalizeCode(codeInput);
    const now = this.#now();
    if (code.length !== CODE_LEN || !this.#store.consumePairingCode(sha256Hex(code), now)) {
      this.#failures.push(now);
      return { ok: false, reason: 'invalid' };
    }
    this.#failures = [];
    const token = b64u.encode(crypto.randomBytes(32));
    this.#store.addSession(sha256Hex(token), label, now);
    return { ok: true, token };
  }

  /** Verify a request's session cookie. @returns {{tokenHash: string, token: string}|null} */
  authenticate(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!token || token.length < 20 || token.length > 100) return null;
    const tokenHash = sha256Hex(token);
    const s = this.#store.getSession(tokenHash);
    if (!s) return null;
    const now = this.#now();
    if (now - s.lastSeenAt > SESSION_IDLE_MS) {
      this.#store.removeSession(tokenHash);
      return null;
    }
    if (now - s.lastSeenAt > TOUCH_EVERY_MS) this.#store.touchSession(tokenHash, now);
    return { tokenHash, token };
  }

  /**
   * Paired devices, no secrets: id is a hash of the token hash (cannot authenticate).
   * @returns {{id: string, label: string|null, createdAt: number, lastSeenAt: number, current: boolean, notifications: boolean}[]}
   */
  devices(currentTokenHash) {
    const withPush = new Set(this.#store.listSubscriptions().map((x) => x.sessionHash));
    return this.#store
      .listSessions()
      .map((x) => ({
        id: deviceId(x.tokenHash),
        label: x.label,
        createdAt: x.createdAt,
        lastSeenAt: x.lastSeenAt,
        current: x.tokenHash === currentTokenHash,
        notifications: withPush.has(x.tokenHash),
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** Revoke another device (never the current one: use normal logout). @returns 'ok' | 'current' | 'unknown' */
  revokeDevice(id, currentTokenHash) {
    const target = this.#store.listSessions().find((x) => deviceId(x.tokenHash) === id);
    if (!target) return 'unknown';
    if (target.tokenHash === currentTokenHash) return 'current';
    this.logout(target.tokenHash);
    return 'ok';
  }

  /** End the session and its push subscriptions. */
  logout(tokenHash) {
    this.#store.removeSubscriptionsOfSession(tokenHash);
    return this.#store.removeSession(tokenHash);
  }
}
