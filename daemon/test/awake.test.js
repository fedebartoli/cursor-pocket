import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KeepAwake } from '../src/awake.js';
import { createLogger } from '../src/log.js';
import { T0, startHarness } from './helpers/harness.js';

const nullLog = createLogger({ level: 'error', stream: { write() {} } });

function fakeSpawnFactory() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const p = new EventEmitter();
    p.killed = false;
    p.kill = (sig) => {
      p.killed = sig;
      queueMicrotask(() => p.emit('exit'));
    };
    p.unref = () => {};
    calls.push({ cmd, args, opts, p });
    return p;
  };
  return { spawn, calls };
}

function memStore() {
  const m = new Map();
  return { getMeta: (k) => m.get(k) ?? null, setMeta: (k, v) => m.set(k, v) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Mac sveglio: spento di default; acceso parte solo se una chat lavora, con -w del daemon e senza schermo', () => {
  const { spawn, calls } = fakeSpawnFactory();
  const a = new KeepAwake({ store: memStore(), config: { keepAwakeCmd: '/usr/bin/caffeinate', keepAwakeGraceMs: 50 }, logger: nullLog, spawn, exists: () => true });
  a.update(3);
  assert.equal(calls.length, 0, 'spento: nessun processo');
  a.enabled = true;
  assert.equal(calls.length, 1, 'acceso e chat in corso: parte');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-i', '-m', '-s']);
  assert.ok(calls[0].args.includes('-w') && calls[0].args.includes(String(process.pid)));
  assert.ok(!calls[0].args.includes('-d'), 'lo schermo si spegne come al solito');
  assert.equal(a.status.active, true);
  a.update(2);
  assert.equal(calls.length, 1, 'un solo processo');
  a.close();
});

test('Mac sveglio: finito il lavoro si spegne dopo la tolleranza; se riparte nel frattempo non si ferma', async () => {
  const { spawn, calls } = fakeSpawnFactory();
  const a = new KeepAwake({ store: memStore(), config: { keepAwakeCmd: 'x', keepAwakeGraceMs: 60 }, logger: nullLog, spawn, exists: () => true });
  a.enabled = true;
  a.update(1);
  a.update(0);
  assert.equal(calls[0].p.killed, false, 'ancora in tolleranza');
  await sleep(20);
  a.update(1); // riparte
  await sleep(80);
  assert.equal(calls[0].p.killed, false, 'la tolleranza e\' stata annullata');
  a.update(0);
  await sleep(100);
  assert.equal(calls[0].p.killed, 'SIGTERM');
  await sleep(5);
  assert.equal(a.status.active, false);
  a.update(1);
  assert.equal(calls.length, 2, 'riparte con un nuovo processo');
  a.close();
});

test('Mac sveglio: disattivarlo ferma subito; senza il comando non e\' disponibile; errore di avvio = non disponibile', async () => {
  const { spawn, calls } = fakeSpawnFactory();
  const a = new KeepAwake({ store: memStore(), config: { keepAwakeCmd: 'x', keepAwakeGraceMs: 10_000 }, logger: nullLog, spawn, exists: () => true });
  a.enabled = true;
  a.update(1);
  a.enabled = false;
  assert.equal(calls[0].p.killed, 'SIGTERM');

  const none = new KeepAwake({ store: memStore(), config: { keepAwakeCmd: '', keepAwakeGraceMs: 0 }, logger: nullLog, spawn, exists: () => true });
  assert.equal(none.supported, false);
  none.enabled = true;
  none.update(1);
  assert.equal(calls.length, 1);

  const b = new KeepAwake({ store: memStore(), config: { keepAwakeCmd: 'x', keepAwakeGraceMs: 0 }, logger: nullLog, spawn, exists: () => true });
  b.enabled = true;
  b.update(1);
  calls[1].p.emit('error', new Error('ENOENT'));
  assert.equal(b.status.supported, false);
  assert.equal(b.status.active, false);
});

test('Mac sveglio via HTTP: impostazione, stato, conteggio delle chat in corso dal daemon', async () => {
  const { spawn, calls } = fakeSpawnFactory();
  const h = await startHarness({ actionsDeps: { awake: { spawn, exists: () => true } } });
  try {
    const cookie = await h.pair();
    assert.equal((await h.req({ path: '/api/settings/awake' })).status, 401);
    assert.deepEqual((await h.req({ path: '/api/settings/awake', cookie })).json(), { supported: true, enabled: false, active: false });
    assert.equal((await h.req({ method: 'POST', path: '/api/settings/awake', cookie, body: { enabled: 'si' } })).status, 400);

    const ID = '11111111-1111-4111-8111-111111111111';
    h.fx.chat(ID, { name: 'Lavora', lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 1000 } });
    h.fx.conversation(ID, [{ id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' }, { id: 'b2', type: 2, createdAt: T0 - 2000, text: '...' }], { status: 'generating' });
    h.tick();
    assert.equal(calls.length, 0, 'funzione spenta: niente anche se la chat lavora');

    const on = await h.req({ method: 'POST', path: '/api/settings/awake', cookie, body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.deepEqual(on.json(), { supported: true, enabled: true, active: true });
    assert.equal(calls.length, 1);

    const off = await h.req({ method: 'POST', path: '/api/settings/awake', cookie, body: { enabled: false } });
    assert.equal(off.json().active, false);
    assert.equal(calls[0].p.killed, 'SIGTERM');
  } finally {
    await h.stop();
  }

  const none = await startHarness({ configOverrides: { keepAwakeCmd: '' } });
  try {
    const cookie = await none.pair();
    const r = await none.req({ method: 'POST', path: '/api/settings/awake', cookie, body: { enabled: true } });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'awake_unsupported');
  } finally {
    await none.stop();
  }
});
