import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CursorDb } from '../src/cursor/db.js';
import { createLogger } from '../src/log.js';
import { FRESH_QUESTION_MS } from '../src/cursor/model.js';
import { WorkspaceResolver } from '../src/cursor/workspaces.js';
import { Store } from '../src/state/store.js';
import { Watcher } from '../src/watcher.js';
import { encodeQuestion } from './helpers/question-binary.js';
import { CursorFixture, QUESTION_PARAMS, approvingConversation, askingConversation, nullLogger, testConfig, tmpDir } from './helpers/fixture.js';

const T0 = 1_700_000_200_000;

function setup(overrides = {}, fixture = new CursorFixture(), logger = nullLogger) {
  const fx = fixture;
  const cfg = testConfig(fx, overrides);
  const clock = { t: T0 };
  const store = new Store(':memory:');
  const db = new CursorDb(fx.file);
  const resolver = new WorkspaceResolver({ dir: fx.wsDir, now: () => clock.t });
  const watcher = new Watcher({ db, resolver, store, config: cfg, logger, now: () => clock.t });
  const events = [];
  watcher.on('event', (e) => events.push(e));
  return {
    fx,
    store,
    watcher,
    events,
    clock,
    tick(ms = 1000) {
      clock.t += ms;
      watcher.tick();
    },
    chatOf: (id) => watcher.last.chats.find((c) => c.id === id),
    cleanup() {
      watcher.stop();
      store.close();
      fx.close();
    },
  };
}

const flagged = (extra = {}) => ({ hasBlockingPendingActions: true, ...extra });

test('on startup no notifications for existing state (leftovers, chat in progress)', () => {
  const s = setup();
  s.fx.chat('residuo-0001', { lastUpdatedAt: T0 - 1000, header: flagged() });
  s.fx.conversation('residuo-0001', [
    // question already answered but Cursor has not recalculated flag: leftover
    { id: 'b1', type: 2, createdAt: T0 - 2000, tool: { name: 'ask_question', status: 'completed', toolCallId: 'old', additionalData: { status: 'submitted' } } },
  ]);
  s.fx.chat('inizio-0002', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.tick();
  s.tick();
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf('residuo-0001').attention.kind, 'leftover');
  assert.equal(s.chatOf('inizio-0002').running, true);
  s.cleanup();
});

test('live question at startup: recent -> notification; old -> no notification but marked as already notified', () => {
  const s = setup();
  // real pending-question state: bubble completed with additionalData pending (no longer loading)
  const pending = { status: 'completed', additionalData: { status: 'pending' } };
  s.fx.chat('recente-0001', { lastUpdatedAt: T0 - 5000, header: flagged() });
  askingConversation(s.fx, 'recente-0001', { toolCallId: 'tc-new', at: T0 - 10_000, ...pending });
  s.fx.chat('vecchia-0002', { workspaceId: 'ws-2', path: '/Users/demo/altro', lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  askingConversation(s.fx, 'vecchia-0002', { toolCallId: 'tc-old', at: T0 - 7_200_000, ...pending });
  s.watcher.tick();
  assert.deepEqual(s.events.map((e) => [e.type, e.chat.id, e.dedupeKey]), [['attention', 'recente-0001', 'a:recente-0001:tc-new']]);
  assert.equal(s.store.hasNotified('a:vecchia-0002:tc-old'), true, 'marked silently: will never fire late');
  assert.equal(s.chatOf('vecchia-0002').attention.kind, 'question', 'but remains visible in app');
  s.cleanup();
});

test('new question after startup: one event; a later question generates another', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 1000 });
  s.watcher.tick();
  assert.deepEqual(s.events, []);

  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 500, header: flagged() });
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-1', at: T0 + 400 });
  s.tick();
  s.tick();
  s.tick();
  assert.equal(s.events.length, 1);
  const ev = s.events[0];
  assert.equal(ev.type, 'attention');
  assert.equal(ev.attention.kind, 'question');
  assert.equal(ev.attention.prompt, QUESTION_PARAMS.questions[0].prompt);
  assert.equal(ev.attention.title, QUESTION_PARAMS.title);
  assert.equal(s.chatOf('chat-00000001').attention.question.questions[0].options.length, 2);

  // turn ends: same question, now completed/pending (real lifecycle) -> still a question, no new event
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-1', at: T0 + 400, status: 'completed', additionalData: { status: 'pending' } });
  s.tick();
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'question');
  assert.equal(s.chatOf('chat-00000001').attention.live, true);
  assert.equal(s.events.length, 1);

  // answer given: flag off, tool completed -> no attention and no new event
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 5000, header: { hasBlockingPendingActions: false } });
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-1', status: 'completed', additionalData: { status: 'submitted' } });
  s.tick();
  assert.equal(s.chatOf('chat-00000001').attention, null);
  assert.equal(s.events.length, 1);

  // NEW question (new toolCallId): new event
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 9000, header: flagged() });
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-2', at: T0 + 8900 });
  s.tick();
  assert.equal(s.events.length, 2);
  assert.equal(s.events[1].dedupeKey, 'a:chat-00000001:tc-2');
  s.cleanup();
});

test('a leftover (flag without live request) never generates notifications but appears in Need attention', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 1000 });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 100, header: flagged() });
  s.fx.conversation('chat-00000001', [{ id: 'b1', type: 2, createdAt: T0 + 50, text: 'ok' }]);
  s.tick();
  s.tick();
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'leftover');
  s.cleanup();
});

test('chat finished: after a long enough run with no pending requests, a single event', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 1000 });
  s.watcher.tick();
  // run starts
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 100, header: { unfinishedRunAt: T0 + 100 } });
  s.tick();
  assert.equal(s.chatOf('chat-00000001').running, true);
  s.tick(30_000); // 30 s later
  // run ends: marker removed
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 31_000, header: { unfinishedRunAt: undefined, hasUnreadMessages: true } });
  s.fx.conversation('chat-00000001', [{ id: 'b1', type: 2, createdAt: T0 + 30_900, text: 'fatto' }]);
  s.tick();
  s.tick();
  s.tick();
  assert.deepEqual(s.events.map((e) => [e.type, e.dedupeKey]), [['done', 'd:chat-00000001:' + (T0 + 31_000)]]);
  assert.equal(s.chatOf('chat-00000001').unread, true);
  s.cleanup();
});

test('chat finished: run too short (below threshold) = no event', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 1000 });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 100, header: { unfinishedRunAt: T0 + 100 } });
  s.tick();
  s.tick(4000);
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 5000, header: { unfinishedRunAt: undefined } });
  s.tick();
  s.tick();
  assert.deepEqual(s.events, []);
  s.cleanup();
});

test('chat in progress at daemon startup: notified when it finishes', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  assert.deepEqual(s.events, []);
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 2000, header: { unfinishedRunAt: undefined } });
  s.tick();
  s.tick();
  assert.deepEqual(s.events.map((e) => e.type), ['done']);
  s.cleanup();
});

test('run ending with live question notifies the question, not "done"', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 40_000, header: { unfinishedRunAt: undefined, ...flagged() } });
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-q', at: T0 + 39_900 });
  s.tick(40_000);
  s.tick();
  s.tick();
  assert.deepEqual(s.events.map((e) => e.type), ['attention']);
  s.cleanup();
});

test('real question lifecycle: loading, then completed/pending when run ends, then answer and new run', () => {
  // Sequence observed live (FINDINGS 9.1): flag turns on with question; 5-33 s later turn ends
  // (bubble completed/pending, composer `completed`) while header still shows run; answer arrives hours later.
  const s = setup({ doneSettleMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 600_000 } });
  s.fx.conversation(id, [{ id: 'b1', type: 1, createdAt: T0 - 600_000, text: 'Lavora' }], { status: 'aborted' });
  s.watcher.tick();
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf(id).running, true);

  // 1) agent asks question: flag on, bubble loading, run still in progress
  s.fx.chat(id, { header: { hasBlockingPendingActions: true } });
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 500, status: 'loading', composerStatus: 'aborted' });
  s.tick();
  assert.deepEqual(s.events.map((e) => e.type), ['attention']);

  // 2) turn ends: question stays pending; header is late and still shows run
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 500, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.tick(33_000);
  assert.equal(s.chatOf(id).running, false, 'composer says run finished even if header is late');
  s.tick(6000);
  s.tick(30_000);
  assert.deepEqual(s.events.map((e) => e.type), ['attention'], 'neither "done" nor a second notification for same question');
  assert.equal(s.chatOf(id).attention.kind, 'question');
  assert.equal(s.chatOf(id).attention.live, true);

  // header catches up (marker removed): nothing new
  s.fx.chat(id, { header: { unfinishedRunAt: undefined } });
  s.tick();
  assert.deepEqual(s.events.map((e) => e.type), ['attention']);

  // 3) hours later user answers: flag off, bubble submitted, new run
  s.tick(3_600_000);
  const t3 = s.clock.t;
  s.fx.chat(id, { lastUpdatedAt: t3, header: { hasBlockingPendingActions: false, unfinishedRunAt: t3 } });
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 500, status: 'completed', additionalData: { status: 'submitted' }, composerStatus: 'aborted' });
  s.tick();
  assert.equal(s.chatOf(id).attention, null);
  assert.equal(s.chatOf(id).running, true);

  // 4) new run lasts 2 minutes and ends normally: composer `completed`, header still late
  s.tick(120_000);
  s.fx.conversation(id, [{ id: 'b9', type: 2, createdAt: s.clock.t, text: 'Fatto' }], { status: 'completed' });
  s.tick();
  s.tick(6000);
  assert.deepEqual(s.events.map((e) => e.type), ['attention', 'done'], 'single "done", without waiting for header');
  s.cleanup();
});

test('early run end from composer: "done" fires even if header still shows run in progress', () => {
  const s = setup({ doneSettleMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.fx.conversation(id, [{ id: 'b1', type: 1, createdAt: T0 - 500, text: 'x' }], { status: 'aborted' });
  s.watcher.tick();
  assert.equal(s.chatOf(id).running, true);
  s.tick(10_000);
  assert.equal(s.chatOf(id).running, true, '`aborted` is state during run: header wins');
  s.fx.conversation(id, [{ id: 'b1', type: 1, createdAt: T0 - 500, text: 'x' }, { id: 'b2', type: 2, createdAt: T0 + 30_000, text: 'ok' }], { status: 'completed' });
  s.tick(20_000);
  assert.equal(s.chatOf(id).running, false);
  assert.deepEqual(s.events, [], 'still within settling window');
  s.tick(6000);
  assert.deepEqual(s.events.map((e) => e.type), ['done']);
  s.tick(60_000);
  assert.deepEqual(s.events.map((e) => e.type), ['done'], 'late header does not produce more events');
  s.cleanup();
});

test('run ending with open question but flag not yet updated is not "done"', () => {
  const s = setup({ doneSettleMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat(id, { lastUpdatedAt: T0 + 40_000, header: { unfinishedRunAt: undefined } }); // no flag (late)
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 39_900, status: 'completed', additionalData: { status: 'pending' } });
  s.tick(40_000);
  s.tick(6000);
  assert.equal(s.events.filter((e) => e.type === 'done').length, 0);
  s.cleanup();
});

test('chat with flag already on: new question without header changes appears on periodic rescan', () => {
  const s = setup({ fullScanMs: 5000 });
  const id = 'chat-00000001';
  // old unanswered question with flag on (common in real data): at startup, silently
  s.fx.chat(id, { lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  askingConversation(s.fx, id, { toolCallId: 'tc-old', at: T0 - 7_200_000, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.watcher.tick();
  assert.deepEqual(s.events, []);

  // agent asks a NEW one: flag already on, so header does not change
  askingConversation(s.fx, id, { toolCallId: 'tc-new', at: T0 + 500, status: 'loading', composerStatus: 'aborted' });
  s.tick(1000);
  assert.deepEqual(s.events, [], 'rescan not due yet');
  s.tick(5000);
  assert.deepEqual(s.events.map((e) => e.dedupeKey), [`a:${id}:tc-new`]);
  s.cleanup();
});

test('boost after phone action: new question visible after 250 ms instead of periodic rescan', () => {
  const s = setup({ fullScanMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  askingConversation(s.fx, id, { toolCallId: 'tc-old', at: T0 - 7_200_000, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.watcher.tick();
  s.watcher.boost(id, 60_000);
  askingConversation(s.fx, id, { toolCallId: 'tc-new', at: T0 + 500, status: 'loading', composerStatus: 'aborted' });
  s.tick(250);
  assert.deepEqual(s.events.map((e) => e.dedupeKey), [`a:${id}:tc-new`]);
  s.cleanup();
});

test('late header (FINDINGS 9.7): freshly posted question notifies immediately without waiting for flag; flag afterward does not generate another', () => {
  // Real data: flag appeared in header +4.8 s or +41 s after question (60 s periodic write).
  const s = setup({ fullScanMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000 }); // header static: no flag, no run
  s.watcher.tick();
  assert.deepEqual(s.events, []);

  // Cursor creates question bubble; header does NOT change
  askingConversation(s.fx, id, { toolCallId: 'tc-fresh', at: T0 + 500, status: 'loading', composerStatus: 'aborted' });
  s.tick(5000);
  assert.deepEqual(s.events.map((e) => [e.type, e.dedupeKey]), [['attention', `a:${id}:tc-fresh`]]);
  assert.equal(s.chatOf(id).attention.live, true);

  // bubble becomes completed/pending, then (after tens of seconds) flag arrives: no second event
  askingConversation(s.fx, id, { toolCallId: 'tc-fresh', at: T0 + 500, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.tick(5000);
  s.fx.chat(id, { lastUpdatedAt: T0 + 40_000, header: flagged() });
  s.tick(5000);
  assert.equal(s.events.length, 1, 'same question (same toolCallId): one event only');
  assert.equal(s.chatOf(id).attention.live, true);

  // answer given: bubble becomes submitted while flag stays on until next header write
  askingConversation(s.fx, id, { toolCallId: 'tc-fresh', at: T0 + 500, status: 'completed', additionalData: { status: 'submitted' }, composerStatus: 'completed' });
  s.tick(5000);
  assert.equal(s.chatOf(id).attention.kind, 'leftover');
  assert.equal(s.events.length, 1);
  s.cleanup();
});

test('late header: unanswered but OLD question with flag off is not live and does not notify', () => {
  // e.g. tool stuck `loading` after interrupted run: without flag cannot know someone is expected.
  const s = setup({ fullScanMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000 });
  askingConversation(s.fx, id, { toolCallId: 'tc-stale', at: T0 - FRESH_QUESTION_MS - 1000, status: 'loading', composerStatus: 'aborted' });
  s.watcher.tick();
  s.tick(5000);
  s.tick(5000);
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf(id).attention, null);
  s.cleanup();
});

test('flag on from old question while chat is working: running commands are not requests (regression)', () => {
  // Real case (FINDINGS 9.1): 68 false events in 28 minutes. Each command starts `loading` without `userDecision`,
  // exactly like an approval would, and flag stayed on for question from hours earlier.
  const s = setup();
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  askingConversation(s.fx, id, { toolCallId: 'tc-old', at: T0 - 7_200_000, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.watcher.tick(); // startup: old question marked silently
  assert.deepEqual(s.events, []);

  // user replies with freeform message: run starts, flag stays on (as Cursor does)
  s.fx.chat(id, { lastUpdatedAt: T0 + 100, header: flagged({ unfinishedRunAt: T0 + 100 }) });
  const bubbles = [{ id: 'b0', type: 1, createdAt: T0 + 100, text: 'Vai avanti' }];
  for (let i = 1; i <= 12; i++) {
    const tool = (status, ad) => ({ name: 'run_terminal_command_v2', status, toolCallId: `tc-cmd-${i}`, additionalData: { status: ad } });
    bubbles.push({ id: `c${i}`, type: 2, createdAt: T0 + i * 5000, tool: tool('loading', 'cancelled') });
    s.fx.conversation(id, bubbles, { status: 'aborted' });
    s.tick(5000);
    assert.deepEqual(s.events, [], `command ${i} running: no notification`);
    const a = s.chatOf(id).attention;
    assert.deepEqual({ kind: a.kind, live: a.live }, { kind: 'leftover', live: false }, `command ${i}: stays leftover`);
    bubbles[bubbles.length - 1] = { ...bubbles[bubbles.length - 1], tool: tool('completed', 'success') };
  }

  // run ends: single "done", no "attention"
  bubbles.push({ id: 'z', type: 2, createdAt: T0 + 69_000, text: 'Fatto' });
  s.fx.conversation(id, bubbles, { status: 'completed' });
  s.fx.chat(id, { lastUpdatedAt: T0 + 70_000, header: flagged({ unfinishedRunAt: undefined, hasUnreadMessages: true }) });
  s.tick(5000);
  assert.deepEqual(s.events.map((e) => e.type), ['done']);
  s.cleanup();
});

test('pending approval (FINDINGS 11): notifies only after approvalDelayMs, once, without the command', () => {
  const s = setup({ approvalDelayMs: 8000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } }); // run in progress
  s.watcher.tick();
  assert.deepEqual(s.events, []);

  // command requests approval: agent waits, run still appears in progress
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap', at: T0 + 500, composerStatus: 'aborted' });
  s.tick(1000);
  const a = s.chatOf(id).attention;
  assert.deepEqual({ kind: a.kind, live: a.live, key: a.key, toolName: a.toolName }, { kind: 'approval', live: true, key: 'tc-ap', toolName: 'run_terminal_command_v2' });
  assert.deepEqual(s.events, [], 'just appeared: wait, you may approve on Mac immediately');
  s.tick(5000);
  s.tick(2000);
  assert.deepEqual(s.events, [], 'still under delay');
  s.tick(1000); // 8 s continuous wait
  assert.equal(s.events.length, 1);
  const e = s.events[0];
  assert.deepEqual([e.type, e.dedupeKey, e.attention.kind, e.attention.toolName], ['attention', `a:${id}:tc-ap`, 'approval', 'run_terminal_command_v2']);
  assert.doesNotMatch(JSON.stringify(e), /echo prova/, 'command never leaves daemon');

  s.tick(60_000);
  s.tick(60_000);
  assert.equal(s.events.length, 1, 'no reminders: same request, one event only');

  // NEW request (other toolCallId) is another event, after its delay
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap2', at: s.clock.t, composerStatus: 'aborted' });
  s.tick(1000);
  assert.equal(s.events.length, 1);
  s.tick(8000);
  assert.deepEqual(s.events.map((x) => x.dedupeKey), [`a:${id}:tc-ap`, `a:${id}:tc-ap2`]);
  s.cleanup();
});

test('approval: log records appearance and end (numbers and booleans only, never content)', () => {
  const lines = [];
  const logger = createLogger({ level: 'debug', stream: { write: (l) => lines.push(JSON.parse(l)) } });
  const s = setup({ approvalDelayMs: 8000 }, new CursorFixture(), logger);
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } });
  s.watcher.tick();
  approvingConversation(s.fx, id, { toolCallId: 'tc-segreto', at: T0 + 500, composerStatus: 'aborted' });
  s.tick(1000);
  s.tick(9000); // notified
  approvingConversation(s.fx, id, { toolCallId: 'tc-segreto', at: T0 + 500, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
  s.tick(1000);
  const seen = lines.filter((l) => l.event === 'approval_seen');
  const gone = lines.filter((l) => l.event === 'approval_gone');
  assert.equal(seen.length, 1);
  assert.deepEqual({ running: seen[0].running, flag: seen[0].flag, initial: seen[0].initial }, { running: true, flag: false, initial: false });
  assert.equal(gone.length, 1);
  assert.deepEqual({ notified: gone[0].notified, waitedSec: gone[0].waitedSec }, { notified: true, waitedSec: 10 });
  const all = JSON.stringify(lines);
  assert.equal(all.includes('tc-segreto'), false, 'no tool identifier in log');
  assert.equal(all.includes('echo prova'), false, 'no command in log');
  s.cleanup();
});

test('approval decided on Mac before delay: no notification', () => {
  const s = setup({ approvalDelayMs: 8000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } });
  s.watcher.tick();
  approvingConversation(s.fx, id, { at: T0 + 500, composerStatus: 'aborted' });
  s.tick(1000);
  s.tick(3000);
  assert.deepEqual(s.events, []);

  // you approve on Mac: reviewData becomes Done and command runs
  approvingConversation(s.fx, id, { at: T0 + 500, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
  s.tick(1000);
  assert.equal(s.chatOf(id).attention, null);
  s.tick(20_000);
  assert.deepEqual(s.events, [], 'never notified');
  assert.equal(s.store.hasNotified(`a:${id}:tc-ap`), false);

  // delay resets for next request: single wait, not stacked old waits
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap3', at: s.clock.t, composerStatus: 'aborted' });
  s.tick(1000);
  s.tick(7000);
  assert.deepEqual(s.events, []);
  s.tick(1000);
  assert.deepEqual(s.events.map((x) => x.dedupeKey), [`a:${id}:tc-ap3`]);
  s.cleanup();
});

test('approval already present at startup: recent = notify immediately; old = app only', () => {
  const s = setup({ approvalDelayMs: 8000 });
  s.fx.chat('recente-0001', { lastUpdatedAt: T0 - 5000, header: { unfinishedRunAt: T0 - 20_000 } });
  approvingConversation(s.fx, 'recente-0001', { toolCallId: 'tc-new', at: T0 - 10_000, composerStatus: 'aborted' });
  s.fx.chat('vecchia-0002', { workspaceId: 'ws-2', path: '/Users/demo/altro', lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  approvingConversation(s.fx, 'vecchia-0002', { toolCallId: 'tc-old', at: T0 - 7_200_000, composerStatus: 'completed' });
  s.watcher.tick();
  assert.deepEqual(s.events.map((e) => [e.type, e.chat.id, e.dedupeKey]), [['attention', 'recente-0001', 'a:recente-0001:tc-new']], 'without waiting for delay from scratch');
  assert.equal(s.store.hasNotified('a:vecchia-0002:tc-old'), true, 'marked silently');
  assert.equal(s.chatOf('vecchia-0002').attention.kind, 'approval', 'but remains visible in app');
  s.tick(30_000);
  s.tick(30_000);
  assert.equal(s.events.length, 1);
  s.cleanup();
});

test('approval: leftover (Cursor closed mid-way, chat idle, no flag) is not a request and does not notify', () => {
  const s = setup({ approvalDelayMs: 0 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000 });
  s.watcher.tick();
  approvingConversation(s.fx, id, { at: T0 - FRESH_QUESTION_MS - 5000, composerStatus: 'completed' });
  s.tick(1000);
  s.tick(10_000);
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf(id).attention, null);
  s.cleanup();
});

test('approval: Cursor looks at last TWO bubbles; a later message does not hide it', () => {
  const s = setup({ approvalDelayMs: 0 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } });
  s.watcher.tick();
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap', at: T0 + 500, composerStatus: 'aborted', trailing: [{ id: 'b3', type: 2, createdAt: T0 + 900, text: 'Aspetto il via libera' }] });
  s.tick(1000);
  assert.deepEqual(s.events.map((e) => e.dedupeKey), [`a:${id}:tc-ap`]);
  assert.equal(s.chatOf(id).attention.bubbleId, 'b2');
  // two bubbles later: no longer among last two (leftover)
  approvingConversation(s.fx, id, {
    toolCallId: 'tc-ap',
    at: T0 + 500,
    composerStatus: 'completed',
    trailing: [
      { id: 'b3', type: 2, createdAt: T0 + 900, text: 'x' },
      { id: 'b4', type: 2, createdAt: T0 + 1000, text: 'y' },
    ],
  });
  s.fx.chat(id, { lastUpdatedAt: T0 + 1000, header: { unfinishedRunAt: undefined } });
  s.tick(200_000);
  assert.equal(s.chatOf(id).attention, null);
  s.cleanup();
});

test('run stopping on approval is not "done": approval first, never "done" while waiting', () => {
  const s = setup({ approvalDelayMs: 0 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick(); // run in progress at startup: "long enough"
  approvingConversation(s.fx, id, { at: T0 + 2000, composerStatus: 'completed' });
  s.fx.chat(id, { lastUpdatedAt: T0 + 40_000, header: flagged({ unfinishedRunAt: undefined }) });
  s.tick(40_000);
  s.tick(10_000);
  assert.deepEqual(s.events.map((e) => e.type), ['attention']);
  s.cleanup();
});

test('run ending with queued messages is not "done"', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 40_000, header: { unfinishedRunAt: undefined } });
  s.fx.conversation('chat-00000001', [{ id: 'b1', type: 2, createdAt: T0 + 39_000, text: 'x' }], { queueItems: [{ id: 'q1' }] });
  s.tick(40_000);
  s.tick();
  assert.equal(s.events.filter((e) => e.type === 'done').length, 0);
  s.cleanup();
});

test('settling: "done" only after doneSettleMs without run resuming', () => {
  const s = setup({ doneSettleMs: 5000 });
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 2000, header: { unfinishedRunAt: undefined } });
  s.tick(); // observed run end
  s.tick(); // +1 s
  s.tick(2000); // +3 s
  assert.deepEqual(s.events, [], 'still within settling window');
  s.tick(3000); // +6 s
  assert.deepEqual(s.events.map((e) => e.type), ['done']);
  s.cleanup();
});

test('settling: if run resumes within window (next agent step) there is no "done"', () => {
  const s = setup({ doneSettleMs: 5000 });
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 2000, header: { unfinishedRunAt: undefined } });
  s.tick();
  s.tick(2000);
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 4000, header: { unfinishedRunAt: T0 + 4000 } }); // resumes
  s.tick();
  s.tick(10_000);
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf('chat-00000001').running, true);
  s.cleanup();
});

test('exclusions: archived, subagents, drafts, empty and remote omitted; classic chats follow option', () => {
  const s = setup();
  s.fx.chat('archiviata-01', { archived: true });
  s.fx.chat('sottoagente-1', { subagent: true });
  s.fx.chat('bozza-0000001', { header: { isDraft: true } });
  s.fx.chat('vuota-0000001', { lastUpdatedAt: 0 });
  s.fx.chat('remota-000001', { location: { type: 'remote-ssh', environment: { id: 'x' } } });
  s.fx.chat('classica-0001', { location: null, workspaceId: 'ws-9' });
  s.fx.setWorkspaceJson('ws-9', '/Users/demo/classico');
  s.fx.chat('normale-00001');
  s.watcher.tick();
  assert.deepEqual(s.watcher.last.chats.map((c) => c.id).sort(), ['classica-0001', 'normale-00001']);
  assert.equal(s.chatOf('classica-0001').workspaceName, 'classico', 'resolved from workspaceStorage');
  s.cleanup();

  const t = setup({ includeClassicChats: false });
  t.fx.chat('classica-0001', { location: null });
  t.fx.chat('normale-00001');
  t.watcher.tick();
  assert.deepEqual(t.watcher.last.chats.map((c) => c.id), ['normale-00001']);
  t.cleanup();
});

test('projects removed from sidebar: their chats hidden and do not notify; if project returns, they reappear', () => {
  const s = setup();
  s.fx.chat('normale-00001');
  // not archived, but project removed from Cursor sidebar (workspaceId column)
  s.fx.chat('rimossa-00001', { workspaceId: 'ws-rimosso', path: '/Users/demo/vecchio' });
  // same project recognized only from header.workspaceIdentifier.id
  s.fx.chat('rimossa-00002', { workspaceId: 'altra-colonna', path: '/Users/demo/vecchio', header: { workspaceIdentifier: { id: 'ws-rimosso' } } });
  // live question in removed project must never notify
  s.fx.chat('domanda-00003', { workspaceId: 'ws-rimosso', path: '/Users/demo/vecchio', lastUpdatedAt: T0 - 1000, header: flagged() });
  askingConversation(s.fx, 'domanda-00003', { toolCallId: 'tc-rem', at: T0 - 2000, status: 'completed', additionalData: { status: 'pending' } });
  s.fx.setRemovedProjects(['ws-rimosso', 'ws-mai-usato']);

  s.watcher.tick();
  s.tick();
  assert.deepEqual(s.watcher.last.chats.map((c) => c.id), ['normale-00001']);
  assert.deepEqual(s.events, [], 'no notification for chats sidebar does not show');

  // user re-adds project: after settings rescan (10 s) chats reappear
  s.fx.setRemovedProjects([]);
  s.tick(11_000);
  assert.deepEqual(s.watcher.last.chats.map((c) => c.id).sort(), ['domanda-00003', 'normale-00001', 'rimossa-00001', 'rimossa-00002']);
  s.cleanup();
});

test('removed projects: missing, unreadable or incomplete list = no chats hidden', () => {
  for (const raw of [undefined, 'non e\' json', '{"a":1}', '[null, 7, {"id":"x"}, {"workspaceIdentifier":{}}, {"workspaceIdentifier":{"id":42}}]']) {
    const s = setup();
    s.fx.chat('chat-00000001', { workspaceId: 'ws-1' });
    if (raw !== undefined) s.fx.setRemovedProjects(raw);
    s.watcher.tick();
    assert.equal(s.watcher.status.ok, true);
    assert.deepEqual(s.watcher.last.chats.map((c) => c.id), ['chat-00000001'], `value: ${String(raw).slice(0, 20)}`);
    s.cleanup();
  }
});

test('unreadable database: no exception, status not ok; recovers on its own when readable again', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.vscdb');
  const store = new Store(':memory:');
  const cfg = testConfig({ file, wsDir: path.join(dir, 'ws'), dir });
  const watcher = new Watcher({ db: new CursorDb(file), resolver: new WorkspaceResolver({ dir: cfg.workspaceStorageDir }), store, config: cfg, logger: nullLogger, now: () => T0 });
  const statuses = [];
  watcher.on('status', (st) => statuses.push(st.ok));
  watcher.tick();
  assert.equal(watcher.status.ok, false);
  const fx = new CursorFixture(dir);
  fx.chat('chat-00000001');
  watcher.tick();
  assert.equal(watcher.status.ok, true);
  assert.equal(watcher.last.chats.length, 1);
  assert.deepEqual(statuses, [false, true]);
  watcher.stop();
  store.close();
  fx.close();
});

test('READ ONLY: Cursor database file unchanged after full scans', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { header: flagged() });
  askingConversation(s.fx, 'chat-00000001');
  s.fx.setSidebar({ groupBy: 'workspace', sortGroupsBy: 'manual' });
  s.fx.close(); // closes write connection: nothing writes from here on
  const sha = () => crypto.createHash('sha256').update(fs.readFileSync(s.fx.file)).digest('hex');
  const before = sha();
  for (let i = 0; i < 5; i++) s.tick();
  s.watcher.detail('chat-00000001');
  const after = sha();
  assert.equal(after, before);
  assert.equal(fs.existsSync(`${s.fx.file}-journal`), false);
  s.watcher.stop();
  s.store.close();
});

test('on-demand detail: last assistant message and question text (open or already answered)', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { header: flagged() });
  const conversation = (additionalStatus) =>
    s.fx.conversation('chat-00000001', [
      { id: 'b1', type: 2, createdAt: T0 - 3000, text: 'Prima risposta' },
      { id: 'b2', type: 1, createdAt: T0 - 2000, text: 'domanda utente' },
      { id: 'b3', type: 2, createdAt: T0 - 1000, text: 'Ultima risposta' },
      { id: 'b4', type: 2, createdAt: T0 - 500, tool: { name: 'ask_question', status: 'completed', toolCallId: 'x', params: QUESTION_PARAMS, additionalData: { status: additionalStatus } } },
    ]);
  conversation('pending');
  s.watcher.tick();
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'question');
  const d = s.watcher.detail('chat-00000001');
  assert.equal(d.lastMessage.text, 'Ultima risposta');
  assert.equal(d.question.title, QUESTION_PARAMS.title);
  assert.equal(s.watcher.detail('inesistente'), null);

  // question already answered but flag still on (leftover): text still readable
  conversation('submitted');
  s.tick();
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'leftover');
  assert.equal(s.watcher.detail('chat-00000001').question.title, QUESTION_PARAMS.title);
  s.cleanup();
});

test('on-demand detail: "recent activity" newest-first, tool action type only (never commands or paths)', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { header: flagged() });
  s.fx.conversation('chat-00000001', [
    { id: 'b1', type: 1, createdAt: T0 - 5000, text: 'Fai il refactoring\nsecondo rigo' },
    { id: 'b2', type: 2, createdAt: T0 - 4000, tool: { name: 'read_file_v2', status: 'completed', toolCallId: 't1', params: { path: '/segreto/percorso.txt' } } },
    { id: 'b3', type: 2, createdAt: T0 - 3000, text: 'Ho letto il file, ora lo modifico.' },
    { id: 'b4', type: 2, createdAt: T0 - 2000, tool: { name: 'run_terminal_command_v2', status: 'completed', toolCallId: 't2', params: { command: 'rm -rf /segreto' } } },
    { id: 'b5', type: 2, createdAt: T0 - 1000, tool: { name: 'strumento_nuovo', status: 'loading', toolCallId: 't3', params: {} } },
  ]);
  s.tick();
  const a = s.watcher.detail('chat-00000001').activity;
  assert.deepEqual(
    a.map((x) => [x.kind, x.action, x.state]),
    [
      ['tool', 'other_action', 'running'],
      ['tool', 'run_command', 'done'],
      ['assistant', 'agent_reply', ''],
      ['tool', 'read_file', 'done'],
      ['user', 'message_sent', ''],
    ],
  );
  assert.equal(a[4].preview, 'Fai il refactoring');
  const json = JSON.stringify(a);
  assert.equal(json.includes('segreto'), false);
  s.cleanup();
});

test('newly created question: params still empty but text read from toolCallBinary (then params, same)', () => {
  const s = setup();
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0, header: flagged() });
  const q = { title: 'Titolo', questions: [{ id: 'q1', prompt: 'Quale?', options: [{ id: 'a', label: 'Uno' }, { id: 'b', label: 'Due' }] }] };
  const tool = (extra) => ({ name: 'ask_question', status: 'loading', toolCallId: 'tc-bin', ...extra });
  const bubbles = (t) => [{ id: 'b1', type: 2, createdAt: T0 - 500, tool: t }];
  s.fx.conversation(id, bubbles(tool({ binary: encodeQuestion(q) })));
  s.tick();
  assert.equal(s.chatOf(id).attention.kind, 'question');
  assert.equal(s.watcher.detail(id).question.questions[0].prompt, 'Quale?');
  assert.deepEqual(s.watcher.detail(id).question.questions[0].options.map((o) => o.id), ['a', 'b']);
  // then Cursor writes params: same question
  s.fx.conversation(id, bubbles(tool({ status: 'completed', params: q, binary: encodeQuestion(q), additionalData: { status: 'pending' } })));
  s.tick();
  assert.equal(s.watcher.detail(id).question.questions[0].prompt, 'Quale?');
  // empty binary and empty params (args not written yet): live attention but no text
  s.fx.conversation(id, bubbles(tool({})));
  s.tick(2000);
  assert.equal(s.chatOf(id).attention.kind, 'question');
  assert.equal(s.watcher.detail(id).question, null);
  s.cleanup();
});
