import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { b64u } from '../src/util.js';
import { QUESTION_PARAMS, approvingConversation, askingConversation } from './helpers/fixture.js';
import { T0, startHarness } from './helpers/harness.js';

const ID = 'chat-0000-0001';

/** Chat con una domanda viva (visibile nello stato dopo un tick). */
function withQuestion(h, { toolCallId = 'tc-1' } = {}) {
  h.fx.chat(ID, { name: 'Titolo di prova', lastUpdatedAt: T0 - 1000, header: { hasBlockingPendingActions: true } });
  askingConversation(h.fx, ID, { toolCallId, at: T0 - 2000 });
}

function validSub(host = 'web.push.apple.com') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: `https://${host}/wpush/v2/token-${crypto.randomBytes(4).toString('hex')}`, keys: { p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(crypto.randomBytes(16)) } };
}

test('pubblico: healthz, Host non consentito, URL anomali, nessun accesso senza sessione', async () => {
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

test('abbinamento: cookie HttpOnly/SameSite=Strict, Secure solo via HTTPS, codice monouso, blocco dopo troppi errori', async () => {
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
    assert.doesNotMatch(cookie, /Secure/, 'su HTTP locale niente Secure');
    assert.deepEqual((await h.req({ path: '/api/session', cookie: cookie.split(';')[0] })).json(), { authenticated: true });
    assert.equal((await h.req({ method: 'POST', path: '/api/pair', body: { code } })).status, 401, 'monouso');

    const viaTs = h.app.auth.createPairingCode().code;
    const secure = await h.req({ method: 'POST', path: '/api/pair', body: { code: viaTs }, headers: { Host: 'macbook.tail1234.ts.net' } });
    assert.match(secure.headers['set-cookie'][0], /; Secure$/);
    assert.match(secure.headers['strict-transport-security'], /max-age=/);

    // 5 errori consecutivi -> 429 con Retry-After, anche per un codice corretto
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

test('stato e Ignora: richiesta ignorata passa a "in sospeso"; chiave non piu\' attuale = 409; ripristino', async () => {
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

    // la stessa chat pone una NUOVA domanda: il pallino ricompare
    h.fx.chat(ID, { lastUpdatedAt: T0 + 5000 });
    askingConversation(h.fx, ID, { toolCallId: 'tc-2', at: T0 + 4000 });
    h.tick();
    const s3 = (await h.req({ path: '/api/state', cookie })).json();
    assert.deepEqual(s3.state.counts.attention, 1);
    assert.equal(s3.state.attention[0].attention.key, 'tc-2');

    // ripristino della vecchia richiesta (idempotente)
    assert.equal((await h.req({ method: 'DELETE', path: `/api/chats/${ID}/ignore`, cookie, body: { key: card.attention.key } })).status, 200);
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/zzzzzzzz-nuova/ignore`, cookie, body: { key: 'x' } })).status, 404);
  } finally {
    await h.stop();
  }
});

test('dettaglio chat: domanda con opzioni e ultimo messaggio; id non valido', async () => {
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

test('CSRF e validazione del corpo: Origin diversa, Content-Type errato, corpo troppo grande, JSON rotto', async () => {
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
    // stessa origine: consentita
    const host = `127.0.0.1:${h.port}`;
    assert.equal((await h.req({ method: 'POST', path: url, cookie, body: { key }, headers: { Origin: `http://${host}`, Host: host } })).status, 200);
  } finally {
    await h.stop();
  }
});

test('push: validazione della sottoscrizione, limite dispositivi, annullamento, notifica di prova e logout', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    assert.match((await h.req({ path: '/api/push/public-key', cookie })).json().publicKey, /^[\w-]{87}$/, '65 byte in base64url');

    const post = (p, body) => h.req({ method: 'POST', path: p, cookie, body });
    assert.equal((await post('/api/push/subscribe', { subscription: validSub('evil.example.com') })).status, 400, 'host non push');
    assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'AAAA', auth: 'AAAA' } } })).status, 400);
    assert.equal((await post('/api/push/subscribe', {})).status, 400);

    const sub = validSub();
    assert.equal((await post('/api/push/subscribe', { subscription: sub })).status, 200);
    assert.equal((await post('/api/push/subscribe', { subscription: sub })).status, 200, 'idempotente');
    assert.equal(h.app.store.countSubscriptions(), 1);
    assert.deepEqual((await post('/api/push/status', { endpoint: sub.endpoint })).json(), { subscribed: true, total: 1 });

    const test1 = await post('/api/push/test', {});
    assert.deepEqual(test1.json(), { sent: 1, failed: 0, removed: 0 });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].subscription.endpoint, sub.endpoint);
    assert.equal((await post('/api/push/test', {})).status, 429, 'una notifica di prova ogni 5 secondi');

    for (let i = 0; i < 9; i++) assert.equal((await post('/api/push/subscribe', { subscription: validSub() })).status, 200);
    assert.equal((await post('/api/push/subscribe', { subscription: validSub() })).status, 409, 'massimo 10 dispositivi');

    assert.equal((await post('/api/push/unsubscribe', { endpoint: sub.endpoint })).status, 200);
    assert.equal(h.app.store.countSubscriptions(), 9);

    const lo = await post('/api/logout', {});
    assert.equal(lo.status, 200);
    assert.match(lo.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal(h.app.store.countSubscriptions(), 0, 'il logout elimina le sottoscrizioni della sessione');
    assert.equal((await h.req({ path: '/api/state', cookie })).status, 401);
  } finally {
    await h.stop();
  }
});

test('notifiche end-to-end: nuova domanda -> una sola push; chat finita -> una push; nessuna push per lo stato iniziale', async () => {
  const h = await startHarness();
  try {
    const cookie = await h.pair();
    await h.req({ method: 'POST', path: '/api/push/subscribe', cookie, body: { subscription: validSub() } });
    // stato iniziale: un residuo
    h.fx.chat('residuo-00001', { name: 'Vecchia', lastUpdatedAt: T0 - 5000, header: { hasBlockingPendingActions: true } });
    h.tick();
    h.tick();
    assert.equal(h.sent.length, 0);
    // nuova domanda
    withQuestion(h);
    h.tick();
    await new Promise((r) => setImmediate(r));
    h.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sent.length, 1);
    const payload = JSON.parse(h.sent[0].payload);
    assert.equal(payload.title, 'Domanda in attesa');
    assert.equal(payload.url, `/#/chat/${ID}`);
    assert.equal(payload.badge, 2, 'badge = chat che richiedono attenzione (residuo incluso)');
  } finally {
    await h.stop();
  }
});

test('push: approvazione in attesa = notifica con il TIPO di azione, mai il comando; poi il badge conta anche lei', async () => {
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
    assert.equal(h.sent.length, 0, 'sotto il ritardo: nessuna notifica');
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
    assert.equal(h.sent[0].payload.includes('echo prova'), false, 'il comando non esce mai dal daemon');
    assert.equal(payload.badge, 1);
    // tempi nel log (solo numeri): dall'inizio della richiesta alla notifica, compreso il ritardo di 5 s
    const sentLog = h.logLines.map((l) => JSON.parse(l)).find((l) => l.event === 'push_sent' && l.kind === 'approvazione');
    assert.ok(sentLog, 'push_sent con il tipo di notifica');
    assert.ok(Number.isFinite(sentLog.detectMs) && sentLog.detectMs >= 5000, `detectMs=${sentLog.detectMs}`);
    assert.ok(Number.isFinite(sentLog.sendMs));
    const st = (await h.req({ path: '/api/state', cookie })).json();
    assert.equal(st.state.attention[0].attention.kind, 'approvazione');
    assert.equal(st.state.attention[0].attention.detail, 'Comando da eseguire');
  } finally {
    await h.stop();
  }
});

test('SSE: stato iniziale e aggiornamento push quando cambia qualcosa', async () => {
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

test('file statici: intestazioni di sicurezza, ETag/304, sw.js con build id, path traversal e file nascosti bloccati', async () => {
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
    // Elenco di pre-cache: indice come "/", niente worker, licenze, file nascosti o con nomi che romperebbero il letterale.
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

test('guardia Tailscale opzionale: solo i login ammessi (blocca anche Funnel, che non porta l\'identita\')', async () => {
  const h = await startHarness({ configOverrides: { allowedTailscaleLogins: ['io@example.com'] } });
  try {
    assert.equal((await h.req({ path: '/' })).status, 403);
    assert.equal((await h.req({ path: '/', headers: { 'Tailscale-User-Login': 'altro@example.com' } })).status, 403);
    assert.equal((await h.req({ path: '/', headers: { 'Tailscale-User-Login': 'IO@example.com' } })).status, 200);
    assert.equal((await h.req({ path: '/healthz' })).status, 200, 'healthz non espone nulla');
  } finally {
    await h.stop();
  }
});

test('nessun segreto o contenuto di chat finisce nei log', async () => {
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
    assert.ok(logs.length > 0, 'il daemon logga eventi operativi');
    for (const secret of ['TITOLO-SEGRETO', 'SOTTOTITOLO', 'CARTELLA-SEGRETA', 'RISPOSTA-SEGRETA', 'DOMANDA-SEGRETA', 'PROMPT-SEGRETO', 'tc-segreto', code.replace('-', ''), code, token, sub.endpoint, sub.keys.p256dh, sub.keys.auth, 'vapid_private', '"d":']) {
      assert.equal(logs.includes(secret), false, `il log non deve contenere: ${secret.slice(0, 12)}...`);
    }
  } finally {
    await h.stop();
  }
});
