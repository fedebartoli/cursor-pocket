// `npm run doctor`: each check against fake dependencies (no Cursor, no network, no Tailscale needed).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkActions, checkCursorVersion, checkDatabase, checkNode, checkTailscale, formatReport, parseVersion, runDoctor } from '../src/doctor.js';

const config = { host: '127.0.0.1', port: 8787, cdpPort: 9222, cursorDbPath: '/x/state.vscdb' };

describe('versions', () => {
  it('parses versions', () => {
    assert.deepEqual(parseVersion('3.25.6'), [3, 25, 6]);
    assert.equal(parseVersion('abc'), null);
  });
  it('Node: old versions fail, new ones pass', () => {
    assert.equal(checkNode('22.13.0').level, 'ok');
    assert.equal(checkNode('23.1.0').level, 'ok');
    assert.equal(checkNode('22.12.9').level, 'fail');
    assert.equal(checkNode('20.0.0').level, 'fail');
  });
  const app = (version) => ({ candidates: ['/A.app'], readFile: () => JSON.stringify({ version }) });
  it('Cursor: tested version ok, another one warns (never fails), missing app warns', () => {
    assert.equal(checkCursorVersion(app('3.24.9')).level, 'ok');
    assert.equal(checkCursorVersion(app('3.25.6')).level, 'ok');
    assert.equal(checkCursorVersion(app('3.26.0')).level, 'warn');
    assert.match(checkCursorVersion(app('3.26.0')).text, /3\.26\.0/);
    assert.equal(checkCursorVersion({ candidates: ['/none.app'], readFile: () => { throw new Error('nope'); } }).level, 'warn');
  });
});

describe('database', () => {
  const fake = (over) => () => ({ open() {}, close() {}, listHeaders: () => [{}, {}], sidebarSettings: () => ({ groupBy: 'x' }), ...over });
  it('all readable: three ok lines', () => {
    const r = checkDatabase(config, { open: fake() });
    assert.deepEqual(r.map((x) => x.level), ['ok', 'ok', 'ok']);
  });
  it('database missing: fail with a hint', () => {
    const r = checkDatabase(config, { open: fake({ open() { throw Object.assign(new Error('x'), { code: 'DB_NOT_FOUND' }); } }) });
    assert.equal(r.length, 1);
    assert.equal(r[0].level, 'fail');
    assert.match(r[0].text, /DB_NOT_FOUND/);
  });
  it('format changed (query throws): fail, and the database is closed', () => {
    let closed = false;
    const r = checkDatabase(config, { open: fake({ listHeaders() { throw new Error('no such table'); }, close() { closed = true; } }) });
    assert.equal(r.at(-1).level, 'fail');
    assert.equal(closed, true);
  });
});

describe('actions', () => {
  const ui = (over) => ({
    probe: async () => ({ up: true, browser: 'Chrome/1' }),
    hasWindow: async () => true,
    selfTest: async () => ({ rows: 5, panel: 1, composer: 1, send: 1, customize: 1, sidebarToggle: 1 }),
    ...over,
  });
  it('closed port is a warning, not a failure (read-only mode still works)', async () => {
    const r = await checkActions(config, ui({ probe: async () => ({ up: false }) }));
    assert.deepEqual(r.map((x) => x.level), ['warn']);
  });
  it('everything present: only ok', async () => {
    const r = await checkActions(config, ui());
    assert.ok(r.every((x) => x.level === 'ok'), JSON.stringify(r));
  });
  it('no Agents window: fail', async () => {
    const r = await checkActions(config, ui({ hasWindow: async () => false }));
    assert.equal(r.at(-1).level, 'fail');
  });
  it('open chat without composer or send button: two failures with hints to the selectors', async () => {
    const r = await checkActions(config, ui({ selfTest: async () => ({ rows: 5, panel: 1, composer: 0, send: 0, customize: 1, sidebarToggle: 1 }) }));
    const fails = r.filter((x) => x.level === 'fail');
    assert.equal(fails.length, 2);
    assert.match(fails[0].hint, /SEL\.composer/);
  });
  it('no chat open: composer is not checked (warning only)', async () => {
    const r = await checkActions(config, ui({ selfTest: async () => ({ rows: 5, panel: 0, composer: 0, send: 0, customize: 1, sidebarToggle: 1 }) }));
    assert.equal(r.filter((x) => x.level === 'fail').length, 0);
    assert.ok(r.some((x) => x.level === 'warn'));
  });
});

describe('tailscale', () => {
  const bins = [process.execPath]; // exists on every machine running the tests
  const serve = (text) => ({ bins, exec: async () => text });
  it('forwarding to the daemon port and no Funnel: ok', async () => {
    const r = await checkTailscale(config, serve('https://mac.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8787\n'));
    assert.deepEqual(r.map((x) => x.level), ['ok', 'ok']);
  });
  it('Funnel on is a failure', async () => {
    const r = await checkTailscale(config, serve('https://mac.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8787\n'));
    assert.equal(r[0].level, 'fail');
    assert.match(r[0].hint, /funnel reset/);
  });
  it('serve pointing elsewhere warns with the right command', async () => {
    const r = await checkTailscale(config, serve('|-- / proxy http://127.0.0.1:9999\n'));
    assert.equal(r[1].level, 'warn');
    assert.match(r[1].hint, /tailscale serve --bg 8787/);
  });
  it('no tailscale binary: warning', async () => {
    const r = await checkTailscale(config, { bins: ['/definitely/not/here'] });
    assert.equal(r[0].level, 'warn');
  });
});

describe('runDoctor and formatReport', () => {
  it('collects everything and counts failures and warnings', async () => {
    const report = await runDoctor(config, {
      ui: { probe: async () => ({ up: false }) },
      deps: {
        nodeVersion: '22.13.0',
        cursorVersion: { candidates: ['/A.app'], readFile: () => JSON.stringify({ version: '3.26.0' }) },
        database: { open: () => ({ open() {}, close() {}, listHeaders: () => [{}], sidebarSettings: () => ({}) }) },
        daemon: { fetchImpl: async () => ({ ok: true }) },
        tailscale: { bins: ['/definitely/not/here'] },
      },
    });
    assert.equal(report.failed, 0);
    assert.equal(report.warned, 3); // Cursor version, debug port, tailscale
    const text = formatReport(report);
    assert.match(text, /^OK {4}Node 22\.13\.0/);
    assert.match(text, /No problems, 3 warning\(s\)\./);
  });
  it('report text never contains anything but our own messages (no paths of chats, no keys)', async () => {
    const report = await runDoctor(config, { ui: { probe: async () => ({ up: false }) }, deps: { tailscale: { bins: [] } } });
    assert.doesNotMatch(formatReport(report), /sk-|token|secret/i);
  });
});
