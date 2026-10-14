import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Auth, clearedCookie, normalizeCode, parseCookies, sessionCookie } from '../src/auth.js';
import { createLogger, errorFields, sanitizeFields } from '../src/log.js';
import { Notifier } from '../src/push/notifier.js';
import { Store } from '../src/state/store.js';
import { loadConfig } from '../src/config.js';
import { sha256Hex } from '../src/util.js';
import { nullLogger, tmpDir } from './helpers/fixture.js';

// ---------- log ----------
test('log: safe by design - strings pass only for allow-listed keys', () => {
  const out = sanitizeFields({
    reason: 'invalid', kind: 'done', host: '127.0.0.1', // allowed keys
    name: 'Titolo segreto', dettaglio: 'qualunque stringa', token: 't', endpoint: 'https://e', message: 'm', // NOT allowed
    ok: true, n: 3, nulla: null, o: { a: 1 }, a: ['x'], long: 'y'.repeat(500),
  });
  assert.deepEqual({ reason: out.reason, kind: out.kind, host: out.host }, { reason: 'invalid', kind: 'done', host: '127.0.0.1' });
  for (const k of ['name', 'dettaglio', 'token', 'endpoint', 'message', 'o', 'a', 'long']) assert.equal(out[k], '[omitted]', k);
  assert.deepEqual({ ok: out.ok, n: out.n, nulla: out.nulla }, { ok: true, n: 3, nulla: null });
  assert.ok(sanitizeFields({ reason: 'y'.repeat(500) }).reason.length <= 80, 'allowed values are truncated too');
});

test('log: errors logged with name and code, never the message', () => {
  const err = Object.assign(new SyntaxError('Unexpected token \'S\', "SEGRETO-NEL-JSON" is not valid JSON'), { code: 'X_CODE' });
  assert.deepEqual(errorFields(err), { error: 'SyntaxError', errcode: 'X_CODE' });
  assert.equal(JSON.stringify(errorFields(err)).includes('SEGRETO'), false);
  assert.deepEqual(errorFields(null), { error: 'Error', errcode: '' });
});

test('log: JSON lines with t/lvl/event not overwritable, and level filter', () => {
  const lines = [];
  const log = createLogger({ level: 'info', stream: { write: (s) => lines.push(s) }, now: () => new Date('2026-01-01T00:00:00Z') });
  log.debug('nascosto');
  log.info('push_sent', { event: 'tentativo di sovrascrittura', lvl: 'x', sent: 2 }); // string `event`/`lvl` not allowed
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.deepEqual(rec, { t: '2026-01-01T00:00:00.000Z', lvl: 'info', event: 'push_sent', sent: 2 });
});

// ---------- config ----------
test('config: safe defaults (loopback only) and value validation', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.pendingAfterMs, 24 * 3_600_000);
  assert.equal(loadConfig({ CP_PENDING_AFTER_HOURS: '0' }).pendingAfterMs, 0);
  assert.equal(loadConfig({ CP_PORT: '99999' }).port, 65535);
  assert.throws(() => loadConfig({ CP_PORT: 'abc' }), /CP_PORT/);
  assert.equal(loadConfig({ CP_INCLUDE_CLASSIC: 'no' }).includeClassicChats, false);
  assert.deepEqual(loadConfig({ CP_ALLOWED_TS_LOGINS: ' a@x.it , b@x.it ' }).allowedTailscaleLogins, ['a@x.it', 'b@x.it']);
  assert.throws(() => {
    loadConfig({}).host = '0.0.0.0'; // config is frozen: cannot expose daemon by mistake
  }, TypeError);
});

// ---------- store ----------
test('store: 0700/0600 permissions, ignored, notified, subscriptions', () => {
  const dir = path.join(tmpDir(), 'data');
  const file = path.join(dir, 'store.db');
  const s = new Store(file);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  s.addIgnored('c1', 'k1', 1);
  s.addIgnored('c1', 'k1', 2); // idempotent
  s.addIgnored('c2', 'k1', 3);
  assert.deepEqual([...s.ignoredSet()].sort(), ['c1|k1', 'c2|k1']);
  assert.equal(s.removeIgnored('c1', 'k1'), true);
  assert.equal(s.removeIgnored('c1', 'k1'), false);
  assert.equal(s.pruneIgnored(10), 1);

  assert.equal(s.hasNotified('x'), false);
  s.markNotified('x', 5);
  s.markNotified('x', 6);
  assert.equal(s.hasNotified('x'), true);
  assert.equal(s.pruneNotified(100), 1);

  s.upsertSubscription({ endpoint: 'https://web.push.apple.com/1', p256dh: 'p', auth: 'a' }, 'sess1', 1);
  s.upsertSubscription({ endpoint: 'https://web.push.apple.com/1', p256dh: 'p2', auth: 'a2' }, 'sess1', 2);
  assert.equal(s.countSubscriptions(), 1);
  assert.equal(s.listSubscriptions()[0].p256dh, 'p2');
  assert.equal(s.removeSubscriptionsOfSession('sess1'), 1);
  s.close();
});

// ---------- auth ----------
function authSetup() {
  const store = new Store(':memory:');
  const clock = { t: 1_700_000_000_000 };
  const config = loadConfig({});
  const auth = new Auth({ store, config, now: () => clock.t });
  return { store, clock, auth, config };
}

test('auth: code is single-use, expires and only hash is stored', () => {
  const { store, clock, auth, config } = authSetup();
  const { code, expiresAt } = auth.createPairingCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(expiresAt, clock.t + config.pairingTtlMs);
  assert.equal(store.consumePairingCode(sha256Hex('XXXXXXXX'), clock.t), false);

  const ok = auth.pair(code.toLowerCase().replace('-', ' '));
  assert.equal(ok.ok, true);
  assert.equal(auth.pair(code).ok, false, 'reuse rejected');
  assert.ok(auth.authenticate(`${sessionCookie(ok.token, {}).split(';')[0]}`));

  const second = auth.createPairingCode();
  clock.t += config.pairingTtlMs + 1;
  assert.equal(auth.pair(second.code).ok, false, 'expired');
  store.close();
});

test('auth: after 5 wrong attempts blocks even with correct code, then unblocks', () => {
  const { store, clock, auth } = authSetup();
  const { code } = auth.createPairingCode();
  for (let i = 0; i < 5; i++) assert.equal(auth.pair('AAAA-AAAA').reason, 'invalid');
  const blocked = auth.pair(code);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'rate_limited');
  assert.ok(blocked.retryAfterMs > 0);
  clock.t += 10 * 60_000 + 1;
  assert.equal(auth.pair(code).ok, true);
  store.close();
});

test('auth: invalid session, inactivity expiry and logout', () => {
  const { store, clock, auth } = authSetup();
  const { code } = auth.createPairingCode();
  const { token } = auth.pair(code);
  const cookie = `cp_session=${token}`;
  assert.equal(auth.authenticate('cp_session=abc'), null);
  assert.equal(auth.authenticate(undefined), null);
  assert.equal(auth.authenticate('altro=1'), null);
  const s = auth.authenticate(cookie);
  assert.ok(s);
  store.upsertSubscription({ endpoint: 'https://web.push.apple.com/1', p256dh: 'p', auth: 'a' }, s.tokenHash, clock.t);
  assert.equal(auth.logout(s.tokenHash), true);
  assert.equal(store.countSubscriptions(), 0, 'logout removes session subscriptions');
  assert.equal(auth.authenticate(cookie), null);

  const { token: t2 } = auth.pair(auth.createPairingCode().code);
  clock.t += 91 * 24 * 3_600_000;
  assert.equal(auth.authenticate(`cp_session=${t2}`), null, 'expired after 90 days of inactivity');
  store.close();
});

test('auth: helpers for codes and cookies', () => {
  assert.equal(normalizeCode(' ab12-cd34 '), 'AB12CD34');
  assert.deepEqual(parseCookies('a=1; b=2=3; ;c'), { a: '1', b: '2=3' });
  assert.match(sessionCookie('tok', { secure: true }), /^cp_session=tok; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(sessionCookie('tok', { secure: false }), /Secure/);
  assert.match(clearedCookie({ secure: false }), /Max-Age=0/);
});

// ---------- notifier ----------
function notifierSetup({ send, subs = 1 } = {}) {
  const store = new Store(':memory:');
  const config = loadConfig({});
  const calls = [];
  const sleeps = [];
  const fakeSend = send ?? (async (p) => {
    calls.push(p);
    return { ok: true, status: 201 };
  });
  const notifier = new Notifier({ store, config, logger: nullLogger, send: fakeSend, sleep: async (ms) => sleeps.push(ms), badge: () => 3 });
  for (let i = 0; i < subs; i++) store.upsertSubscription({ endpoint: `https://web.push.apple.com/${i}`, p256dh: 'p', auth: 'a' }, null, 1);
  return { store, notifier, calls, sleeps };
}

const EV = (over = {}) => ({
  type: 'attention',
  dedupeKey: 'a:c1:tc1',
  chat: { id: 'chat-id-0001', name: 'Titolo chat', workspaceName: 'app' },
  attention: { kind: 'question', toolName: 'ask_question', title: 'Come procedo?', prompt: 'Quale approccio?' },
  ...over,
});

test('notifier: messages for question, unknown type (generic), chat done; badge and destination', () => {
  const { notifier } = notifierSetup();
  const q = notifier.compose(EV());
  assert.deepEqual({ title: q.title, kind: q.kind, tag: q.tag, url: q.url, badge: q.badge }, { title: 'Domanda in attesa', kind: 'question', tag: 'chat-chat-id-0001', url: '/#/chat/chat-id-0001', badge: 3 });
  assert.match(q.body, /Titolo chat - app\nCome procedo\?/);
  const generic = notifier.compose(EV({ attention: { kind: 'sconosciuto', toolName: 'run_terminal_command_v2' } }));
  assert.deepEqual({ title: generic.title, kind: generic.kind }, { title: 'Richiede attenzione', kind: 'attention' });
  assert.equal(generic.body.includes('run_terminal_command_v2'), false, 'tool name must not appear in notification');
  const d = notifier.compose({ type: 'done', dedupeKey: 'd', chat: EV().chat });
  assert.equal(d.title, 'Chat finita');
  assert.equal(d.kind, 'done');
  assert.ok(Buffer.byteLength(JSON.stringify(notifier.compose(EV({ chat: { id: 'x', name: 'n'.repeat(5000), workspaceName: 'w'.repeat(5000) }, attention: { kind: 'question', title: 't'.repeat(5000) } })))) < 3000, 'payload stays well under push limit');
});

test('notifier: sends to all subscriptions, once per dedupeKey', async () => {
  const { notifier, calls } = notifierSetup({ subs: 2 });
  const r1 = await notifier.notify(EV());
  assert.deepEqual(r1, { sent: 2, failed: 0, removed: 0 });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].payload).title, 'Domanda in attesa');
  assert.equal(calls[0].topic, 'chat-chat-id-0001'.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32));
  assert.deepEqual(await notifier.notify(EV()), { skipped: 'duplicato' });
  assert.equal(calls.length, 2);
  assert.equal((await notifier.notify(EV({ dedupeKey: 'a:c1:tc2' }))).sent, 2);
});

test('notifier: expired subscription (410) removed; transient errors retried; no-op without subscriptions', async () => {
  let n = 0;
  const { notifier, store, sleeps } = notifierSetup({
    subs: 2,
    send: async ({ subscription }) => {
      if (subscription.endpoint.endsWith('/0')) return { ok: false, status: 410, gone: true };
      n++;
      return n < 3 ? { ok: false, status: 503 } : { ok: true, status: 201 };
    },
  });
  const r = await notifier.notify(EV());
  assert.deepEqual(r, { sent: 1, failed: 0, removed: 1 });
  assert.equal(store.countSubscriptions(), 1);
  assert.deepEqual(sleeps, [1000, 4000], 'two retries with increasing delay');

  const empty = notifierSetup({ subs: 0 });
  assert.deepEqual(await empty.notifier.sendTest(), { sent: 0, failed: 0, removed: 0 });
});

test('notifier: VAPID keys generated once and reused', () => {
  const store = new Store(':memory:');
  const config = loadConfig({});
  const a = new Notifier({ store, config, logger: nullLogger });
  const pub = a.publicKey;
  assert.equal(Buffer.from(pub, 'base64url').length, 65);
  const b = new Notifier({ store, config, logger: nullLogger });
  assert.equal(b.publicKey, pub);
});
