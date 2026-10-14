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

/** Fake Power: records calls and simulates sudo, lid, battery and brightness. */
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

test('awake Mac: off by default; on starts only when a chat is working, with daemon -w and no display', async () => {
  const { a, f } = make();
  a.update(3);
  assert.equal(f.caffeinate().length, 0, 'off: no process');
  a.enabled = true;
  assert.equal(f.caffeinate().length, 1, 'on and chat running: starts');
  const args = f.caffeinate()[0].args;
  assert.deepEqual(args.slice(0, 3), ['-i', '-m', '-s']);
  assert.ok(args.includes('-w') && args.includes(String(process.pid)));
  assert.ok(!args.includes('-d'), 'display sleeps as usual');
  assert.equal((await a.describe()).active, true);
  a.update(2);
  assert.equal(f.caffeinate().length, 1, 'single process');
  assert.equal(f.guards().length, 0, 'no guard without lid closed');
  await a.close();
});

test('awake Mac: stops after grace when work ends; if work resumes during grace does not stop', async () => {
  const { a, f } = make({ grace: 60 });
  a.enabled = true;
  a.update(1);
  a.update(0);
  assert.equal(f.caffeinate()[0].p.killed, false, 'still in grace period');
  await sleep(20);
  a.update(1);
  await sleep(80);
  assert.equal(f.caffeinate()[0].p.killed, false, 'grace was cancelled');
  a.update(0);
  await sleep(100);
  assert.equal(f.caffeinate()[0].p.killed, 'SIGTERM');
  a.update(1);
  assert.equal(f.caffeinate().length, 2, 'restarts with new process');
  await a.close();
});

test('awake Mac: disabling stops immediately; without command unavailable; start error = unavailable', async () => {
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

test('lid closed: disablesleep 1 only while agent works, then 0; guard armed then stopped', async () => {
  const { a, f, power } = make();
  a.enabled = true;
  a.closedEnabled = true;
  a.update(1);
  await sleep(60);
  assert.deepEqual(power.s.log, ['sleep:true']);
  assert.equal(f.guards().length, 1, 'guard process');
  const g = f.guards()[0];
  assert.equal(g.opts.detached, true);
  assert.equal(g.args[3], String(process.pid), 'guard follows daemon pid');
  assert.equal((await a.describe()).closed.active, true);
  assert.equal(a.store.getMeta('awake_sleep_disabled'), '1');

  a.update(0);
  await sleep(120);
  assert.equal(power.s.log.at(-1), 'sleep:false');
  assert.equal(g.p.killed, 'SIGTERM', 'guard stopped');
  assert.equal(a.store.getMeta('awake_sleep_disabled'), '0');
  assert.equal((await a.describe()).closed.active, false);
  await a.close();
});

test('lid closed: without sudoers rule pmset untouched; low battery releases and re-engages with hysteresis', async () => {
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
  assert.equal(power.s.sleepDisabled, false, 'battery below threshold: Mac can sleep again');
  assert.equal((await a.describe()).lowBattery, true);
  power.s.battery = { onAC: false, percent: 22 };
  await sleep(80);
  assert.equal(power.s.sleepDisabled, false, 'hysteresis before re-engaging');
  power.s.battery = { onAC: false, percent: 40 };
  await sleep(80);
  assert.equal(power.s.sleepDisabled, true);
  await a.close();
  assert.equal(power.s.sleepDisabled, false);
});

test('lid closed: if something restores normal sleep while agent works, daemon sets it back to 1', async () => {
  const { a, power } = make();
  a.enabled = true;
  a.closedEnabled = true;
  a.update(1);
  await sleep(60);
  power.s.sleepDisabled = false; // e.g. previous daemon guard
  await sleep(60);
  assert.equal(power.s.sleepDisabled, true);
  await a.close();
});

test('zero brightness: only with lid closed, restored on open and when work ends; also saved in meta for crashes', async () => {
  const { a, f, power, store } = make();
  a.enabled = true;
  a.dimEnabled = true;
  a.update(1);
  await sleep(60);
  assert.deepEqual(power.s.log, [], 'lid open: nothing');
  power.s.lid = true;
  await sleep(60);
  assert.equal(power.s.brightness, 0);
  assert.equal(store.getMeta('awake_saved_brightness'), '0.8');
  const guard = f.guards().at(-1);
  assert.equal(guard.args[5], '0.8', 'guard knows brightness to restore');
  power.s.lid = false;
  await sleep(60);
  assert.equal(power.s.brightness, 0.8);
  assert.equal(store.getMeta('awake_saved_brightness'), '');
  power.s.lid = true;
  await sleep(60);
  assert.equal(power.s.brightness, 0);
  a.update(0);
  await a.close();
  assert.equal(power.s.brightness, 0.8, 'restored when work ends');
});

test('startup after crash: sleep and brightness left behind are restored', async () => {
  const { a, power, store } = make();
  store.setMeta('awake_sleep_disabled', '1');
  store.setMeta('awake_saved_brightness', '0.6');
  await a.init();
  assert.deepEqual(power.s.log, ['sleep:false', 'bright:0.6']);
  assert.equal(store.getMeta('awake_sleep_disabled'), '0');
  assert.equal(store.getMeta('awake_saved_brightness'), '');
});

test('Power: reads lid, battery and sleep from macOS output; unavailable without sudo rule', async () => {
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

test('keep awake via HTTP: settings, status, tier requirements, running chat count from daemon', async () => {
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
    assert.equal(f.caffeinate().length, 0, 'feature off: nothing even if chat is working');

    const on = await post({ enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.json().active, true);
    assert.equal(f.caffeinate().length, 1);

    power.s.sudo = true;
    h.app.awake.describe(); // refresh cache
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
