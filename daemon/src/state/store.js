// Archivio locale del daemon (SQLite proprio, `daemon/data/store.db`). NON e' il database di Cursor.
// Contiene: chat ignorate, sottoscrizioni push, notifiche gia' inviate, codici di abbinamento, sessioni, chiavi VAPID.
// Il file e' creato con permessi 0600 (directory 0700): contiene il segreto VAPID e gli hash delle sessioni.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ignoreKey } from './present.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ignored (
  composer_id TEXT NOT NULL, tool_call_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (composer_id, tool_call_key)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, session_hash TEXT,
  created_at INTEGER NOT NULL, last_ok_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notified (dedupe_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, label TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
`;

export class Store {
  #db;
  #q;

  constructor(file) {
    if (file !== ':memory:') {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // directory non nostra: ignoriamo
      }
    }
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(SCHEMA);
    if (file !== ':memory:') {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        try {
          fs.chmodSync(f, 0o600);
        } catch {
          // il file wal/shm puo' non esistere ancora
        }
      }
    }
    const db = this.#db;
    this.#q = {
      getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
      setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      addIgnore: db.prepare('INSERT OR IGNORE INTO ignored (composer_id, tool_call_key, created_at) VALUES (?, ?, ?)'),
      delIgnore: db.prepare('DELETE FROM ignored WHERE composer_id = ? AND tool_call_key = ?'),
      listIgnore: db.prepare('SELECT composer_id, tool_call_key FROM ignored'),
      pruneIgnore: db.prepare('DELETE FROM ignored WHERE created_at < ?'),
      upsertSub: db.prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, session_hash, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
           session_hash = excluded.session_hash, fail_count = 0`,
      ),
      delSub: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
      delSubsBySession: db.prepare('DELETE FROM push_subscriptions WHERE session_hash = ?'),
      listSubs: db.prepare('SELECT endpoint, p256dh, auth, session_hash FROM push_subscriptions'),
      subOk: db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?'),
      subFail: db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?'),
      subCount: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions'),
      hasNotified: db.prepare('SELECT 1 AS x FROM notified WHERE dedupe_key = ?'),
      markNotified: db.prepare('INSERT OR IGNORE INTO notified (dedupe_key, created_at) VALUES (?, ?)'),
      pruneNotified: db.prepare('DELETE FROM notified WHERE created_at < ?'),
      addPairing: db.prepare('INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)'),
      usePairing: db.prepare(
        'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
      ),
      prunePairing: db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?'),
      addSession: db.prepare('INSERT INTO sessions (token_hash, label, created_at, last_seen_at) VALUES (?, ?, ?, ?)'),
      getSession: db.prepare('SELECT token_hash, label, created_at, last_seen_at FROM sessions WHERE token_hash = ?'),
      touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
      delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      listSessions: db.prepare('SELECT token_hash, label, created_at, last_seen_at FROM sessions ORDER BY created_at'),
      pruneSessions: db.prepare('DELETE FROM sessions WHERE last_seen_at < ?'),
    };
  }

  close() {
    this.#db.close();
  }

  // --- meta (chiavi VAPID, ecc.) ---
  getMeta(k) {
    return this.#q.getMeta.get(k)?.v ?? null;
  }
  setMeta(k, v) {
    this.#q.setMeta.run(k, String(v));
  }

  // --- ignorati ---
  addIgnored(composerId, key, now) {
    this.#q.addIgnore.run(composerId, key, now);
  }
  removeIgnored(composerId, key) {
    return this.#q.delIgnore.run(composerId, key).changes > 0;
  }
  /** @returns {Set<string>} coppie `composerId|key` (vedi ignoreKey) */
  ignoredSet() {
    return new Set(this.#q.listIgnore.all().map((r) => ignoreKey(r.composer_id, r.tool_call_key)));
  }
  pruneIgnored(olderThan) {
    return this.#q.pruneIgnore.run(olderThan).changes;
  }

  // --- sottoscrizioni push ---
  upsertSubscription({ endpoint, p256dh, auth }, sessionHash, now) {
    this.#q.upsertSub.run(endpoint, p256dh, auth, sessionHash ?? null, now);
  }
  removeSubscription(endpoint) {
    return this.#q.delSub.run(endpoint).changes > 0;
  }
  removeSubscriptionsOfSession(sessionHash) {
    return this.#q.delSubsBySession.run(sessionHash).changes;
  }
  listSubscriptions() {
    return this.#q.listSubs.all().map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, sessionHash: r.session_hash }));
  }
  countSubscriptions() {
    return this.#q.subCount.get().n;
  }
  markSubscriptionOk(endpoint, now) {
    this.#q.subOk.run(now, endpoint);
  }
  markSubscriptionFailed(endpoint) {
    this.#q.subFail.run(endpoint);
  }

  // --- notifiche gia' inviate (deduplica) ---
  hasNotified(key) {
    return this.#q.hasNotified.get(key) !== undefined;
  }
  markNotified(key, now) {
    this.#q.markNotified.run(key, now);
  }
  pruneNotified(olderThan) {
    return this.#q.pruneNotified.run(olderThan).changes;
  }

  // --- abbinamento e sessioni (si salvano solo gli hash) ---
  addPairingCode(codeHash, expiresAt) {
    this.#q.addPairing.run(codeHash, expiresAt);
  }
  consumePairingCode(codeHash, now) {
    return this.#q.usePairing.run(now, codeHash, now).changes === 1;
  }
  prunePairing(now) {
    return this.#q.prunePairing.run(now).changes;
  }
  addSession(tokenHash, label, now) {
    this.#q.addSession.run(tokenHash, label ?? null, now, now);
  }
  getSession(tokenHash) {
    const r = this.#q.getSession.get(tokenHash);
    return r ? { tokenHash: r.token_hash, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at } : null;
  }
  touchSession(tokenHash, now) {
    this.#q.touchSession.run(now, tokenHash);
  }
  removeSession(tokenHash) {
    return this.#q.delSession.run(tokenHash).changes > 0;
  }
  listSessions() {
    return this.#q.listSessions.all().map((r) => ({ tokenHash: r.token_hash, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }
  pruneSessions(olderThan) {
    return this.#q.pruneSessions.run(olderThan).changes;
  }
}
