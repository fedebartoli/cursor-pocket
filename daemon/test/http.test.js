import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { b64u } from '../src/util.js';
import { QUESTION_PARAMS, approvingConversation, askingConversation } from './helpers/fixture.js';
import { T0, startHarness } from './helpers/harness.js';

const ID = 'chat-0000-0001';

/** Chat with a live question (visible in state after one tick). */
function withQuestion(h, { toolCallId = 'tc-1' } = {}) {
  h.fx.chat(ID, { name: 'Titolo di prova', lastUpdatedAt: T0 - 1000, header: { hasBlockingPendingActions: true } });
  askingConversation(h.fx, ID, { toolCallId, at: T0 - 2000 });
}

function validSub(host = 'web.push.apple.com') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: `https://${host}/wpush/v2/token-${crypto.randomBytes(4).toString('hex')}`, keys: { p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(crypto.randomBytes(16)) } };
}

test('public: healthz, disallowed Host, anomalous URLs, no access without session', async () => {
  const h = await startHarness();
  try {
    assert.equal((await h.req({ path: '/healthz' })).status, 200);
    assert.equal((await h.req({ path: '/healthz', headers: { Host: 'evil.example.com' } })).status, 421, 'DNS rebinding');
    assert.equal((await h.req({ path: '/healthz', headers: { Host: 'macbook.tail1234.ts.net' } })).status, 200);
    assert.equal((await h.req({ path: '//evil.example.com/x' })).status, 400);
    for (const p of ['/api/state', '/api/events', '/api/info', `/api/chats/${ID}`, '/api/push/public-key']) {
      assert.equal((await h.req({ path: p })).status, 401, p);
    }
    assert.equal((await h.req({ method: 'POST', path: '/api/push/test', body: {} })).status, 401);
    assert.deepEqual((await h.req({ path: '/api/session' })).json(), { authenticated: false });
  } finally {
    await h.stop();
  }
});

test('pairing: HttpOnly/SameSite=Strict cookie, Secure only over HTTPS, one-time code, lockout after too many failures', async () => {
  const h = await startHarness();
  try {
    const { code } = h.app.auth.createPairingCode();
    const bad = await h.req({ method: 'POST', path: '/api/pair', body: { code: 'AAAA-AAAA' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json().error, 'invalid_code');

    const ok = await h.req({ method: 'POST', path: '/api/pair', body: { code } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/, 'no Secure on local HTTP');
    assert.deepEqual((await h.req({ path: '/api/session', cookie: cookie.split(';')[0] })).json(), { authenticated: true });
    assert.equal((await h.req({ method: 'POST', path: '/api/pair', body: { code } })).status, 401, 'one-time use');

    const viaTs = h.app.auth.createPairingCode().code;
    const secure = await h.req({ method: 'POST', path: '/api/pair', body: { code: viaTs }, headers: { Host: 'macbook.tail1234.ts.net' } });
    assert.match(secure.headers['set-cookie'][0], /; Secure$/);
    assert.match(secure.headers['strict-transport-security'], /max-age=/);

    // 5 consecutive failures -> 429 with Retry-After, even for a correct code
    const fresh = h.app.auth.createPairingCode().code;
    let last;
    for (let i = 0; i < 6; i++) last = await h.req({ method: 'POST', path: '/api/pair', body: { code: 'ZZZZ-ZZZZ' } });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers['retry-after']) > 0);
    assert.equal((await h.req({ method: 'POST', path: '/api/pair', body: { code: fresh } })).status, 429);
  } finally {
    await h.stop();
  }
});

test('state and Ignore: ignored request moves to pending; stale key = 409; restore', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    h.tick();
    withQuestion(h);
    h.tick();
    const s1 = (await h.req({ path: '/api/state', cookie })).json();
    assert.deepEqual(s1.state.counts, { attention: 1, pending: 0, running: 0, total: 1 });
    const card = s1.state.attention[0];
    assert.equal(card.attention.kind, 'domanda');
    assert.equal(card.attention.prompt, QUESTION_PARAMS.questions[0].prompt);

    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/ignore`, cookie, body: { key: 'altra-chiave' } })).status, 409);
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/ignore`, cookie, body: {} })).status, 400);
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/ignore`, cookie, body: { key: card.attention.key } })).status, 200);

    const s2 = (await h.req({ path: '/api/state', cookie })).json();
    assert.deepEqual(s2.state.counts, { attention: 0, pending: 1, running: 0, total: 1 });
    assert.equal(s2.state.pending[0].attention.reason, 'ignorata');
    assert.ok(s2.version > s1.version);

    // same chat asks a NEW question: dot reappears
    h.fx.chat(ID, { lastUpdatedAt: T0 + 5000 });
    askingConversation(h.fx, ID, { toolCallId: 'tc-2', at: T0 + 4000 });
    h.tick();
    const s3 = (await h.req({ path: '/api/state', cookie })).json();
    assert.deepEqual(s3.state.counts.attention, 1);
    assert.equal(s3.state.attention[0].attention.key, 'tc-2');

    // restore old ignore (idempotent)
    assert.equal((await h.req({ method: 'DELETE', path: `/api/chats/${ID}/ignore`, cookie, body: { key: card.attention.key } })).status, 200);
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/zzzzzzzz-nuova/ignore`, cookie, body: { key: 'x' } })).status, 404);
  } finally {
    await h.stop();
  }
});

test('chat detail: question with options and last message; invalid id', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    withQuestion(h);
    h.tick();
    const d = (await h.req({ path: `/api/chats/${ID}`, cookie })).json();
    assert.equal(d.chat.id, ID);
    assert.equal(d.question.questions[0].options.length, 2);
    assert.equal((await h.req({ path: '/api/chats/id%20non%20valido', cookie })).status, 400);
  } finally {
    await h.stop();
  }
});

test('CSRF and body validation: wrong Origin, wrong Content-Type, body too large, broken JSON', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    withQuestion(h);
    h.tick();
    const url = `/api/chats/${ID}/ignore`;
    const key = (await h.req({ path: '/api/state', cookie })).json().state.attention[0].attention.key;
    assert.equal((await h.req({ method: 'POST', path: url, cookie, body: { key }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await h.req({ method: 'POST', path: '/api/pair', body: { code: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await h.req({ method: 'POST', path: url, cookie, body: `{"key":"${key}"}`, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await h.req({ method: 'POST', path: url, cookie, body: '{rotto', headers: { 'Content-Type': 'application/json' } })).status, 400);
    const huge = JSON.stringify({ key: 'x'.repeat(20_000) });
    assert.equal((await h.req({ method: 'POST', path: url, cookie, body: huge, headers: { 'Content-Type': 'application/json' } })).status, 413);
    // same origin: allowed
    const host = `127.0.0.1:${h.port}`;
    assert.equal((await h.req({ method: 'POST', path: url, cookie, body: { key }, headers: { Origin: `http://${host}`, Host: host } })).status, 200);
  } finally {
    await h.stop();
  }
});

test('push: subscription validation, device limit, unsubscribe, test notification and logout', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    assert.match((await h.req({ path: '/api/push/public-key', cookie })).json().publicKey, /^[\w-]{87}$/, '65 byte in base64url');

    const post = (p, body) => h.req({ method: 'POST', path: p, cookie, body });
    assert.equal((await post('/api/push/subscribe', { subscription: validSub('evil.example.com') })).status, 400, 'non-push host');
    assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'AAAA', auth: 'AAAA' } } })).status, 400);
    assert.equal((await post('/api/push/subscribe', {})).status, 400);

    const sub = validSub();
    assert.equal((await post('/api/push/subscribe', { subscription: sub })).status, 200);
    assert.equal((await post('/api/push/subscribe', { subscription: sub })).status, 200, 'idempotent');
    assert.equal(h.app.store.countSubscriptions(), 1);
    assert.deepEqual((await post('/api/push/status', { endpoint: sub.endpoint })).json(), { subscribed: true, total: 1 });

    const test1 = await post('/api/push/test', {});
    assert.deepEqual(test1.json(), { sent: 1, failed: 0, removed: 0 });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].subscription.endpoint, sub.endpoint);
    assert.equal((await post('/api/push/test', {})).status, 429, 'one test notification every 5 seconds');

    for (let i = 0; i < 9; i++) assert.equal((await post('/api/push/subscribe', { subscription: validSub() })).status, 200);
    assert.equal((await post('/api/push/subscribe', { subscription: validSub() })).status, 409, 'max 10 devices');

    assert.equal((await post('/api/push/unsubscribe', { endpoint: sub.endpoint })).status, 200);
    assert.equal(h.app.store.countSubscriptions(), 9);

    const lo = await post('/api/logout', {});
    assert.equal(lo.status, 200);
    assert.match(lo.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal(h.app.store.countSubscriptions(), 0, 'logout removes session subscriptions');
    assert.equal((await h.req({ path: '/api/state', cookie })).status, 401);
  } finally {
    await h.stop();
  }
});

test('notifications end-to-end: new question -> one push; chat finished -> one push; no push for initial state', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    await h.req({ method: 'POST', path: '/api/push/subscribe', cookie, body: { subscription: validSub() } });
    // initial state: one stale chat
    h.fx.chat('residuo-00001', { name: 'Vecchia', lastUpdatedAt: T0 - 5000, header: { hasBlockingPendingActions: true } });
    h.tick();
    h.tick();
    assert.equal(h.sent.length, 0);
    // new question
    withQuestion(h);
    h.tick();
    await new Promise((r) => setImmediate(r));
    h.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sent.length, 1);
    const payload = JSON.parse(h.sent[0].payload);
    assert.equal(payload.title, 'Domanda in attesa');
    assert.equal(payload.url, `/#/chat/${ID}`);
    assert.equal(payload.badge, 2, 'badge = chats needing attention (stale included)');
  } finally {
    await h.stop();
  }
});

test('push: pending approval = notification with action TYPE, never the command; then badge counts it too', async () => {
  const h = await startHarness({ configOverrides: { approvalDelayMs: 5000 } });
  try {
    const cookie = await h.pair();
    await h.req({ method: 'POST', path: '/api/push/subscribe', cookie, body: { subscription: validSub() } });
    h.fx.chat(ID, { name: 'Migrazione', lastUpdatedAt: T0 - 1000, header: { unfinishedRunAt: T0 - 30_000 } });
    h.tick();
    approvingConversation(h.fx, ID, { at: T0 + 500, composerStatus: 'aborted' });
    h.tick();
    h.tick(4000);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sent.length, 0, 'below delay: no notification');
    h.tick(2000);
    await new Promise((r) => setImmediate(r));
    h.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sent.length, 1);
    const payload = JSON.parse(h.sent[0].payload);
    assert.equal(payload.title, 'Approvazione richiesta');
    assert.equal(payload.kind, 'approvazione');
    assert.match(payload.body, /Migrazione/);
    assert.match(payload.body, /Comando da eseguire/);
    assert.equal(payload.url, `/#/chat/${ID}`);
    assert.equal(h.sent[0].payload.includes('echo prova'), false, 'command never leaves the daemon');
    assert.equal(payload.badge, 1);
    // timings in log (numbers only): from request start to notification, including 5 s delay
    const sentLog = h.logLines.map((l) => JSON.parse(l)).find((l) => l.event === 'push_sent' && l.kind === 'approvazione');
    assert.ok(sentLog, 'push_sent with notification kind');
    assert.ok(Number.isFinite(sentLog.detectMs) && sentLog.detectMs >= 5000, `detectMs=${sentLog.detectMs}`);
    assert.ok(Number.isFinite(sentLog.sendMs));
    const st = (await h.req({ path: '/api/state', cookie })).json();
    assert.equal(st.state.attention[0].attention.kind, 'approvazione');
    assert.equal(st.state.attention[0].attention.detail, 'Comando da eseguire');
  } finally {
    await h.stop();
  }
});

test('SSE: initial state and push update when something changes', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    withQuestion(h);
    h.tick();
    const frames = [];
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/events', headers: { Cookie: cookie } }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
        let buf = '';
        res.on('data', async (c) => {
          buf += c.toString();
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const p of parts) if (p.startsWith('event: state')) frames.push(JSON.parse(p.split('data: ')[1]));
          if (frames.length === 1) {
            const key = frames[0].state.attention[0].attention.key;
            await h.req({ method: 'POST', path: `/api/chats/${ID}/ignore`, cookie, body: { key } });
          }
          if (frames.length >= 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
      req.end();
      setTimeout(() => reject(new Error('timeout SSE')), 4000).unref();
    });
    assert.equal(frames[0].state.counts.attention, 1);
    assert.equal(frames[1].state.counts.attention, 0);
    assert.ok(frames[1].version > frames[0].version);
  } finally {
    await h.stop();
  }
});

test('static files: security headers, ETag/304, sw.js with build id, path traversal and hidden files blocked', async () => {
  const h = await startHarness({
    files: {
      '.nascosto': 'segreto',
      'css/app.css': 'body{}',
      'LICENSE.txt': 'licenza',
      "strano'.js": 'x',
      'sw.js': "const B='__BUILD_ID__'; const L='__PRECACHE__';",
    },
  });
  try {
    const idx = await h.req({ path: '/' });
    assert.equal(idx.status, 200);
    assert.match(idx.headers['content-type'], /text\/html/);
    assert.match(idx.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(idx.headers['x-content-type-options'], 'nosniff');
    assert.equal(idx.headers['x-frame-options'], 'DENY');
    assert.equal(idx.headers['cache-control'], 'no-cache');

    const again = await h.req({ path: '/', headers: { 'If-None-Match': idx.headers.etag } });
    assert.equal(again.status, 304);

    const sw = await h.req({ path: '/sw.js' });
    assert.match(sw.text, /const B='[0-9a-f]{12}';/);
    // Precache list: index as "/", no worker, licenses, hidden files or names that would break the literal.
    assert.match(sw.text, /const L='\["\/","\/app\.js","\/css\/app\.css"\]';/);
    assert.equal(sw.headers['service-worker-allowed'], '/');
    assert.equal((await h.req({ path: '/css/app.css' })).headers['content-type'], 'text/css; charset=utf-8');

    for (const p of ['/..%2ffuori.txt', '/%2e%2e/fuori.txt', '/.nascosto', '/css/..%2f..%2ffuori.txt', '/%00', '/inesistente.js', '/css']) {
      const r = await h.req({ path: p });
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /SEGRETO/);
    }
    assert.equal((await h.req({ method: 'POST', path: '/' })).status, 405);
  } finally {
    await h.stop();
  }
});

test('optional Tailscale guard: only allowed logins (blocks Funnel too, which does not carry identity)', async () => {
  const h = await startHarness({ configOverrides: { allowedTailscaleLogins: ['io@example.com'] } });
  try {
    assert.equal((await h.req({ path: '/' })).status, 403);
    assert.equal((await h.req({ path: '/', headers: { 'Tailscale-User-Login': 'altro@example.com' } })).status, 403);
    assert.equal((await h.req({ path: '/', headers: { 'Tailscale-User-Login': 'IO@example.com' } })).status, 200);
    assert.equal((await h.req({ path: '/healthz' })).status, 200, 'healthz exposes nothing sensitive');
  } finally {
    await h.stop();
  }
});

test('no secrets or chat content in logs', async () => {
  const h = await startHarness();
  try {
    const { code } = h.app.auth.createPairingCode();
    const paired = await h.req({ method: 'POST', path: '/api/pair', body: { code } });
    const cookie = paired.headers['set-cookie'][0].split(';')[0];
    const token = cookie.split('=')[1];
    const sub = validSub();
    await h.req({ method: 'POST', path: '/api/push/subscribe', cookie, body: { subscription: sub } });
    await h.req({ method: 'POST', path: '/api/pair', body: { code: 'AAAA-AAAA' } });

    h.fx.chat('segreta-00001', { name: 'TITOLO-SEGRETO-XYZ', subtitle: 'SOTTOTITOLO-SEGRETO', path: '/Users/demo/CARTELLA-SEGRETA', lastUpdatedAt: T0 - 500, header: { hasBlockingPendingActions: true } });
    h.fx.conversation('segreta-00001', [
      { id: 'b1', type: 2, createdAt: T0 - 600, text: 'RISPOSTA-SEGRETA' },
      { id: 'b2', type: 2, createdAt: T0 - 500, tool: { name: 'ask_question', status: 'loading', toolCallId: 'tc-segreto', params: { title: 'DOMANDA-SEGRETA', questions: [{ id: 'q', prompt: 'PROMPT-SEGRETO', options: [] }] } } },
    ]);
    h.tick();
    await new Promise((r) => setImmediate(r));
    h.tick();
    await h.req({ method: 'POST', path: '/api/push/test', cookie, body: {} });
    await h.req({ path: '/api/chats/segreta-00001', cookie });

    const logs = h.logLines.join('');
    assert.ok(logs.length > 0, 'daemon logs operational events');
    for (const secret of ['TITOLO-SEGRETO', 'SOTTOTITOLO', 'CARTELLA-SEGRETA', 'RISPOSTA-SEGRETA', 'DOMANDA-SEGRETA', 'PROMPT-SEGRETO', 'tc-segreto', code.replace('-', ''), code, token, sub.endpoint, sub.keys.p256dh, sub.keys.auth, 'vapid_private', '"d":']) {
      assert.equal(logs.includes(secret), false, `log must not contain: ${secret.slice(0, 12)}...`);
    }
  } finally {
    await h.stop();
  }
});

test('per-chat prefs: favorite and muted saved in daemon, appear in state and do not touch Cursor', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    h.fx.chat(ID, { name: 'Migrazione', lastUpdatedAt: T0 - 1000 });
    h.tick();
    const card = async () => (await h.req({ path: '/api/state', cookie })).json().state.workspaces[0].chats[0];
    assert.equal((await card()).favorite, false);
    const r = await h.req({ method: 'POST', path: `/api/chats/${ID}/prefs`, cookie, body: { favorite: true } });
    assert.deepEqual(r.json(), { ok: true, favorite: true, muted: false });
    h.tick();
    assert.equal((await card()).favorite, true);
    // omitted field stays as-is
    const m = await h.req({ method: 'POST', path: `/api/chats/${ID}/prefs`, cookie, body: { muted: true } });
    assert.deepEqual(m.json(), { ok: true, favorite: true, muted: true });
    const off = await h.req({ method: 'POST', path: `/api/chats/${ID}/prefs`, cookie, body: { favorite: false } });
    assert.deepEqual(off.json(), { ok: true, favorite: false, muted: true });
    // validation
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/prefs`, cookie, body: { favorite: 'si' } })).json().error, 'bad_prefs');
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/prefs`, cookie, body: {} })).json().error, 'bad_prefs');
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/chat-inesistente-9/prefs`, cookie, body: { favorite: true } })).status, 404);
  } finally {
    await h.stop();
  }
});

async function newQuestionPush(h, cookie, { mute, quiet } = {}) {
  await h.req({ method: 'POST', path: '/api/push/subscribe', cookie, body: { subscription: validSub() } });
  h.fx.chat(ID, { name: 'Migrazione', lastUpdatedAt: T0 - 1000 });
  h.tick();
  h.tick();
  if (mute) await h.req({ method: 'POST', path: mute.path, cookie, body: { muted: true } });
  if (quiet) assert.equal((await h.req({ method: 'POST', path: '/api/settings/quiet', cookie, body: quiet })).status, 200);
  withQuestion(h);
  h.tick();
  await new Promise((r) => setImmediate(r));
  h.tick();
  await new Promise((r) => setImmediate(r));
}

test('mute: muted chat gets no push; log states reason only', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    await newQuestionPush(h, cookie, { mute: { path: `/api/chats/${ID}/prefs` } });
    assert.equal(h.sent.length, 0);
    assert.ok(h.logLines.some((l) => l.includes('push_skipped') && l.includes('chat silenziata')));
  } finally {
    await h.stop();
  }
});

test('mute: muted workspace gets no push', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    await h.req({ method: 'POST', path: '/api/push/subscribe', cookie, body: { subscription: validSub() } });
    h.fx.chat(ID, { name: 'Migrazione', lastUpdatedAt: T0 - 1000 });
    h.tick();
    const ws = (await h.req({ path: '/api/state', cookie })).json().state.workspaces[0];
    assert.equal(ws.muted, false);
    const r = await h.req({ method: 'POST', path: `/api/workspaces/${ws.id}/prefs`, cookie, body: { muted: true } });
    assert.deepEqual(r.json(), { ok: true, muted: true });
    h.tick();
    assert.equal((await h.req({ path: '/api/state', cookie })).json().state.workspaces[0].muted, true);
    withQuestion(h);
    h.tick();
    await new Promise((r2) => setImmediate(r2));
    h.tick();
    await new Promise((r2) => setImmediate(r2));
    assert.equal(h.sent.length, 0);
    assert.equal((await h.req({ method: 'POST', path: '/api/workspaces/sconosciuto/prefs', cookie, body: { muted: true } })).status, 404);
    assert.equal((await h.req({ method: 'POST', path: `/api/workspaces/${ws.id}/prefs`, cookie, body: { muted: 'si' } })).status, 400);
  } finally {
    await h.stop();
  }
});

test('quiet hours: no push inside window, yes outside; validation and read', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    const q = (await h.req({ path: '/api/settings/quiet', cookie })).json();
    assert.deepEqual(q, { enabled: false, from: '22:00', to: '07:00' });
    assert.equal((await h.req({ method: 'POST', path: '/api/settings/quiet', cookie, body: { enabled: true, from: '25:00', to: '07:00' } })).status, 400);
    assert.equal((await h.req({ method: 'POST', path: '/api/settings/quiet', cookie, body: { enabled: 'si' } })).status, 400);
    // window that always contains test instant: 00:00–23:59 minus one minute is not enough, use current local hour
    const d = new Date(T0);
    const hh = (n) => String(n).padStart(2, '0');
    const from = `${hh(d.getHours())}:00`;
    const to = `${hh((d.getHours() + 1) % 24)}:00`;
    await newQuestionPush(h, cookie, { quiet: { enabled: true, from, to } });
    assert.equal(h.sent.length, 0, 'quiet');
    assert.ok(h.logLines.some((l) => l.includes('orario senza notifiche')));
  } finally {
    await h.stop();
  }

  const h2 = await startHarness();
  try {
    const cookie = await h2.pair();
    const d = new Date(T0);
    const hh = (n) => String(n).padStart(2, '0');
    // window that does NOT contain instant: starts two hours later
    const from = `${hh((d.getHours() + 2) % 24)}:00`;
    const to = `${hh((d.getHours() + 3) % 24)}:00`;
    await newQuestionPush(h2, cookie, { quiet: { enabled: true, from, to } });
    assert.equal(h2.sent.length, 1, 'outside window: delivered');
  } finally {
    await h2.stop();
  }
});

test('paired devices: list without secrets, revoke another device (not current), session and notifications removed', async () => {
  const h = await startHarness();
  try {
    const mine = await h.pair();
    const { code } = h.app.auth.createPairingCode();
    const other = await h.req({ method: 'POST', path: '/api/pair', body: { code, label: 'iPad' } });
    const otherCookie = other.headers['set-cookie'][0].split(';')[0];

    const list = (await h.req({ path: '/api/devices', cookie: mine })).json().devices;
    assert.equal(list.length, 2);
    assert.equal(list.filter((d) => d.current).length, 1);
    const ipad = list.find((d) => d.label === 'iPad');
    assert.ok(ipad && ipad.current === false && /^[0-9a-f]{16}$/.test(ipad.id));
    const raw = JSON.stringify(list);
    assert.ok(!raw.includes(otherCookie.split('=')[1]), 'token never exposed');
    assert.ok(!/tokenHash|token_hash/.test(raw));

    // without session: 401
    assert.equal((await h.req({ path: '/api/devices' })).status, 401);
    // current device cannot be revoked from here
    const cur = list.find((d) => d.current);
    const r1 = await h.req({ method: 'POST', path: `/api/devices/${cur.id}/revoke`, cookie: mine, body: {} });
    assert.equal(r1.status, 409);
    assert.equal(r1.json().error, 'current_device');
    assert.equal((await h.req({ method: 'POST', path: '/api/devices/0000000000000000/revoke', cookie: mine, body: {} })).status, 404);

    // other device works, then is revoked
    assert.equal((await h.req({ path: '/api/state', cookie: otherCookie })).status, 200);
    const r2 = await h.req({ method: 'POST', path: `/api/devices/${ipad.id}/revoke`, cookie: mine, body: {} });
    assert.equal(r2.status, 200);
    assert.equal((await h.req({ path: '/api/state', cookie: otherCookie })).status, 401);
    assert.equal((await h.req({ path: '/api/devices', cookie: mine })).json().devices.length, 1);
  } finally {
    await h.stop();
  }
});

test('conversation: pages from bottom, tools as rows without params, truncated text, validated params, no content in logs', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    const ID = '11111111-1111-4111-8111-111111111111';
    h.fx.chat(ID, { name: 'Lunga', lastUpdatedAt: T0 - 1000 });
    const bubbles = [];
    for (let i = 0; i < 70; i++) {
      if (i % 5 === 3) bubbles.push({ id: `b${i}`, type: 2, createdAt: T0 - 100_000 + i * 1000, tool: { name: 'run_terminal_command_v2', status: 'completed', toolCallId: `t${i}`, params: { command: 'rm -rf SEGRETO' } } });
      else if (i % 5 === 4) bubbles.push({ id: `b${i}`, type: 2, createdAt: T0 - 100_000 + i * 1000, text: '' });
      else bubbles.push({ id: `b${i}`, type: i % 2 === 0 ? 1 : 2, createdAt: T0 - 100_000 + i * 1000, text: `testo ${i}${i === 67 ? ' ' + 'x'.repeat(7000) : ''}` });
    }
    h.fx.conversation(ID, bubbles);
    h.tick();
    const get = (q = '') => h.req({ path: `/api/chats/${ID}/history${q}`, cookie });

    const first = await get('?limit=20');
    assert.equal(first.status, 200, first.text);
    const p1 = first.json();
    assert.equal(p1.total, 70);
    assert.equal(p1.from, 50);
    assert.equal(p1.hasMore, true);
    assert.ok(p1.items.every((i) => i.index >= 50 && i.index < 70));
    assert.ok(p1.items.every((i, k, a) => k === 0 || a[k - 1].index < i.index), 'chronological order');
    assert.ok(!p1.items.some((i) => i.role !== 'tool' && !i.text), 'empty bubbles skipped');
    const tool = p1.items.find((i) => i.role === 'tool');
    assert.equal(tool.label, 'Esegue un comando');
    assert.ok(!JSON.stringify(p1).includes('SEGRETO'), 'no command in payload');
    const last = p1.items.find((i) => i.index === 67);
    assert.equal(last.text.length, 6000);
    assert.equal(last.truncated, true);
    assert.equal(last.role, 'assistant');

    const second = (await get('?before=50&limit=60')).json();
    assert.equal(second.from, 0);
    assert.equal(second.hasMore, false);
    assert.ok(second.items.every((i) => i.index < 50));
    assert.equal((await get('?before=0')).json().items.length, 0);

    assert.equal((await get('?before=abc')).status, 400);
    assert.equal((await get('?limit=-1')).status, 400);
    assert.equal((await h.req({ path: '/api/chats/22222222-2222-4222-8222-222222222222/history', cookie })).status, 404);
    assert.equal((await h.req({ path: `/api/chats/${ID}/history` })).status, 401);
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/history`, cookie, body: {} })).status, 405);
  } finally {
    await h.stop();
  }
});
