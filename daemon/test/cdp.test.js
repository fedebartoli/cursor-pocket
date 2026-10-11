import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { CdpError, CdpSession, KEYS, MODIFIER, listPageTargets, probeCdp, safeWsUrl } from '../src/cursor/cdp.js';
import { FakeCdp } from './helpers/fake-cdp.js';

const servers = [];
async function fake(opts) {
  const f = new FakeCdp(opts);
  await f.start();
  servers.push(f);
  return f;
}
afterEach(async () => {
  while (servers.length) await servers.pop().stop();
});

describe('safeWsUrl', () => {
  const ok = 'ws://127.0.0.1:9222/devtools/page/ABCDEF0123456789';
  it('accetta solo loopback, porta attesa e percorso /devtools/page/<id>', () => {
    assert.equal(safeWsUrl(ok, 9222), ok);
    assert.ok(safeWsUrl('ws://localhost:9222/devtools/page/ABCDEF0123456789', 9222));
    assert.ok(safeWsUrl('ws://[::1]:9222/devtools/page/ABCDEF0123456789', 9222));
  });
  it('rifiuta host esterni, altre porte, schemi e percorsi diversi', () => {
    for (const bad of [
      'ws://192.168.1.5:9222/devtools/page/ABCDEF0123456789',
      'ws://evil.example:9222/devtools/page/ABCDEF0123456789',
      'ws://127.0.0.1:9333/devtools/page/ABCDEF0123456789',
      'wss://127.0.0.1:9222/devtools/page/ABCDEF0123456789',
      'http://127.0.0.1:9222/devtools/page/ABCDEF0123456789',
      'ws://127.0.0.1:9222/devtools/browser/ABCDEF0123456789',
      'ws://127.0.0.1:9222/devtools/page/../x',
      'ws://127.0.0.1:9222/devtools/page/ABCDEF0123456789?token=1',
      'ws://user:pw@127.0.0.1:9222/devtools/page/ABCDEF0123456789',
      '',
      null,
      'non un url',
    ]) {
      assert.equal(safeWsUrl(bad, 9222), null, String(bad));
    }
  });
});

describe('probeCdp e listPageTargets', () => {
  it('riconosce una porta di debug attiva e una spenta', async () => {
    const f = await fake();
    const up = await probeCdp(f.port);
    assert.equal(up.up, true);
    assert.equal(up.browser, 'FakeChrome/1.0');
    await f.stop();
    servers.pop();
    assert.deepEqual(await probeCdp(f.port, { timeoutMs: 500 }), { up: false, browser: null });
  });

  it('elenca solo le pagine con URL WebSocket valido e locale', async () => {
    const f = await fake({
      targets: [
        { id: 'PAGE0001', type: 'page', title: 'Cursor Agents', url: 'vscode-file://x' },
        { id: 'WORKER01', type: 'service_worker', title: 'sw', url: 'x' },
        { id: 'PAGE0002', type: 'page', title: 'Cattiva', url: 'x', webSocketDebuggerUrl: 'ws://203.0.113.9:9222/devtools/page/PAGE0002' },
        { id: 'PAGE0003', type: 'page', title: 'Cursor', url: 'vscode-file://y' },
      ],
    });
    const ts = await listPageTargets(f.port);
    assert.deepEqual(ts.map((t) => t.id), ['PAGE0001', 'PAGE0003']);
    assert.match(ts[0].wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/PAGE0001$/);
  });

  it('con la porta spenta lancia unavailable', async () => {
    const f = await fake();
    const { port } = f;
    await f.stop();
    servers.pop();
    await assert.rejects(listPageTargets(port, { timeoutMs: 500 }), (e) => e instanceof CdpError && e.code === 'unavailable');
  });
});

describe('CdpSession', () => {
  async function session(handler) {
    const f = await fake({ handler });
    const [t] = await listPageTargets(f.port);
    return { f, s: await CdpSession.open(t.wsUrl) };
  }

  it('invia comandi e restituisce il risultato; il WebSocket di Node non manda Origin', async () => {
    const { f, s } = await session((method) => (method === 'Runtime.evaluate' ? { result: { type: 'number', value: 42 } } : {}));
    assert.equal(await s.evaluate('1+41'), 42);
    assert.equal(f.commands[0].method, 'Runtime.evaluate');
    assert.deepEqual(
      { expression: f.commands[0].params.expression, awaitPromise: f.commands[0].params.awaitPromise, returnByValue: f.commands[0].params.returnByValue },
      { expression: '1+41', awaitPromise: true, returnByValue: true },
    );
    assert.equal(f.upgradeHeaders[0].origin, undefined, 'DevTools rifiuta le origini non ammesse: Node non deve mandarne');
    s.close();
  });

  it('errore del protocollo -> cdp_error con messaggio troncato', async () => {
    const { s } = await session(() => {
      throw new Error('x'.repeat(500));
    });
    await assert.rejects(s.send('Page.nonEsiste'), (e) => e.code === 'cdp_error' && e.message.length < 160);
    s.close();
  });

  it('eccezione nella pagina -> page_exception, solo la prima riga', async () => {
    const { s } = await session(() => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: foo is not defined\n    at <anonymous>:1:1' } } }));
    await assert.rejects(s.evaluate('foo'), (e) => e.code === 'page_exception' && e.message === 'ReferenceError: foo is not defined');
    s.close();
  });

  it('nessuna risposta -> timeout', async () => {
    const { s } = await session(() => 'NO_REPLY');
    await assert.rejects(s.send('Runtime.evaluate', {}, { timeoutMs: 80 }), (e) => e.code === 'timeout');
    s.close();
  });

  it('chiusura del server -> le richieste in volo falliscono con closed e la sessione risulta chiusa', async () => {
    const { f, s } = await session(() => 'NO_REPLY');
    const p = s.send('Runtime.evaluate', {}, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 30));
    f.dropConnections();
    await assert.rejects(p, (e) => e.code === 'closed');
    assert.equal(s.closed, true);
    await assert.rejects(s.send('X'), (e) => e.code === 'closed');
  });

  it('connessione rifiutata -> unavailable; connessione che non risponde -> timeout', async () => {
    const f = await fake();
    const { port } = f;
    await f.stop();
    servers.pop();
    await assert.rejects(CdpSession.open(`ws://127.0.0.1:${port}/devtools/page/PAGE0001`, { connectTimeoutMs: 500 }), (e) => e.code === 'unavailable' || e.code === 'timeout');
  });

  it('click: mouseMoved, mousePressed, mouseReleased alle coordinate', async () => {
    const { f, s } = await session();
    await s.click(120.5, 80);
    const seq = f.commands.map((c) => [c.method, c.params.type, c.params.x, c.params.y]);
    assert.deepEqual(seq, [
      ['Input.dispatchMouseEvent', 'mouseMoved', 120.5, 80],
      ['Input.dispatchMouseEvent', 'mousePressed', 120.5, 80],
      ['Input.dispatchMouseEvent', 'mouseReleased', 120.5, 80],
    ]);
    assert.equal(f.commands[1].params.button, 'left');
    assert.equal(f.commands[1].params.clickCount, 1);
    s.close();
  });

  it('insertText e pressKey (Invio, Maiusc+Invio)', async () => {
    const { f, s } = await session();
    await s.insertText('ciao');
    await s.pressKey(KEYS.enter, { modifiers: MODIFIER.shift });
    assert.deepEqual(f.commands[0], { method: 'Input.insertText', params: { text: 'ciao' } });
    const down = f.commands[1].params;
    const up = f.commands[2].params;
    assert.equal(down.type, 'keyDown');
    assert.equal(down.key, 'Enter');
    assert.equal(down.modifiers, 8);
    assert.equal(down.text, '\r');
    assert.equal(up.type, 'keyUp');
    assert.equal(up.windowsVirtualKeyCode, 13);
    s.close();
  });

  it('piu\' richieste in parallelo ricevono ciascuna la propria risposta', async () => {
    const { s } = await session(async (method, params) => {
      await new Promise((r) => setTimeout(r, params.delay));
      return { result: { value: params.tag } };
    });
    const [a, b, c] = await Promise.all([
      s.send('X', { delay: 60, tag: 'a' }),
      s.send('X', { delay: 10, tag: 'b' }),
      s.send('X', { delay: 30, tag: 'c' }),
    ]);
    assert.deepEqual([a.result.value, b.result.value, c.result.value], ['a', 'b', 'c']);
    s.close();
  });
});
