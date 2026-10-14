import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KeepAwake } from '../src/awake.js';
import { createLogger } from '../src/log.js';
import { Power } from '../src/power.js';
import { T0, startHarness } from './helpers/harness.js';

const nullLog = createLogger({ level: 'error', stream: { write() {} } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { spawn, calls, caffeinate: () => calls.filter((c) => c.cmd !== '/bin/sh'), guards: () => calls.filter((c) => c.cmd === '/bin/sh') };
}

function memStore() {
  const m = new Map();
  return { getMeta: (k) => m.get(k) ?? null, setMeta: (k, v) => m.set(k, v) };
}

/** Power finto: registra le chiamate e simula sudo, schermo, batteria e luminosita'. */
function fakePower(over = {}) {
  const s = { sudo: true, lid: false, battery: { onAC: true, percent: 100 }, brightness: 0.8, sleepDisabled: false, log: [], ...over };
  return {
    s,
    brightnessCmd: '/x/cp-brightness',
    brightnessAvailable: true,
    canControlSleep: async () => s.sudo,
    setSleepDisabled: async (on) => {
      s.log.push(`sleep:${on}`);
      s.sleepDisabled = on;
    },
    sleepDisabled: async () => s.sleepDisabled,
    lidClosed: async () => s.lid,
    battery: async () => s.battery,
    getBrightness: async () => s.brightness,
    setBrightness: async (v) => {
      s.log.push(`bright:${v}`);
      s.brightness = v;
      return true;
    },
  };
}

function make({ power = fakePower(), grace = 50, poll = 20 } = {}) {
  const f = fakeSpawnFactory();
  const store = memStore();
  const a = new KeepAwake({ store, config: { keepAwakeCmd: '/usr/bin/caffeinate', keepAwakeGraceMs: grace, keepAwakePollMs: poll, keepAwakeMinBattery: 20 }, logger: nullLog, spawn: f.spawn, exists: () => true, power });
  return { a, f, store, power };
}

test('Mac sveglio: spento di default; acceso parte solo se una chat lavora, con -w del daemon e senza schermo', async () => {
  const { a, f } = make();
  a.update(3);
  assert.equal(f.caffeinate().length, 0, 'spento: nessun processo');
  a.enabled = true;
  assert.equal(f.caffeinate().length, 1, 'acceso e chat in corso: parte');
  const args = f.caffeinate()[0].args;
  assert.deepEqual(args.slice(0, 3), ['-i', '-m', '-s']);
  assert.ok(args.includes('-w') && args.includes(String(process.pid)));
  assert.ok(!args.includes('-d'), 'lo schermo si spegne come al solito');
  assert.equal((await a.describe()).active, true);
  a.update(2);
  assert.equal(f.caffeinate().length, 1, 'un solo processo');
  assert.equal(f.guards().length, 0, 'senza "schermo chiuso" nessuna guardia');
  await a.close();
});

test('Mac sveglio: finito il lavoro si spegne dopo la tolleranza; se riparte nel frattempo non si ferma', async () => {
  const { a, f } = make({ grace: 60 });
  a.enabled = true;
  a.update(1);
  a.update(0);
  assert.equal(f.caffeinate()[0].p.killed, false, 'ancora in tolleranza');
  await sleep(20);
  a.update(1);
  await sleep(80);
  assert.equal(f.caffeinate()[0].p.killed, false, 'la tolleranza e\' stata annullata');
  a.update(0);
  await sleep(100);
  assert.equal(f.caffeinate()[0].p.killed, 'SIGTERM');
  a.update(1);
  assert.equal(f.caffeinate().length, 2, 'riparte con un nuovo processo');
  await a.close();
});

test('Mac sveglio: disattivarlo ferma subito; senza comando non e\' disponibile; errore di avvio = non disponibile', async () => {
  const { a, f } = make({ grace: 10_000 });
  a.enabled = true;
  a.update(1);
  a.enabled = false;
  assert.equal(f.caffeinate()[0].p.killed, 'SIGTERM');

  const none = new KeepAwake({ store: memStore(), config: { keepAwakeCmd: '', keepAwakeGraceMs: 0 }, logger: nullLog, spawn: f.spawn, exists: () => true, power: fakePower() });
  assert.equal(none.supported, false);
  none.enabled = true;
  none.update(1);
  assert.equal(f.caffeinate().length, 1);

  const b = make();
  b.a.enabled = true;
  b.a.update(1);
  b.f.caffeinate()[0].p.emit('error', new Error('ENOENT'));
  const d = await b.a.describe();
  assert.equal(d.supported, false);
  assert.equal(d.active, false);
});

test('a schermo chiuso: disablesleep 1 solo mentre un agente lavora, poi 0; guardia armata e poi fermata', async () => {
  const { a, f, power } = make();
  a.enabled = true;
  a.closedEnabled = true;
  a.update(1);
  await sleep(60);
  assert.deepEqual(power.s.log, ['sleep:true']);
  assert.equal(f.guards().length, 1, 'processo di guardia');
  const g = f.guards()[0];
  assert.equal(g.opts.detached, true);
  assert.equal(g.args[3], String(process.pid), 'la guardia segue il pid del daemon');
  assert.equal((await a.describe()).closed.active, true);
  assert.equal(a.store.getMeta('awake_sleep_disabled'), '1');

  a.update(0);
  await sleep(120);
  assert.equal(power.s.log.at(-1), 'sleep:false');
  assert.equal(g.p.killed, 'SIGTERM', 'guardia fermata');
  assert.equal(a.store.getMeta('awake_sleep_disabled'), '0');
  assert.equal((await a.describe()).closed.active, false);
  await a.close();
});

test('a schermo chiuso: senza la regola sudoers non si tocca pmset; batteria bassa rilascia e risale con margine', async () => {
  const noSudo = make({ power: fakePower({ sudo: false }) });
  noSudo.a.enabled = true;
  noSudo.a.closedEnabled = true;
  noSudo.a.update(1);
  await sleep(60);
  assert.deepEqual(noSudo.power.s.log, []);
  assert.equal((await noSudo.a.describe()).closed.available, false);
  await noSudo.a.close();

  const { a, power } = make();
  a.enabled = true;
  a.closedEnabled = true;
  a.update(1);
  await sleep(60);
  assert.equal(power.s.sleepDisabled, true);
  power.s.battery = { onAC: false, percent: 15 };
  await sleep(80);
  assert.equal(power.s.sleepDisabled, false, 'batteria sotto soglia: il Mac torna a poter dormire');
  assert.equal((await a.describe()).lowBattery, true);
  power.s.battery = { onAC: false, percent: 22 };
  await sleep(80);
  assert.equal(power.s.sleepDisabled, false, 'serve un margine prima di riprendere');
  power.s.battery = { onAC: false, percent: 40 };
  await sleep(80);
  assert.equal(power.s.sleepDisabled, true);
  await a.close();
  assert.equal(power.s.sleepDisabled, false);
});

test('a schermo chiuso: se qualcosa rimette il sonno normale mentre l\'agente lavora, il daemon lo riporta a 1', async () => {
  const { a, power } = make();
  a.enabled = true;
  a.closedEnabled = true;
  a.update(1);
  await sleep(60);
  power.s.sleepDisabled = false; // es. la guardia di un daemon precedente
  await sleep(60);
  assert.equal(power.s.sleepDisabled, true);
  await a.close();
});

test('luminosita\' a zero: solo a schermo chiuso, ripristinata all\'apertura e a fine lavoro; salvata anche in meta per i crash', async () => {
  const { a, f, power, store } = make();
  a.enabled = true;
  a.dimEnabled = true;
  a.update(1);
  await sleep(60);
  assert.deepEqual(power.s.log, [], 'schermo aperto: niente');
  power.s.lid = true;
  await sleep(60);
  assert.equal(power.s.brightness, 0);
  assert.equal(store.getMeta('awake_saved_brightness'), '0.8');
  const guard = f.guards().at(-1);
  assert.equal(guard.args[5], '0.8', 'la guardia sa quale luminosita\' ripristinare');
  power.s.lid = false;
  await sleep(60);
  assert.equal(power.s.brightness, 0.8);
  assert.equal(store.getMeta('awake_saved_brightness'), '');
  power.s.lid = true;
  await sleep(60);
  assert.equal(power.s.brightness, 0);
  a.update(0);
  await a.close();
  assert.equal(power.s.brightness, 0.8, 'a fine lavoro torna com\'era');
});

test('avvio dopo un arresto brusco: sospensione e luminosita\' lasciate indietro vengono ripristinate', async () => {
  const { a, power, store } = make();
  store.setMeta('awake_sleep_disabled', '1');
  store.setMeta('awake_saved_brightness', '0.6');
  await a.init();
  assert.deepEqual(power.s.log, ['sleep:false', 'bright:0.6']);
  assert.equal(store.getMeta('awake_sleep_disabled'), '0');
  assert.equal(store.getMeta('awake_saved_brightness'), '');
});

test('Power: legge schermo, batteria e sospensione dall\'output di macOS; senza regola sudo non e\' disponibile', async () => {
  const outs = {
    '/usr/sbin/ioreg': '  |   "AppleClamshellState" = Yes\n',
    '/usr/bin/pmset': "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t63%; discharging; 4:10 remaining present: true\n SleepDisabled\t\t1\n",
  };
  const calls = [];
  const p = new Power({ run: async (cmd, args) => (calls.push([cmd, ...args]), outs[cmd] ?? ''), brightnessCmd: '/x/b', exists: () => true });
  assert.equal(await p.lidClosed(), true);
  assert.deepEqual(await p.battery(), { onAC: false, percent: 63 });
  assert.equal(await p.sleepDisabled(), true);
  assert.equal(await p.canControlSleep(), true);
  assert.deepEqual(calls.at(-1), ['/usr/bin/sudo', '-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '1']);
  await p.setSleepDisabled(false);
  assert.deepEqual(calls.at(-1), ['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '0']);
  const denied = new Power({ run: async () => { throw new Error('sudo: a password is required'); } });
  assert.equal(await denied.canControlSleep(), false);
  assert.equal(await denied.lidClosed(), null);
  assert.equal(denied.brightnessAvailable, false);
});

test('Mac sveglio via HTTP: impostazioni, stato, requisiti dei livelli, conteggio delle chat in corso dal daemon', async () => {
  const f = fakeSpawnFactory();
  const power = fakePower({ sudo: false });
  const h = await startHarness({ actionsDeps: { awake: { spawn: f.spawn, exists: () => true, power } } });
  try {
    const cookie = await h.pair();
    assert.equal((await h.req({ path: '/api/settings/awake' })).status, 401);
    const d0 = (await h.req({ path: '/api/settings/awake', cookie })).json();
    assert.deepEqual([d0.supported, d0.enabled, d0.active, d0.closed.available, d0.dim.available], [true, false, false, false, true]);
    const post = (body) => h.req({ method: 'POST', path: '/api/settings/awake', cookie, body });
    assert.equal((await post({ enabled: 'si' })).status, 400);
    assert.equal((await post({})).status, 400);
    const noClosed = await post({ closed: true });
    assert.equal(noClosed.status, 409);
    assert.equal(noClosed.json().error, 'awake_closed_unavailable');

    const ID = '11111111-1111-4111-8111-111111111111';
    h.fx.chat(ID, { name: 'Lavora', lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 1000 } });
    h.fx.conversation(ID, [{ id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' }, { id: 'b2', type: 2, createdAt: T0 - 2000, text: '...' }], { status: 'generating' });
    h.tick();
    assert.equal(f.caffeinate().length, 0, 'funzione spenta: niente anche se la chat lavora');

    const on = await post({ enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.json().active, true);
    assert.equal(f.caffeinate().length, 1);

    power.s.sudo = true;
    h.app.awake.describe(); // aggiorna la cache
    await sleep(5);
    const off = await post({ enabled: false });
    assert.equal(off.json().active, false);
    assert.equal(f.caffeinate()[0].p.killed, 'SIGTERM');
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
