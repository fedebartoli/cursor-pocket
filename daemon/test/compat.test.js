import assert from 'node:assert/strict';
import test from 'node:test';
import { Compat, publicCompat } from '../src/compat.js';
import { evaluateDbCompat } from '../src/cursor/compat.js';
import { CursorDb } from '../src/cursor/db.js';
import { isTestedVersion, parseVersion, readCursorVersion, TESTED_CURSOR } from '../src/cursor/version.js';
import { CursorFixture } from './helpers/fixture.js';

/** A fixture with `n` healthy chats: a user bubble and a tool bubble each. */
function healthy(n = 3) {
  const fx = new CursorFixture();
  for (let i = 1; i <= n; i++) {
    const id = `chat-${i}`;
    fx.chat(id, { lastUpdatedAt: 1_700_000_000_000 + i * 1000 });
    fx.conversation(id, [
      { id: 'b1', type: 1, createdAt: 1_700_000_000_000, text: 'ciao' },
      { id: 'b2', type: 2, createdAt: 1_700_000_001_000, tool: { name: 'run_terminal_command_v2', status: 'completed', toolCallId: `tc-${i}` } },
    ]);
  }
  return fx;
}

function evaluate(fx, opts) {
  const db = new CursorDb(fx.file);
  db.open();
  try {
    return evaluateDbCompat(db, opts);
  } finally {
    db.close();
  }
}

// ----------------------------------------------------------------------------------------------------------------
// database layout canary
// ----------------------------------------------------------------------------------------------------------------

test('db compat: a healthy database raises nothing', () => {
  const fx = healthy();
  try {
    assert.deepEqual(evaluate(fx, { visibleCount: 3 }), { reasons: [], examined: 3 });
  } finally {
    fx.close();
  }
});

test('db compat: no chats yet means no evidence, not a problem', () => {
  const fx = new CursorFixture();
  try {
    assert.deepEqual(evaluate(fx, { visibleCount: 0 }), { reasons: [], examined: 0 });
  } finally {
    fx.close();
  }
});

test('db compat: a moved JSON field is caught (the silent failure json_extract would hide)', () => {
  const cases = [
    ['bubble_type_changed', `UPDATE cursorDiskKV SET value = replace(value, '"type":', '"kind":') WHERE key LIKE 'bubbleId:%'`],
    ['tool_fields_changed', `UPDATE cursorDiskKV SET value = replace(value, '"toolCallId":', '"callId":') WHERE key LIKE 'bubbleId:%'`],
    ['tool_fields_changed', `UPDATE cursorDiskKV SET value = replace(value, '"name":"run_terminal_command_v2"', '"label":"run_terminal_command_v2"') WHERE key LIKE 'bubbleId:%'`],
    ['bubble_list_changed', `UPDATE cursorDiskKV SET value = replace(value, 'fullConversationHeadersOnly', 'conversationHeaders') WHERE key LIKE 'composerData:%'`],
    ['composer_data_missing', `DELETE FROM cursorDiskKV WHERE key LIKE 'composerData:%'`],
    ['bubble_rows_missing', `DELETE FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'`],
  ];
  for (const [reason, sql] of cases) {
    const fx = healthy();
    try {
      fx.db.exec(sql);
      assert.ok(evaluate(fx, { visibleCount: 3 }).reasons.includes(reason), `${reason} expected after: ${sql}`);
    } finally {
      fx.close();
    }
  }
});

test('db compat: one odd chat among healthy ones is not a format change', () => {
  const fx = healthy(4);
  try {
    fx.db.exec(`UPDATE cursorDiskKV SET value = replace(value, '"toolCallId":', '"callId":') WHERE key LIKE 'bubbleId:chat-1:%'`);
    fx.db.exec(`DELETE FROM cursorDiskKV WHERE key = 'composerData:chat-2'`);
    assert.deepEqual(evaluate(fx, { visibleCount: 4 }).reasons, []);
  } finally {
    fx.close();
  }
});

test('db compat: headers exist but none is visible (needs at least 5 headers)', () => {
  const few = healthy(3);
  const many = healthy(6);
  try {
    assert.deepEqual(evaluate(few, { visibleCount: 0 }).reasons, [], 'a handful of chats may all be cloud ones');
    assert.deepEqual(evaluate(many, { visibleCount: 0 }).reasons, ['no_visible_chats']);
    assert.deepEqual(evaluate(many, { visibleCount: null }).reasons, [], 'unknown visible count: check skipped');
  } finally {
    few.close();
    many.close();
  }
});

test('db compat: a missing column is reported as a schema problem', () => {
  const db = { schemaColumns: () => ({ composerHeaders: ['composerId', 'value'], cursorDiskKV: ['key', 'value'], ItemTable: ['key', 'value'] }) };
  assert.deepEqual(evaluateDbCompat(db), { reasons: ['schema_missing'], examined: 0 });
});

test('db compat: the probes return structure only, never content', () => {
  const fx = healthy(1);
  const db = new CursorDb(fx.file);
  try {
    db.open();
    const shape = db.composerShape('chat-1');
    const bubble = db.bubbleShape('chat-1', 'b2');
    assert.deepEqual(shape, { headersType: 'array', bubbleCount: 2, lastBubbleId: 'b2' });
    assert.deepEqual(bubble, { typeType: 'integer', toolType: 'object', toolNameType: 'text', toolCallIdType: 'text' });
    assert.equal(db.composerShape('nope'), null);
    assert.equal(db.bubbleShape('chat-1', 'nope'), null);
  } finally {
    db.close();
    fx.close();
  }
});

// ----------------------------------------------------------------------------------------------------------------
// Cursor release
// ----------------------------------------------------------------------------------------------------------------

test('version: parsing and the tested list', () => {
  assert.deepEqual(parseVersion('3.25.6'), [3, 25, 6]);
  assert.equal(parseVersion('nonsense'), null);
  assert.deepEqual(TESTED_CURSOR, ['3.24', '3.25']);
  assert.equal(isTestedVersion('3.25.6'), true);
  assert.equal(isTestedVersion('3.26.0'), false);
  assert.equal(isTestedVersion('x'), null);
});

test('version: reads package.json from the first app that has one', () => {
  const reads = [];
  const readFile = (p) => {
    reads.push(p);
    if (p.startsWith('/b/')) return JSON.stringify({ version: '3.25.1' });
    throw new Error('ENOENT');
  };
  assert.deepEqual(readCursorVersion({ readFile, candidates: ['/a/Cursor.app', '/b/Cursor.app'] }), { found: true, version: '3.25.1' });
  assert.equal(reads.length, 2);
  assert.deepEqual(readCursorVersion({ readFile: () => { throw new Error('x'); }, candidates: ['/a'] }), { found: false, version: null });
  assert.deepEqual(readCursorVersion({ readFile: () => '{"name":"x"}', candidates: ['/a'] }), { found: true, version: null });
});

// ----------------------------------------------------------------------------------------------------------------
// monitor
// ----------------------------------------------------------------------------------------------------------------

function monitor({ open = true, reasons = [], version = '3.25.6', found = true, last = { chats: [{}] } } = {}) {
  const logs = [];
  const logger = { info: (m, f) => logs.push(['info', m, f]), warn: (m, f) => logs.push(['warn', m, f]), error() {}, debug() {} };
  const ctl = { open, reasons, version, found, throwEval: false };
  const c = new Compat({
    db: { get isOpen() { return ctl.open; } },
    watcher: { last },
    config: { compatCheckMs: 60_000, cursorAppDirs: [] },
    logger,
    evaluate: () => {
      if (ctl.throwEval) throw Object.assign(new Error('boom'), { code: 'X' });
      return { reasons: ctl.reasons, examined: 3 };
    },
    readVersion: () => ({ found: ctl.found, version: ctl.version }),
  });
  const seen = [];
  c.on('change', (s) => seen.push(publicCompat(s)));
  return { c, ctl, logs, seen };
}

test('compat monitor: healthy and tested release', () => {
  const { c, seen, logs } = monitor();
  const s = c.check();
  assert.deepEqual(publicCompat(s), { compat: 'ok', cursor: 'tested' });
  assert.equal(s.version, '3.25.6');
  assert.deepEqual(seen, [{ compat: 'ok', cursor: 'tested' }], 'first check tells clients about the release');
  c.check();
  assert.equal(seen.length, 1, 'no event when nothing changed');
  assert.ok(logs.some(([, m]) => m === 'cursor_version'));
});

test('compat monitor: an untested release is only a notice', () => {
  const { c } = monitor({ version: '3.26.0' });
  const s = c.check();
  assert.deepEqual(publicCompat(s), { compat: 'ok', cursor: 'untested' });
  assert.deepEqual(s.reasons, [], 'nothing is disabled because of the version');
});

test('compat monitor: unknown release when the app is not found', () => {
  const { c } = monitor({ found: false, version: null });
  assert.deepEqual(publicCompat(c.check()), { compat: 'ok', cursor: 'unknown' });
});

test('compat monitor: degraded and back, with one event and one log line per change (codes only)', () => {
  const { c, ctl, seen, logs } = monitor();
  c.check();
  ctl.reasons = ['tool_fields_changed'];
  assert.deepEqual(publicCompat(c.check()), { compat: 'degraded', cursor: 'tested' });
  c.check();
  assert.equal(logs.filter(([, m]) => m === 'compat_degraded').length, 1);
  const warn = logs.find(([, m]) => m === 'compat_degraded');
  assert.deepEqual(warn[2], { count: 1, reason: 'tool_fields_changed' });
  ctl.reasons = [];
  assert.deepEqual(publicCompat(c.check()), { compat: 'ok', cursor: 'tested' });
  assert.deepEqual(seen.map((x) => x.compat), ['ok', 'degraded', 'ok']);
});

test('compat monitor: database not open keeps the last verdict; a failing check never throws', () => {
  const { c, ctl, logs } = monitor({ reasons: ['bubble_type_changed'] });
  c.check();
  ctl.open = false;
  ctl.reasons = [];
  assert.deepEqual(c.check().reasons, ['bubble_type_changed'], 'unreadable database says nothing about the layout');
  ctl.open = true;
  ctl.throwEval = true;
  assert.deepEqual(c.check().reasons, ['bubble_type_changed']);
  assert.ok(logs.some(([, m]) => m === 'compat_check_failed'));
});

test('compat monitor: visible chat count is passed to the check (null before the first snapshot)', () => {
  const calls = [];
  const c = new Compat({
    db: { isOpen: true },
    watcher: { last: null },
    config: { compatCheckMs: 60_000, cursorAppDirs: [] },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    evaluate: (_db, o) => (calls.push(o.visibleCount), { reasons: [], examined: 0 }),
    readVersion: () => ({ found: false, version: null }),
  });
  c.check();
  c.watcher.last = { chats: [{}, {}] };
  c.check();
  assert.deepEqual(calls, [null, 2]);
});
