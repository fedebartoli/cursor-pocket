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

test('stato: attenzione > in corso > finita (non letta) > inattiva', () => {
  assert.equal(stateOf(chat('a', { attention: att(), running: true }), ctx()).state, STATES.ATTENTION);
  assert.equal(stateOf(chat('a', { running: true, unread: true }), ctx()).state, STATES.RUNNING);
  assert.equal(stateOf(chat('a', { unread: true }), ctx()).state, STATES.DONE);
  assert.equal(stateOf(chat('a'), ctx()).state, STATES.IDLE);
});

test('una chat che sta lavorando con un flag residuo e\' "in corso", non "richiede attenzione"; a run finita il residuo torna', () => {
  const residuo = att({ kind: 'residuo', live: false, toolName: 'run_terminal_command_v2' });
  assert.deepEqual(stateOf(chat('a', { attention: residuo, running: true }), ctx()), { state: STATES.RUNNING, reason: null });
  assert.equal(stateOf(chat('a', { attention: att({ kind: 'piano', live: false }), running: true }), ctx()).state, STATES.RUNNING);
  // anche se il residuo era stato ignorato: durante la run si vede il lavoro in corso
  const ignored = new Set([ignoreKey('a', 'tc-1')]);
  assert.equal(stateOf(chat('a', { attention: residuo, running: true }), ctx({ ignored })).state, STATES.RUNNING);
  // run finita: il residuo e' di nuovo una richiesta (ignorabile) e una domanda viva resta attenzione anche in corso
  assert.equal(stateOf(chat('a', { attention: residuo, running: false }), ctx()).state, STATES.ATTENTION);
  assert.equal(stateOf(chat('a', { attention: residuo, running: false }), ctx({ ignored })).state, STATES.PENDING);
  assert.equal(stateOf(chat('a', { attention: att(), running: true }), ctx()).state, STATES.ATTENTION);

  // nel riepilogo: niente conteggio ne' feed "Richiedono attenzione" per la chat che lavora
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

test('Ignora: la chat passa a "in sospeso"; una NUOVA domanda (chiave diversa) fa ricomparire l\'attenzione', () => {
  const ignored = new Set([ignoreKey('a', 'tc-1')]);
  assert.deepEqual(stateOf(chat('a', { attention: att() }), ctx({ ignored })), { state: STATES.PENDING, reason: 'ignorata' });
  assert.deepEqual(stateOf(chat('a', { attention: att({ key: 'tc-2' }) }), ctx({ ignored })), { state: STATES.ATTENTION, reason: null });
  // l'ignorata di un'altra chat con la stessa chiave non conta
  assert.equal(stateOf(chat('b', { attention: att() }), ctx({ ignored })).state, STATES.ATTENTION);
});

test('Soglia "in sospeso": richieste piu\' vecchie della soglia; 0 = mai', () => {
  const old = chat('a', { attention: att({ since: NOW - DAY - 1 }) });
  assert.deepEqual(stateOf(old, ctx()), { state: STATES.PENDING, reason: 'vecchia' });
  assert.equal(stateOf(old, ctx({ pendingAfterMs: 0 })).state, STATES.ATTENTION);
  assert.equal(stateOf(chat('a', { attention: att({ since: NOW - DAY + 1000 }) }), ctx()).state, STATES.ATTENTION);
});

test('etichette di attenzione', () => {
  assert.equal(attentionLabel({ kind: 'domanda' }), 'Domanda in attesa');
  assert.equal(attentionLabel({ kind: 'approvazione' }), 'Approvazione richiesta');
  assert.equal(attentionLabel({ kind: 'piano' }), 'Piano in attesa');
  assert.equal(attentionLabel({ kind: 'residuo' }), 'Richiesta non risolta');
  assert.equal(attentionLabel({ kind: 'sconosciuto' }), 'Richiesta non risolta');
});

test('approvazione: solo il TIPO di azione e\' pubblico, mai il comando; conta come attenzione anche mentre la chat lavora', () => {
  assert.equal(toolActionLabel('run_terminal_command_v2'), 'Comando da eseguire');
  assert.equal(toolActionLabel('edit_file_v2'), 'Modifica di un file');
  assert.equal(toolActionLabel('mcp-cursor-ide-browser-browser_click'), 'Azione da approvare', 'un tool MCP con nome composto: etichetta generica');
  assert.equal(toolActionLabel('call_mcp_tool'), 'Strumento MCP');
  assert.equal(toolActionLabel('web_fetch'), 'Richiesta web');
  assert.equal(toolActionLabel(undefined), 'Azione da approvare');

  const a = att({ kind: 'approvazione', key: 'tc-ap', toolName: 'run_terminal_command_v2', question: undefined, since: NOW - 60_000 });
  const out = presentState({ chats: [chat('a1', { running: true, attention: a })], settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY });
  assert.equal(out.counts.attention, 1);
  assert.equal(out.attention[0].state, STATES.ATTENTION, 'in attesa di te, non "in corso"');
  const card = out.attention[0].attention;
  assert.deepEqual({ kind: card.kind, label: card.label, detail: card.detail, live: card.live }, { kind: 'approvazione', label: 'Approvazione richiesta', detail: 'Comando da eseguire', live: true });
  assert.equal(card.prompt, '');
  assert.equal(JSON.stringify(out).includes('toolName'), false, 'il nome del tool non e\' esposto alla PWA');

  // Ignora vale anche per le approvazioni (chiave = toolCallId): una nuova richiesta fa ricomparire il pallino
  const ignored = new Set([ignoreKey('a1', 'tc-ap')]);
  assert.equal(stateOf(chat('a1', { attention: a }), ctx({ ignored })).state, STATES.PENDING);
  assert.equal(stateOf(chat('a1', { attention: { ...a, key: 'tc-ap2' } }), ctx({ ignored })).state, STATES.ATTENTION);
  // le altre richieste non hanno dettaglio
  const q = presentState({ chats: [chat('q1', { attention: att() })], settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY });
  assert.equal(q.attention[0].attention.detail, '');
});

test('presentState: gruppi nell\'ordine di Cursor, chat per ultimo aggiornamento, conteggi e feed', () => {
  const chats = [
    chat('a1', { sectionId: 's1', workspaceName: 'uno', lastUpdatedAt: NOW - 3 * H }),
    chat('a2', { sectionId: 's1', workspaceName: 'uno', lastUpdatedAt: NOW - H, attention: att({ since: NOW - 2 * H }) }),
    chat('b1', { sectionId: 's2', workspaceName: 'due', lastUpdatedAt: NOW - 10 * H, running: true }),
    chat('c1', { sectionId: 's3', workspaceName: 'tre', lastUpdatedAt: NOW - 5 * H, attention: att({ key: 'k', kind: 'residuo', live: false, since: NOW - 2 * DAY }) }),
  ];
  const settings = { sortGroupsBy: 'manual', sectionOrderByGroupBy: { workspace: ['s2', 's1', 's3'] }, collapsedSectionIdsByGroupBy: { workspace: ['s3'] } };
  const out = presentState({ chats, settings, ignored: new Set(), now: NOW, pendingAfterMs: DAY });

  assert.deepEqual(out.counts, { attention: 1, pending: 1, running: 1, total: 4 });
  assert.deepEqual(out.workspaces.map((w) => w.id), ['s2', 's1', 's3'], 'ordine manuale salvato');
  assert.deepEqual(out.workspaces.find((w) => w.id === 's1').chats.map((c) => c.id), ['a2', 'a1'], 'per ultimo aggiornamento');
  assert.equal(out.workspaces.find((w) => w.id === 's3').collapsed, true);
  assert.deepEqual(out.attention.map((c) => c.id), ['a2']);
  assert.deepEqual(out.pending.map((c) => [c.id, c.attention.reason]), [['c1', 'vecchia']]);
  assert.equal(out.attention[0].attention.prompt, 'Scegli');
  assert.equal(out.attention[0].attention.label, 'Domanda in attesa');
});

test('presentState: nomi di workspace duplicati vengono distinti con la cartella superiore', () => {
  const chats = [
    chat('a', { sectionId: 's1', workspaceName: 'app', workspaceParent: 'lavoro' }),
    chat('b', { sectionId: 's2', workspaceName: 'app', workspaceParent: 'personale' }),
    chat('c', { sectionId: 's3', workspaceName: 'altro', workspaceParent: 'x' }),
  ];
  const out = presentState({ chats, settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY });
  const names = out.workspaces.map((w) => w.name).sort();
  assert.deepEqual(names, ['altro', 'app (lavoro)', 'app (personale)']);
});

test('presentState e\' deterministico (stesso input, stesso JSON): serve a non inviare aggiornamenti inutili', () => {
  const chats = [chat('a', { attention: att() }), chat('b', { sectionId: 's2', workspaceName: 'x' })];
  const a = JSON.stringify(presentState({ chats, settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY }));
  const b = JSON.stringify(presentState({ chats, settings: null, ignored: new Set(), now: NOW, pendingAfterMs: DAY }));
  assert.equal(a, b);
});

test('attivita\': un tool "in corso" da piu\' di 15 minuti e\' un residuo e non risulta attivo', () => {
  const now = 10_000_000;
  const bubble = (at) => ({ id: 'x', type: 2, at, tool: { name: 'run_terminal_command_v2', status: 'loading' }, text: '' });
  assert.equal(activityOf([bubble(now - 60_000)], now)[0].state, 'running');
  assert.equal(activityOf([bubble(now - 16 * 60_000)], now)[0].state, '');
  assert.deepEqual(activityOf([{ id: 'v', type: 2, at: now, tool: null, text: '' }], now), []);
});
