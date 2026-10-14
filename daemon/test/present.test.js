import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, activityOf, attentionLabel, ignoreKey, presentState, stateOf, toolActionLabel } from '../src/state/present.js';

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const DAY = 24 * H;

function chat(id, over = {}) {
  return {
    id,
    name: `Chat ${id}`,
    subtitle: '',
    mode: 'agent',
    sectionId: 's1',
    workspaceName: 'app',
    workspaceParent: 'dev',
    workspaceHome: false,
    createdAt: NOW - DAY,
    lastUpdatedAt: NOW - H,
    unread: false,
    running: false,
    attention: null,
    ...over,
  };
}
const att = (over = {}) => ({ kind: 'domanda', key: 'tc-1', live: true, since: NOW - H, toolName: 'ask_question', question: { title: 'T', questions: [{ prompt: 'Scegli' }] }, ...over });
const ctx = (over = {}) => ({ ignored: new Set(), now: NOW, pendingAfterMs: DAY, ...over });

test('state: attention > running > done (unread) > idle', () => {
  assert.equal(stateOf(chat('a', { attention: att(), running: true }), ctx()).state, STATES.ATTENTION);
  assert.equal(stateOf(chat('a', { running: true, unread: true }), ctx()).state, STATES.RUNNING);
  assert.equal(stateOf(chat('a', { unread: true }), ctx()).state, STATES.DONE);
  assert.equal(stateOf(chat('a'), ctx()).state, STATES.IDLE);
});

test('chat that is working with stale flag is "running", not "needs attention"; when run ends stale returns', () => {
  const residuo = att({ kind: 'residuo', live: false, toolName: 'run_terminal_command_v2' });
  assert.deepEqual(stateOf(chat('a', { attention: residuo, running: true }), ctx()), { state: STATES.RUNNING, reason: null });
  assert.equal(stateOf(chat('a', { attention: att({ kind: 'piano', live: false }), running: true }), ctx()).state, STATES.RUNNING);
  // even if stale was ignored: during run show work in progress
  const ignored = new Set([ignoreKey('a', 'tc-1')]);
  assert.equal(stateOf(chat('a', { attention: residuo, running: true }), ctx({ ignored })).state, STATES.RUNNING);
  // run finished: stale is attention again (ignorable); live question stays attention even while running
  assert.equal(stateOf(chat('a', { attention: residuo, running: false }), ctx()).state, STATES.ATTENTION);
  assert.equal(stateOf(chat('a', { attention: residuo, running: false }), ctx({ ignored })).state, STATES.PENDING);
  assert.equal(stateOf(chat('a', { attention: att(), running: true }), ctx()).state, STATES.ATTENTION);

  // in summary: no count or "needs attention" feed for working chat
  const out = presentState({
    chats: [chat('w', { attention: residuo, running: true }), chat('q', { attention: att({ key: 'tc-q' }), lastUpdatedAt: NOW - 2 * H })],
    settings: null,
    ignored: new Set(),
    now: NOW,
    pendingAfterMs: DAY,
  });
  assert.deepEqual(out.counts, { attention: 1, pending: 0, running: 1, total: 2 });
  assert.deepEqual(out.attention.map((c) => c.id), ['q']);
});

test('Ignore: chat moves to pending; NEW question (different key) brings attention back', () => {
  const ignored = new Set([ignoreKey('a', 'tc-1')]);
  assert.deepEqual(stateOf(chat('a', { attention: att() }), ctx({ ignored })), { state: STATES.PENDING, reason: 'ignorata' });
  assert.deepEqual(stateOf(chat('a', { attention: att({ key: 'tc-2' }) }), ctx({ ignored })), { state: STATES.ATTENTION, reason: null });
  // ignore on another chat with same key does not apply
  assert.equal(stateOf(chat('b', { attention: att() }), ctx({ ignored })).state, STATES.ATTENTION);
});

test('pending threshold: requests older than threshold; 0 = never', () => {
  const old = chat('a', { attention: att({ since: NOW - DAY - 1 }) });
  assert.deepEqual(stateOf(old, ctx()), { state: STATES.PENDING, reason: 'vecchia' });
  assert.equal(stateOf(old, ctx({ pendingAfterMs: 0 })).state, STATES.ATTENTION);
  assert.equal(stateOf(chat('a', { attention: att({ since: NOW - DAY + 1000 }) }), ctx()).state, STATES.ATTENTION);
});

test('attention labels', () => {
  assert.equal(attentionLabel({ kind: 'domanda' }), 'Domanda in attesa');
  assert.equal(attentionLabel({ kind: 'approvazione' }), 'Approvazione richiesta');
  assert.equal(attentionLabel({ kind: 'piano' }), 'Piano in attesa');
  assert.equal(attentionLabel({ kind: 'residuo' }), 'Richiesta non risolta');
  assert.equal(attentionLabel({ kind: 'sconosciuto' }), 'Richiesta non risolta');
});

test('approval: only action TYPE is public, never the command; counts as attention even while chat is working', () => {
  assert.equal(toolActionLabel('run_terminal_command_v2'), 'Comando da eseguire');
  assert.equal(toolActionLabel('edit_file_v2'), 'Modifica di un file');
  assert.equal(toolActionLabel('mcp-cursor-ide-browser-browser_click'), 'Azione da approvare', 'compound MCP tool name: generic label');
  assert.equal(toolActionLabel('call_mcp_tool'), 'Strumento MCP');
  assert.equal(toolActionLabel('web_fetch'), 'Richiesta web');
  assert.equal(toolActionLabel(undefined), 'Azione da approvare');

  const a = att({ kind: 'approvazione', key: 'tc-ap', toolName: 'run_terminal_command_v2', question: undefined, since: NOW - 60_000 });
  const out = presentState({ chats: [chat('a1', { running: true, attention: a })], settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY });
  assert.equal(out.counts.attention, 1);
  assert.equal(out.attention[0].state, STATES.ATTENTION, 'waiting on you, not "running"');
  const card = out.attention[0].attention;
  assert.deepEqual({ kind: card.kind, label: card.label, detail: card.detail, live: card.live }, { kind: 'approvazione', label: 'Approvazione richiesta', detail: 'Comando da eseguire', live: true });
  assert.equal(card.prompt, '');
  assert.equal(JSON.stringify(out).includes('toolName'), false, 'tool name not exposed to PWA');

  // Ignore applies to approvals too (key = toolCallId): new request brings dot back
  const ignored = new Set([ignoreKey('a1', 'tc-ap')]);
  assert.equal(stateOf(chat('a1', { attention: a }), ctx({ ignored })).state, STATES.PENDING);
  assert.equal(stateOf(chat('a1', { attention: { ...a, key: 'tc-ap2' } }), ctx({ ignored })).state, STATES.ATTENTION);
  // other request kinds have no detail
  const q = presentState({ chats: [chat('q1', { attention: att() })], settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY });
  assert.equal(q.attention[0].attention.detail, '');
});

test('presentState: groups in Cursor order, chats by last update, counts and feeds', () => {
  const chats = [
    chat('a1', { sectionId: 's1', workspaceName: 'uno', lastUpdatedAt: NOW - 3 * H }),
    chat('a2', { sectionId: 's1', workspaceName: 'uno', lastUpdatedAt: NOW - H, attention: att({ since: NOW - 2 * H }) }),
    chat('b1', { sectionId: 's2', workspaceName: 'due', lastUpdatedAt: NOW - 10 * H, running: true }),
    chat('c1', { sectionId: 's3', workspaceName: 'tre', lastUpdatedAt: NOW - 5 * H, attention: att({ key: 'k', kind: 'residuo', live: false, since: NOW - 2 * DAY }) }),
  ];
  const settings = { sortGroupsBy: 'manual', sectionOrderByGroupBy: { workspace: ['s2', 's1', 's3'] }, collapsedSectionIdsByGroupBy: { workspace: ['s3'] } };
  const out = presentState({ chats, settings, ignored: new Set(), now: NOW, pendingAfterMs: DAY });

  assert.deepEqual(out.counts, { attention: 1, pending: 1, running: 1, total: 4 });
  assert.deepEqual(out.workspaces.map((w) => w.id), ['s2', 's1', 's3'], 'saved manual order');
  assert.deepEqual(out.workspaces.find((w) => w.id === 's1').chats.map((c) => c.id), ['a2', 'a1'], 'by last update');
  assert.equal(out.workspaces.find((w) => w.id === 's3').collapsed, true);
  assert.deepEqual(out.attention.map((c) => c.id), ['a2']);
  assert.deepEqual(out.pending.map((c) => [c.id, c.attention.reason]), [['c1', 'vecchia']]);
  assert.equal(out.attention[0].attention.prompt, 'Scegli');
  assert.equal(out.attention[0].attention.label, 'Domanda in attesa');
});

test('presentState: duplicate workspace names distinguished with parent folder', () => {
  const chats = [
    chat('a', { sectionId: 's1', workspaceName: 'app', workspaceParent: 'lavoro' }),
    chat('b', { sectionId: 's2', workspaceName: 'app', workspaceParent: 'personale' }),
    chat('c', { sectionId: 's3', workspaceName: 'altro', workspaceParent: 'x' }),
  ];
  const out = presentState({ chats, settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY });
  const names = out.workspaces.map((w) => w.name).sort();
  assert.deepEqual(names, ['altro', 'app (lavoro)', 'app (personale)']);
});

test('presentState is deterministic (same input, same JSON): avoids useless updates', () => {
  const chats = [chat('a', { attention: att() }), chat('b', { sectionId: 's2', workspaceName: 'x' })];
  const a = JSON.stringify(presentState({ chats, settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY }));
  const b = JSON.stringify(presentState({ chats, settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY }));
  assert.equal(a, b);
});

test('activity: tool "running" for more than 15 minutes is stale and not active', () => {
  const now = 10_000_000;
  const bubble = (at) => ({ id: 'x', type: 2, at, tool: { name: 'run_terminal_command_v2', status: 'loading' }, text: '' });
  assert.equal(activityOf([bubble(now - 60_000)], now)[0].state, 'running');
  assert.equal(activityOf([bubble(now - 16 * 60_000)], now)[0].state, '');
  assert.deepEqual(activityOf([{ id: 'v', type: 2, at: now, tool: null, text: '' }], now), []);
});
