import test from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_QUESTION_MS, buildChat, classifyAttention, headerSignature, isPendingQuestion, isPendingReview, isRunning, isVisibleLocalChat } from '../src/cursor/model.js';
import { normalizeQuestionParams } from '../src/cursor/questions.js';

const NOW = 1_700_000_000_000;
const entry = (header = {}, extra = {}) => ({ id: 'c1', workspaceId: 'w', createdAt: NOW - 1000, lastUpdatedAt: NOW - 500, header, ...extra });

test('visibility: not archived, not subagent, not draft, with activity, local', () => {
  const loc = { type: 'local', status: 'active', environment: { id: 'e' } };
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc })), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: { ...loc, type: 'worktree' } })), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: { ...loc, type: 'remote-ssh' } })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: { type: 'cloud' } })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, isDraft: true })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, isArchived: true })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, isSubagent: true })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { lastUpdatedAt: 0 })), false, 'empty chat');
  // classic chat (null agentLocation): depends on option
  assert.equal(isVisibleLocalChat(entry({}), { includeClassic: true }), true);
  assert.equal(isVisibleLocalChat(entry({}), { includeClassic: false }), false);
});

test('visibility: chats of a project REMOVED from the sidebar do not appear, even if not archived', () => {
  const loc = { type: 'local', status: 'active', environment: { id: 'e' } };
  const removed = new Set(['ws-rimosso']);
  // workspaceId column on header
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-rimosso' }), { removedWorkspaceIds: removed }), false);
  // or workspaceIdentifier.id inside header (same id)
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, workspaceIdentifier: { id: 'ws-rimosso' } }, { workspaceId: 'altro' }), { removedWorkspaceIds: removed }), false);
  // another workspace stays visible; empty or missing list hides nothing
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-vivo' }), { removedWorkspaceIds: removed }), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-rimosso' }), { removedWorkspaceIds: new Set() }), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-rimosso' })), true);
  // chat with no workspace id: cannot say it was removed
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: null }), { removedWorkspaceIds: removed }), true);
});

test('running: recent unfinishedRunAt marker; stale if too old', () => {
  const stale = 12 * 3_600_000;
  assert.equal(isRunning({ unfinishedRunAt: NOW - 1000 }, NOW, stale), true);
  assert.equal(isRunning({ unfinishedRunAt: NOW - stale - 1 }, NOW, stale), false, 'Cursor closed during run');
  assert.equal(isRunning({}, NOW, stale), false);
  assert.equal(isRunning({ unfinishedRunAt: 'x' }, NOW, stale), false);
});

test('classifyAttention: no flags, no attention', () => {
  assert.equal(classifyAttention({ entry: entry({}), tail: null, bubble: null, now: NOW }), null);
});

test('classifyAttention: stale header, RECENT unanswered question = live even with flag off', () => {
  const ask = (createdAt, tool = {}) => ({
    entry: entry({}), // no flag: Cursor header not rewritten yet
    tail: { lastBubble: { id: 'b9' } },
    bubble: { createdAt, tool: { name: 'ask_question', status: 'loading', toolCallId: 'tc-9', ...tool } },
    now: NOW,
  });
  // just posted (loading) and after completed/pending: same question, same key
  for (const tool of [{}, { status: 'completed', additionalStatus: 'pending' }]) {
    const a = classifyAttention(ask(NOW - 3000, tool));
    assert.deepEqual({ kind: a.kind, live: a.live, key: a.key, since: a.since }, { kind: 'domanda', live: true, key: 'tc-9', since: NOW - 3000 });
  }
  // window boundaries
  assert.equal(classifyAttention(ask(NOW - FRESH_QUESTION_MS)).live, true);
  assert.equal(classifyAttention(ask(NOW - FRESH_QUESTION_MS - 1)), null, 'past window, flag off, not a live request');
  // already answered, cancelled or not ask_question: never live
  assert.equal(classifyAttention(ask(NOW - 3000, { status: 'completed', additionalStatus: 'submitted' })), null);
  assert.equal(classifyAttention(ask(NOW - 3000, { status: 'completed', additionalStatus: 'cancelled' })), null);
  assert.equal(classifyAttention(ask(NOW - 3000, { name: 'run_terminal_command_v2' })), null);
  // bubble without timestamp: cannot say it is recent
  assert.equal(classifyAttention(ask(null)), null);
});

test('classifyAttention: live question = flag + last bubble ask_question in loading', () => {
  const a = classifyAttention({
    entry: entry({ hasBlockingPendingActions: true }),
    tail: { lastBubble: { id: 'b9' } },
    bubble: { createdAt: NOW - 100, tool: { name: 'ask_question', status: 'loading', toolCallId: 'tc-9' } },
    now: NOW,
  });
  assert.deepEqual({ kind: a.kind, key: a.key, live: a.live, since: a.since, bubbleId: a.bubbleId }, { kind: 'domanda', key: 'tc-9', live: true, since: NOW - 100, bubbleId: 'b9' });
});

test('isPendingQuestion: loading or completed with additionalData pending; answered, cancelled or other tool no', () => {
  const q = (status, additionalStatus, name = 'ask_question') => ({ name, status, additionalStatus });
  assert.equal(isPendingQuestion(q('loading')), true, 'first seconds');
  assert.equal(isPendingQuestion(q('completed', 'pending')), true, 'turn finished, question still unanswered');
  assert.equal(isPendingQuestion(q('completed', 'submitted')), false);
  assert.equal(isPendingQuestion(q('loading', 'submitted')), false);
  assert.equal(isPendingQuestion(q('completed', 'cancelled')), false);
  assert.equal(isPendingQuestion(q('completed')), false, 'without additional status not provably pending');
  assert.equal(isPendingQuestion(q('loading', null, 'run_terminal_command_v2')), false);
  assert.equal(isPendingQuestion(null), false);
});

test('classifyAttention: question stays a question after completed/pending (real lifecycle)', () => {
  const base = { entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b9' } }, now: NOW };
  const loading = classifyAttention({ ...base, bubble: { createdAt: NOW - 100, tool: { name: 'ask_question', status: 'loading', toolCallId: 't2' } } });
  const completed = classifyAttention({ ...base, bubble: { createdAt: NOW - 100, tool: { name: 'ask_question', status: 'completed', toolCallId: 't2', additionalStatus: 'pending' } } });
  assert.deepEqual({ kind: completed.kind, key: completed.key, live: completed.live }, { kind: 'domanda', key: 't2', live: true });
  assert.equal(completed.key, loading.key, 'same key in both states: no second notification');
  // Cursor may rewrite bubble (createdAt changes): key unchanged
  const rewritten = classifyAttention({ ...base, bubble: { createdAt: NOW + 5_000_000, tool: { name: 'ask_question', status: 'completed', toolCallId: 't2', additionalStatus: 'pending' } } });
  assert.equal(rewritten.key, 't2');
});

test('classifyAttention: answered (submitted) or cancelled question with flag still on = stale, not live', () => {
  const base = { entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b9' } }, now: NOW };
  const submitted = classifyAttention({ ...base, bubble: { tool: { name: 'ask_question', status: 'loading', toolCallId: 't', additionalStatus: 'submitted' } } });
  assert.equal(submitted.live, false);
  assert.equal(submitted.kind, 'residuo');
  const answered = classifyAttention({ ...base, bubble: { tool: { name: 'ask_question', status: 'completed', toolCallId: 't2', additionalStatus: 'submitted' } } });
  assert.equal(answered.kind, 'residuo');
  assert.equal(answered.key, 't2', 'key stays toolCallId: a NEW question has a different key');
  const cancelled = classifyAttention({ ...base, bubble: { tool: { name: 'ask_question', status: 'completed', toolCallId: 't3', additionalStatus: 'cancelled' } } });
  assert.equal(cancelled.kind, 'residuo');
  // question superseded by other messages (last text bubble) is no longer latest: stale
  const superseded = classifyAttention({ ...base, bubble: { tool: null } });
  assert.equal(superseded.kind, 'residuo');
  // without flag, pending question in bubble does not count: Cursor does not show dot
  const noFlag = classifyAttention({ entry: entry({}), tail: { lastBubble: { id: 'b9' } }, bubble: { tool: { name: 'ask_question', status: 'completed', toolCallId: 't4', additionalStatus: 'pending' } }, now: NOW });
  assert.equal(noFlag, null);
});

test('classifyAttention: tool other than ask_question is NEVER a live request (regression: 68 false events)', () => {
  // Real case (FINDINGS 9.1): chat with flag on from old unresolved question, now working: every command
  // starts `loading` without `userDecision`, like an approval would. Cannot distinguish:
  // so never `live`, never a notification.
  const base = { entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b3' } }, now: NOW };
  for (const name of ['run_terminal_command_v2', 'edit_file_v2', 'mcp-cursor-ide-browser-browser_click', 'task_v2']) {
    const a = classifyAttention({ ...base, bubble: { createdAt: NOW, tool: { name, status: 'loading', toolCallId: `tc-${name}` } } });
    assert.equal(a.kind, 'residuo', name);
    assert.equal(a.live, false, name);
  }
  const decided = classifyAttention({ ...base, bubble: { tool: { name: 'run_terminal_command_v2', status: 'loading', toolCallId: 'tc-y', userDecision: 'accepted' } } });
  assert.equal(decided.kind, 'residuo');
});

test('isPendingReview: only reviewData Requested; questions and plans have their own path', () => {
  const t = (name, status, approvalType = 'user') => ({ name, review: status ? { status, approvalType } : null });
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested')), true);
  assert.equal(isPendingReview(t('mcp-cursor-ide-browser-browser_click', 'Requested')), true, 'any MCP name');
  // automatic approvals (allowlist, "full auto"): Cursor decides, nothing to wait for
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', 'full_auto')), false);
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', 'allowlist')), false);
  // missing or unknown type: do not exclude (better extra notification than missed one)
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', null)), true);
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', 'qualcosa-di-nuovo')), true);
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Done')), false, 'already decided');
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'None')), false);
  assert.equal(isPendingReview(t('run_terminal_command_v2', null)), false, 'no reviewData: command in flight');
  assert.equal(isPendingReview(t('ask_question', 'Requested')), false);
  assert.equal(isPendingReview(t('create_plan', 'Requested')), false, 'plan has its own flag and stays Requested for hours');
  assert.equal(isPendingReview(null), false);
  assert.equal(isPendingReview({ name: 'run_terminal_command_v2' }), false);
});

test('classifyAttention: approval = reviewData Requested in last two bubbles (FINDINGS 11)', () => {
  const review = (extra = {}) => ({ name: 'run_terminal_command_v2', status: 'loading', toolCallId: 'tc-ap', review: { status: 'Requested', approvalType: 'user' }, ...extra });
  const last = { id: 'b5' };
  const prev = { id: 'b4' };
  const base = { entry: entry({}), tail: { lastBubble: last, prevBubble: prev }, now: NOW };

  // Just appeared: header not rewritten yet (no flag) but request is fresh = live.
  const fresh = classifyAttention({ ...base, bubble: { createdAt: NOW - 3000, tool: review() } });
  assert.deepEqual(
    { kind: fresh.kind, key: fresh.key, live: fresh.live, toolName: fresh.toolName, toolCallId: fresh.toolCallId, bubbleId: fresh.bubbleId, since: fresh.since },
    { kind: 'approvazione', key: 'tc-ap', live: true, toolName: 'run_terminal_command_v2', toolCallId: 'tc-ap', bubbleId: 'b5', since: NOW - 3000 },
  );

  // Old, no flag and chat idle: stale from Cursor closed mid-flight (no dot in Cursor) = no attention.
  const old = { createdAt: NOW - FRESH_QUESTION_MS - 1000, tool: review() };
  assert.equal(classifyAttention({ ...base, bubble: old }), null);
  // Old but chat working (agent waiting for you) or flag on: live.
  assert.equal(classifyAttention({ ...base, bubble: old, running: true }).live, true);
  assert.equal(classifyAttention({ ...base, entry: entry({ hasBlockingPendingActions: true }), bubble: old }).kind, 'approvazione');

  // Decided (Done) or never requested (None): not an approval; with flag on remains stale.
  for (const status of ['Done', 'None']) {
    const r = classifyAttention({ ...base, entry: entry({ hasBlockingPendingActions: true }), bubble: { createdAt: NOW, tool: review({ review: { status } }) } });
    assert.equal(r.kind, 'residuo', status);
    assert.equal(r.live, false, status);
  }

  // Cursor looks at last TWO bubbles: a message after the request does not hide it.
  const viaPrev = classifyAttention({ ...base, bubble: { createdAt: NOW, tool: null }, prevBubble: { createdAt: NOW - 2000, tool: review({ toolCallId: undefined }) } });
  assert.deepEqual({ kind: viaPrev.kind, key: viaPrev.key, live: viaPrev.live, bubbleId: viaPrev.bubbleId }, { kind: 'approvazione', key: 'b:b4', live: true, bubbleId: 'b4' });

  // Plan or question with reviewData Requested follow their path, do not become approvals.
  const plan = classifyAttention({ ...base, entry: entry({ hasPendingPlan: true }), bubble: { createdAt: NOW, tool: review({ name: 'create_plan' }) } });
  assert.equal(plan.kind, 'piano');
  // Open question takes precedence even if previous bubble was an approval.
  const q = classifyAttention({
    ...base,
    bubble: { createdAt: NOW - 1000, tool: { name: 'ask_question', status: 'loading', toolCallId: 'tq' } },
    prevBubble: { createdAt: NOW - 2000, tool: review() },
  });
  assert.equal(q.kind, 'domanda');
});

test('classifyAttention: flag without live request = stale; without bubble key is "chat"', () => {
  const a = classifyAttention({ entry: entry({ hasBlockingPendingActions: true }), tail: null, bubble: null, now: NOW });
  assert.deepEqual({ kind: a.kind, key: a.key, live: a.live, since: a.since }, { kind: 'residuo', key: 'chat', live: false, since: NOW - 500 });
  const b = classifyAttention({ entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b1' } }, bubble: { tool: null }, now: NOW });
  assert.equal(b.key, 'b:b1');
});

test('classifyAttention: pending plan', () => {
  const a = classifyAttention({ entry: entry({ hasPendingPlan: true }), tail: { lastBubble: { id: 'b4' } }, bubble: null, now: NOW });
  assert.deepEqual({ kind: a.kind, key: a.key, live: a.live }, { kind: 'piano', key: 'plan:b4', live: false });
});

test('headerSignature changes when relevant fields change', () => {
  const a = headerSignature(entry({ hasBlockingPendingActions: true }));
  assert.notEqual(a, headerSignature(entry({ hasBlockingPendingActions: false })));
  assert.notEqual(a, headerSignature(entry({ hasBlockingPendingActions: true, unfinishedRunAt: 5 })));
  assert.equal(a, headerSignature(entry({ hasBlockingPendingActions: true })));
});

test('buildChat: fallback title and no path in public view', () => {
  const ws = { sectionId: 's', name: 'app', parent: 'dev', home: false, path: '/Users/demo/app' };
  const chat = buildChat({ entry: entry({ name: '   ' }), ws, attention: null, now: NOW, staleRunMs: 1 });
  assert.equal(chat.name, 'Senza titolo');
  assert.equal(JSON.stringify(chat).includes('/Users/demo'), false);
});

test('buildChat: explicit `running` overrides header (run end seen from composer state)', () => {
  const ws = { sectionId: 's', name: 'app', parent: 'dev', home: false };
  const e = entry({ unfinishedRunAt: NOW - 1000 });
  assert.equal(buildChat({ entry: e, ws, attention: null, now: NOW, staleRunMs: 3_600_000 }).running, true, 'without override header wins');
  assert.equal(buildChat({ entry: e, ws, attention: null, now: NOW, staleRunMs: 3_600_000, running: false }).running, false);
});

test('normalizeQuestionParams: stable shape, limits and invalid values', () => {
  const q = normalizeQuestionParams(JSON.stringify({ title: 'T', questions: [{ id: 'q', prompt: 'P', options: [{ id: 'a', label: 'A' }, null, 'x'], allowMultiple: true }] }));
  assert.deepEqual(q, { title: 'T', questions: [{ id: 'q', prompt: 'P', options: [{ id: 'a', label: 'A' }], allowMultiple: true }] });
  assert.equal(normalizeQuestionParams('non json'), null);
  assert.equal(normalizeQuestionParams(null), null);
  assert.equal(normalizeQuestionParams('{}'), null);
  const many = normalizeQuestionParams({ questions: Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, prompt: 'x'.repeat(5000), options: [] })) });
  assert.equal(many.questions.length, 8);
  assert.ok(many.questions[0].prompt.length <= 1500);
});
