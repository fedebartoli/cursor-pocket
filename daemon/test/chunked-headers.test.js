// Cursor 3.26 stores a chat's bubble list in numbered rows (`composerConvHeaders:<id>:<000000>`) and leaves
// `composerData.fullConversationHeadersOnly` empty. The reader must give the same answers for both layouts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDbCompat } from '../src/cursor/compat.js';
import { CursorDb } from '../src/cursor/db.js';
import { CursorFixture } from './helpers/fixture.js';

const T0 = 1_700_000_000_000;

/** Seven bubbles: user, then assistant text and tool calls. */
const BUBBLES = [
  { id: 'b1', type: 1, createdAt: T0, text: 'Fai una cosa' },
  { id: 'b2', type: 2, createdAt: T0 + 1000, text: 'Inizio' },
  { id: 'b3', type: 2, createdAt: T0 + 2000, tool: { name: 'read_file_v2', status: 'completed', toolCallId: 'tc-3' } },
  { id: 'b4', type: 2, createdAt: T0 + 3000, text: 'Letto' },
  { id: 'b5', type: 2, createdAt: T0 + 4000, tool: { name: 'edit_file_v2', status: 'completed', toolCallId: 'tc-5' } },
  { id: 'b6', type: 2, createdAt: T0 + 5000, text: 'Fatto quasi' },
  { id: 'b7', type: 2, createdAt: T0 + 6000, tool: { name: 'run_terminal_command_v2', status: 'loading', toolCallId: 'tc-7' } },
];

function build(layout, chunkSize = 3) {
  const fx = new CursorFixture();
  fx.chat('c1', { lastUpdatedAt: T0 + 6000 });
  fx.conversation('c1', BUBBLES, { layout, chunkSize, queueItems: [{ id: 'q' }] });
  const db = new CursorDb(fx.file);
  db.open();
  return {
    db,
    close() {
      db.close();
      fx.close();
    },
  };
}

test('chunked bubble list: the tail is read from the last chunks (also when the last chunk has one item)', () => {
  const { db, close } = build('chunked', 3); // chunks of 3, 3 and 1 bubbles
  try {
    const t = db.composerTail('c1');
    assert.equal(t.bubbleCount, 7);
    assert.equal(t.queueLength, 1);
    assert.equal(t.lastBubble.id, 'b7');
    assert.equal(t.prevBubble.id, 'b6', 'the previous header comes from the chunk before');
    assert.equal(t.lastBubble.createdAt, T0 + 6000);
  } finally {
    close();
  }
});

test('chunked bubble list: gives the same answers as the legacy list', () => {
  const a = build('legacy');
  const b = build('chunked', 3);
  try {
    assert.deepEqual(b.db.composerTail('c1'), a.db.composerTail('c1'));
    assert.deepEqual(b.db.conversationPage('c1', { limit: 4 }), a.db.conversationPage('c1', { limit: 4 }));
    assert.deepEqual(b.db.conversationPage('c1', { before: 5, limit: 4 }), a.db.conversationPage('c1', { before: 5, limit: 4 }), 'a page across two chunks');
    assert.deepEqual(b.db.recentActivity('c1', { limit: 5 }), a.db.recentActivity('c1', { limit: 5 }));
    assert.deepEqual(b.db.lastAssistantMessage('c1'), a.db.lastAssistantMessage('c1'));
    assert.deepEqual(b.db.composerShape('c1'), a.db.composerShape('c1'));
    assert.deepEqual(b.db.composerShape('c1'), { headersType: 'array', bubbleCount: 7, lastBubbleId: 'b7' });
  } finally {
    a.close();
    b.close();
  }
});

test('chunked bubble list: pages go from the end and keep the bubble index', () => {
  const { db, close } = build('chunked', 3);
  try {
    const last = db.conversationPage('c1', { limit: 3 });
    assert.deepEqual(last.items.map((i) => [i.index, i.id]), [[4, 'b5'], [5, 'b6'], [6, 'b7']]);
    const before = db.conversationPage('c1', { before: 4, limit: 3 });
    assert.deepEqual(before.items.map((i) => [i.index, i.id]), [[1, 'b2'], [2, 'b3'], [3, 'b4']]);
    assert.equal(before.total, 7);
    assert.deepEqual(db.conversationPage('c1', { before: 0 }).items, []);
  } finally {
    close();
  }
});

test('chunked bubble list: an empty chat and a missing chat do not break', () => {
  const fx = new CursorFixture();
  fx.chat('c1');
  fx.conversation('c1', [], { layout: 'chunked' });
  const db = new CursorDb(fx.file);
  try {
    db.open();
    const t = db.composerTail('c1');
    assert.equal(t.bubbleCount, 0);
    assert.equal(t.lastBubble, null);
    assert.equal(db.composerTail('nope'), null);
    assert.deepEqual(db.recentActivity('c1'), []);
    assert.equal(db.lastAssistantMessage('c1'), null);
  } finally {
    db.close();
    fx.close();
  }
});

test('db compat: both layouts are healthy; an emptied list with nowhere else to look is reported', () => {
  const build3 = (layout) => {
    const fx = new CursorFixture();
    for (let i = 1; i <= 3; i++) {
      fx.chat(`c${i}`, { lastUpdatedAt: T0 + i });
      fx.conversation(`c${i}`, BUBBLES.slice(0, 3), { layout, chunkSize: 2 });
    }
    return fx;
  };
  const evaluate = (fx) => {
    const db = new CursorDb(fx.file);
    db.open();
    try {
      return evaluateDbCompat(db, { visibleCount: 3 });
    } finally {
      db.close();
    }
  };
  for (const layout of ['legacy', 'chunked']) {
    const fx = build3(layout);
    try {
      assert.deepEqual(evaluate(fx), { reasons: [], examined: 3 }, layout);
    } finally {
      fx.close();
    }
  }
  // What happened on Cursor 3.26 before the reader knew the new layout: the old array is empty and nothing replaces it.
  const lost = build3('chunked');
  try {
    lost.db.exec(`UPDATE cursorDiskKV SET value = json_remove(value, '$.headerLog') WHERE key LIKE 'composerData:%'`);
    assert.deepEqual(evaluate(lost).reasons, ['bubble_list_changed']);
  } finally {
    lost.close();
  }
});
