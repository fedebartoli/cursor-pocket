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

test('all\'avvio non partono notifiche per lo stato esistente (residui, chat in corso)', () => {
  const s = setup();
  s.fx.chat('residuo-0001', { lastUpdatedAt: T0 - 1000, header: flagged() });
  s.fx.conversation('residuo-0001', [
    // domanda gia' risposta, ma Cursor non ha ricalcolato il flag: residuo
    { id: 'b1', type: 2, createdAt: T0 - 2000, tool: { name: 'ask_question', status: 'completed', toolCallId: 'old', additionalData: { status: 'submitted' } } },
  ]);
  s.fx.chat('inizio-0002', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.tick();
  s.tick();
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf('residuo-0001').attention.kind, 'residuo');
  assert.equal(s.chatOf('inizio-0002').running, true);
  s.cleanup();
});

test('domanda viva all\'avvio: recente -> notifica; vecchia -> nessuna notifica ma marcata come gia\' notificata', () => {
  const s = setup();
  // stato reale di una domanda in attesa: bubble completed con additionalData pending (non piu' loading)
  const pending = { status: 'completed', additionalData: { status: 'pending' } };
  s.fx.chat('recente-0001', { lastUpdatedAt: T0 - 5000, header: flagged() });
  askingConversation(s.fx, 'recente-0001', { toolCallId: 'tc-new', at: T0 - 10_000, ...pending });
  s.fx.chat('vecchia-0002', { workspaceId: 'ws-2', path: '/Users/demo/altro', lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  askingConversation(s.fx, 'vecchia-0002', { toolCallId: 'tc-old', at: T0 - 7_200_000, ...pending });
  s.watcher.tick();
  assert.deepEqual(s.events.map((e) => [e.type, e.chat.id, e.dedupeKey]), [['attention', 'recente-0001', 'a:recente-0001:tc-new']]);
  assert.equal(s.store.hasNotified('a:vecchia-0002:tc-old'), true, 'segnata in silenzio: non partira\' mai in ritardo');
  assert.equal(s.chatOf('vecchia-0002').attention.kind, 'domanda', 'ma resta visibile nell\'app');
  s.cleanup();
});

test('nuova domanda dopo l\'avvio: un solo evento; una domanda successiva ne genera un altro', () => {
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
  assert.equal(ev.attention.kind, 'domanda');
  assert.equal(ev.attention.prompt, QUESTION_PARAMS.questions[0].prompt);
  assert.equal(ev.attention.title, QUESTION_PARAMS.title);
  assert.equal(s.chatOf('chat-00000001').attention.question.questions[0].options.length, 2);

  // il turno finisce: stessa domanda, ora completed/pending (ciclo di vita reale) -> resta una domanda, nessun nuovo evento
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-1', at: T0 + 400, status: 'completed', additionalData: { status: 'pending' } });
  s.tick();
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'domanda');
  assert.equal(s.chatOf('chat-00000001').attention.live, true);
  assert.equal(s.events.length, 1);

  // risposta data: flag giu', tool completato -> nessuna attenzione e nessun nuovo evento
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 5000, header: { hasBlockingPendingActions: false } });
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-1', status: 'completed', additionalData: { status: 'submitted' } });
  s.tick();
  assert.equal(s.chatOf('chat-00000001').attention, null);
  assert.equal(s.events.length, 1);

  // NUOVA domanda (nuovo toolCallId): nuovo evento
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 9000, header: flagged() });
  askingConversation(s.fx, 'chat-00000001', { toolCallId: 'tc-2', at: T0 + 8900 });
  s.tick();
  assert.equal(s.events.length, 2);
  assert.equal(s.events[1].dedupeKey, 'a:chat-00000001:tc-2');
  s.cleanup();
});

test('un residuo (flag senza richiesta viva) non genera mai notifiche, ma compare in Need attention', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 1000 });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 100, header: flagged() });
  s.fx.conversation('chat-00000001', [{ id: 'b1', type: 2, createdAt: T0 + 50, text: 'ok' }]);
  s.tick();
  s.tick();
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'residuo');
  s.cleanup();
});

test('chat finita: dopo una run abbastanza lunga e senza richieste in attesa, un solo evento', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 1000 });
  s.watcher.tick();
  // la run parte
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 100, header: { unfinishedRunAt: T0 + 100 } });
  s.tick();
  assert.equal(s.chatOf('chat-00000001').running, true);
  s.tick(30_000); // 30 s dopo
  // la run finisce: marcatore rimosso
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 31_000, header: { unfinishedRunAt: undefined, hasUnreadMessages: true } });
  s.fx.conversation('chat-00000001', [{ id: 'b1', type: 2, createdAt: T0 + 30_900, text: 'fatto' }]);
  s.tick();
  s.tick();
  s.tick();
  assert.deepEqual(s.events.map((e) => [e.type, e.dedupeKey]), [['done', 'd:chat-00000001:' + (T0 + 31_000)]]);
  assert.equal(s.chatOf('chat-00000001').unread, true);
  s.cleanup();
});

test('chat finita: run troppo breve (sotto la soglia) = nessun evento', () => {
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

test('chat in corso all\'avvio del daemon: quando finisce si notifica', () => {
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

test('una run che termina con una domanda viva notifica la domanda, non "finita"', () => {
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

test('ciclo di vita reale di una domanda: loading, poi completed/pending a run finita, poi risposta e nuova run', () => {
  // Sequenza osservata dal vivo (FINDINGS 9.1): il flag scatta con la domanda; 5-33 s dopo il turno finisce
  // (bubble completed/pending, composer `completed`) mentre l'header mostra ancora la run; la risposta arriva ore dopo.
  const s = setup({ doneSettleMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 600_000 } });
  s.fx.conversation(id, [{ id: 'b1', type: 1, createdAt: T0 - 600_000, text: 'Lavora' }], { status: 'aborted' });
  s.watcher.tick();
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf(id).running, true);

  // 1) l'agente pone la domanda: flag acceso, bubble in loading, run ancora in corso
  s.fx.chat(id, { header: { hasBlockingPendingActions: true } });
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 500, status: 'loading', composerStatus: 'aborted' });
  s.tick();
  assert.deepEqual(s.events.map((e) => e.type), ['attention']);

  // 2) il turno finisce: la domanda resta in attesa; l'header e' in ritardo e mostra ancora la run
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 500, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.tick(33_000);
  assert.equal(s.chatOf(id).running, false, 'il composer dice che la run e\' finita anche se l\'header e\' in ritardo');
  s.tick(6000);
  s.tick(30_000);
  assert.deepEqual(s.events.map((e) => e.type), ['attention'], 'ne\' "finita" ne\' una seconda notifica per la stessa domanda');
  assert.equal(s.chatOf(id).attention.kind, 'domanda');
  assert.equal(s.chatOf(id).attention.live, true);

  // l'header si allinea (marcatore tolto): nessuna novita'
  s.fx.chat(id, { header: { unfinishedRunAt: undefined } });
  s.tick();
  assert.deepEqual(s.events.map((e) => e.type), ['attention']);

  // 3) ore dopo l'utente risponde: flag spento, bubble submitted, nuova run
  s.tick(3_600_000);
  const t3 = s.clock.t;
  s.fx.chat(id, { lastUpdatedAt: t3, header: { hasBlockingPendingActions: false, unfinishedRunAt: t3 } });
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 500, status: 'completed', additionalData: { status: 'submitted' }, composerStatus: 'aborted' });
  s.tick();
  assert.equal(s.chatOf(id).attention, null);
  assert.equal(s.chatOf(id).running, true);

  // 4) la nuova run dura 2 minuti e finisce normalmente: composer `completed`, header ancora in ritardo
  s.tick(120_000);
  s.fx.conversation(id, [{ id: 'b9', type: 2, createdAt: s.clock.t, text: 'Fatto' }], { status: 'completed' });
  s.tick();
  s.tick(6000);
  assert.deepEqual(s.events.map((e) => e.type), ['attention', 'done'], 'una sola "finita", senza aspettare l\'header');
  s.cleanup();
});

test('fine run anticipata dal composer: "finita" parte anche se l\'header mostra ancora la run', () => {
  const s = setup({ doneSettleMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.fx.conversation(id, [{ id: 'b1', type: 1, createdAt: T0 - 500, text: 'x' }], { status: 'aborted' });
  s.watcher.tick();
  assert.equal(s.chatOf(id).running, true);
  s.tick(10_000);
  assert.equal(s.chatOf(id).running, true, '`aborted` e\' lo stato durante la run: vale l\'header');
  s.fx.conversation(id, [{ id: 'b1', type: 1, createdAt: T0 - 500, text: 'x' }, { id: 'b2', type: 2, createdAt: T0 + 30_000, text: 'ok' }], { status: 'completed' });
  s.tick(20_000);
  assert.equal(s.chatOf(id).running, false);
  assert.deepEqual(s.events, [], 'ancora nella finestra di assestamento');
  s.tick(6000);
  assert.deepEqual(s.events.map((e) => e.type), ['done']);
  s.tick(60_000);
  assert.deepEqual(s.events.map((e) => e.type), ['done'], 'l\'header in ritardo non produce altri eventi');
  s.cleanup();
});

test('una run che finisce con una domanda aperta ma flag non ancora aggiornato non e\' "finita"', () => {
  const s = setup({ doneSettleMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat(id, { lastUpdatedAt: T0 + 40_000, header: { unfinishedRunAt: undefined } }); // niente flag (in ritardo)
  askingConversation(s.fx, id, { toolCallId: 'tc-q', at: T0 + 39_900, status: 'completed', additionalData: { status: 'pending' } });
  s.tick(40_000);
  s.tick(6000);
  assert.equal(s.events.filter((e) => e.type === 'done').length, 0);
  s.cleanup();
});

test('chat con il flag gia\' acceso: una domanda nuova senza cambi nell\'header si vede alla rilettura periodica', () => {
  const s = setup({ fullScanMs: 5000 });
  const id = 'chat-00000001';
  // vecchia domanda senza risposta con flag acceso (come tante nei dati reali): all'avvio, in silenzio
  s.fx.chat(id, { lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  askingConversation(s.fx, id, { toolCallId: 'tc-old', at: T0 - 7_200_000, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.watcher.tick();
  assert.deepEqual(s.events, []);

  // l'agente ne pone una NUOVA: il flag e' gia' acceso, quindi l'header non cambia
  askingConversation(s.fx, id, { toolCallId: 'tc-new', at: T0 + 500, status: 'loading', composerStatus: 'aborted' });
  s.tick(1000);
  assert.deepEqual(s.events, [], 'rilettura non ancora dovuta');
  s.tick(5000);
  assert.deepEqual(s.events.map((e) => e.dedupeKey), [`a:${id}:tc-new`]);
  s.cleanup();
});

test('boost dopo un\'azione dal telefono: la domanda nuova si vede dopo 250 ms invece che dopo la rilettura periodica', () => {
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

test('header in ritardo (FINDINGS 9.7): la domanda appena posta notifica subito, senza aspettare il flag; il flag dopo non ne genera un\'altra', () => {
  // Dati reali: il flag compariva nell'header +4,8 s o +41 s dopo la domanda (scrittura periodica ogni 60 s).
  const s = setup({ fullScanMs: 5000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000 }); // header fermo: nessun flag, nessuna run
  s.watcher.tick();
  assert.deepEqual(s.events, []);

  // Cursor crea il bubble della domanda; l'header NON cambia
  askingConversation(s.fx, id, { toolCallId: 'tc-fresh', at: T0 + 500, status: 'loading', composerStatus: 'aborted' });
  s.tick(5000);
  assert.deepEqual(s.events.map((e) => [e.type, e.dedupeKey]), [['attention', `a:${id}:tc-fresh`]]);
  assert.equal(s.chatOf(id).attention.live, true);

  // il bubble passa a completed/pending, poi (dopo decine di secondi) arriva il flag: nessun secondo evento
  askingConversation(s.fx, id, { toolCallId: 'tc-fresh', at: T0 + 500, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.tick(5000);
  s.fx.chat(id, { lastUpdatedAt: T0 + 40_000, header: flagged() });
  s.tick(5000);
  assert.equal(s.events.length, 1, 'stessa domanda (stesso toolCallId): un solo evento');
  assert.equal(s.chatOf(id).attention.live, true);

  // risposta data: il bubble diventa submitted mentre il flag resta acceso fino alla scrittura successiva dell'header
  askingConversation(s.fx, id, { toolCallId: 'tc-fresh', at: T0 + 500, status: 'completed', additionalData: { status: 'submitted' }, composerStatus: 'completed' });
  s.tick(5000);
  assert.equal(s.chatOf(id).attention.kind, 'residuo');
  assert.equal(s.events.length, 1);
  s.cleanup();
});

test('header in ritardo: una domanda senza risposta ma VECCHIA, a flag spento, non e\' viva e non notifica', () => {
  // Es. un tool rimasto `loading` per una run interrotta: senza il flag non si puo' sapere che aspetta qualcuno.
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

test('flag acceso da una vecchia domanda e chat che ora lavora: i comandi in esecuzione non sono richieste (regressione)', () => {
  // Caso reale (FINDINGS 9.1): 68 eventi falsi in 28 minuti. Ogni comando parte `loading` e senza `userDecision`,
  // esattamente come apparirebbe un'approvazione, e il flag restava acceso per la domanda di ore prima.
  const s = setup();
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  askingConversation(s.fx, id, { toolCallId: 'tc-old', at: T0 - 7_200_000, status: 'completed', additionalData: { status: 'pending' }, composerStatus: 'completed' });
  s.watcher.tick(); // avvio: la vecchia domanda e' segnata in silenzio
  assert.deepEqual(s.events, []);

  // l'utente risponde con un messaggio libero: parte una run, il flag resta acceso (come fa Cursor)
  s.fx.chat(id, { lastUpdatedAt: T0 + 100, header: flagged({ unfinishedRunAt: T0 + 100 }) });
  const bubbles = [{ id: 'b0', type: 1, createdAt: T0 + 100, text: 'Vai avanti' }];
  for (let i = 1; i <= 12; i++) {
    const tool = (status, ad) => ({ name: 'run_terminal_command_v2', status, toolCallId: `tc-cmd-${i}`, additionalData: { status: ad } });
    bubbles.push({ id: `c${i}`, type: 2, createdAt: T0 + i * 5000, tool: tool('loading', 'cancelled') });
    s.fx.conversation(id, bubbles, { status: 'aborted' });
    s.tick(5000);
    assert.deepEqual(s.events, [], `comando ${i} in esecuzione: nessuna notifica`);
    const a = s.chatOf(id).attention;
    assert.deepEqual({ kind: a.kind, live: a.live }, { kind: 'residuo', live: false }, `comando ${i}: resta un residuo`);
    bubbles[bubbles.length - 1] = { ...bubbles[bubbles.length - 1], tool: tool('completed', 'success') };
  }

  // la run finisce: una sola "finita", nessuna "attention"
  bubbles.push({ id: 'z', type: 2, createdAt: T0 + 69_000, text: 'Fatto' });
  s.fx.conversation(id, bubbles, { status: 'completed' });
  s.fx.chat(id, { lastUpdatedAt: T0 + 70_000, header: flagged({ unfinishedRunAt: undefined, hasUnreadMessages: true }) });
  s.tick(5000);
  assert.deepEqual(s.events.map((e) => e.type), ['done']);
  s.cleanup();
});

test('approvazione in attesa (FINDINGS 11): notifica solo dopo approvalDelayMs, una volta sola, senza il comando', () => {
  const s = setup({ approvalDelayMs: 8000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } }); // la run e' in corso
  s.watcher.tick();
  assert.deepEqual(s.events, []);

  // un comando chiede l'approvazione: l'agente si ferma ad aspettare, la run risulta ancora in corso
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap', at: T0 + 500, composerStatus: 'aborted' });
  s.tick(1000);
  const a = s.chatOf(id).attention;
  assert.deepEqual({ kind: a.kind, live: a.live, key: a.key, toolName: a.toolName }, { kind: 'approvazione', live: true, key: 'tc-ap', toolName: 'run_terminal_command_v2' });
  assert.deepEqual(s.events, [], 'appena comparsa: si aspetta, magari la approvi subito dal Mac');
  s.tick(5000);
  s.tick(2000);
  assert.deepEqual(s.events, [], 'ancora sotto il ritardo');
  s.tick(1000); // 8 s di attesa continua
  assert.equal(s.events.length, 1);
  const e = s.events[0];
  assert.deepEqual([e.type, e.dedupeKey, e.attention.kind, e.attention.toolName], ['attention', `a:${id}:tc-ap`, 'approvazione', 'run_terminal_command_v2']);
  assert.doesNotMatch(JSON.stringify(e), /echo prova/, 'il comando non esce mai dal daemon');

  s.tick(60_000);
  s.tick(60_000);
  assert.equal(s.events.length, 1, 'niente promemoria: stessa richiesta, un solo evento');

  // una NUOVA richiesta (altro toolCallId) e' un altro evento, dopo il suo ritardo
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap2', at: s.clock.t, composerStatus: 'aborted' });
  s.tick(1000);
  assert.equal(s.events.length, 1);
  s.tick(8000);
  assert.deepEqual(s.events.map((x) => x.dedupeKey), [`a:${id}:tc-ap`, `a:${id}:tc-ap2`]);
  s.cleanup();
});

test('approvazione: il log registra comparsa e fine (solo numeri e booleani, mai contenuti)', () => {
  const lines = [];
  const logger = createLogger({ level: 'debug', stream: { write: (l) => lines.push(JSON.parse(l)) } });
  const s = setup({ approvalDelayMs: 8000 }, new CursorFixture(), logger);
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } });
  s.watcher.tick();
  approvingConversation(s.fx, id, { toolCallId: 'tc-segreto', at: T0 + 500, composerStatus: 'aborted' });
  s.tick(1000);
  s.tick(9000); // notificata
  approvingConversation(s.fx, id, { toolCallId: 'tc-segreto', at: T0 + 500, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
  s.tick(1000);
  const seen = lines.filter((l) => l.event === 'approval_seen');
  const gone = lines.filter((l) => l.event === 'approval_gone');
  assert.equal(seen.length, 1);
  assert.deepEqual({ running: seen[0].running, flag: seen[0].flag, initial: seen[0].initial }, { running: true, flag: false, initial: false });
  assert.equal(gone.length, 1);
  assert.deepEqual({ notified: gone[0].notified, waitedSec: gone[0].waitedSec }, { notified: true, waitedSec: 10 });
  const all = JSON.stringify(lines);
  assert.equal(all.includes('tc-segreto'), false, 'nessun identificativo di tool nel log');
  assert.equal(all.includes('echo prova'), false, 'nessun comando nel log');
  s.cleanup();
});

test('approvazione decisa dal Mac prima del ritardo: nessuna notifica', () => {
  const s = setup({ approvalDelayMs: 8000 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } });
  s.watcher.tick();
  approvingConversation(s.fx, id, { at: T0 + 500, composerStatus: 'aborted' });
  s.tick(1000);
  s.tick(3000);
  assert.deepEqual(s.events, []);

  // tu approvi al Mac: reviewData passa a Done e il comando parte
  approvingConversation(s.fx, id, { at: T0 + 500, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
  s.tick(1000);
  assert.equal(s.chatOf(id).attention, null);
  s.tick(20_000);
  assert.deepEqual(s.events, [], 'mai notificata');
  assert.equal(s.store.hasNotified(`a:${id}:tc-ap`), false);

  // il ritardo riparte da capo per la richiesta successiva: una sola attesa, non somme di attese vecchie
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap3', at: s.clock.t, composerStatus: 'aborted' });
  s.tick(1000);
  s.tick(7000);
  assert.deepEqual(s.events, []);
  s.tick(1000);
  assert.deepEqual(s.events.map((x) => x.dedupeKey), [`a:${id}:tc-ap3`]);
  s.cleanup();
});

test('approvazione gia\' presente all\'avvio: recente = notifica subito; vecchia = solo nell\'app', () => {
  const s = setup({ approvalDelayMs: 8000 });
  s.fx.chat('recente-0001', { lastUpdatedAt: T0 - 5000, header: { unfinishedRunAt: T0 - 20_000 } });
  approvingConversation(s.fx, 'recente-0001', { toolCallId: 'tc-new', at: T0 - 10_000, composerStatus: 'aborted' });
  s.fx.chat('vecchia-0002', { workspaceId: 'ws-2', path: '/Users/demo/altro', lastUpdatedAt: T0 - 7_200_000, header: flagged() });
  approvingConversation(s.fx, 'vecchia-0002', { toolCallId: 'tc-old', at: T0 - 7_200_000, composerStatus: 'completed' });
  s.watcher.tick();
  assert.deepEqual(s.events.map((e) => [e.type, e.chat.id, e.dedupeKey]), [['attention', 'recente-0001', 'a:recente-0001:tc-new']], 'senza aspettare il ritardo da capo');
  assert.equal(s.store.hasNotified('a:vecchia-0002:tc-old'), true, 'segnata in silenzio');
  assert.equal(s.chatOf('vecchia-0002').attention.kind, 'approvazione', 'ma resta visibile nell\'app');
  s.tick(30_000);
  s.tick(30_000);
  assert.equal(s.events.length, 1);
  s.cleanup();
});

test('approvazione: un residuo (Cursor chiuso a meta\', chat ferma, nessun flag) non e\' una richiesta e non notifica', () => {
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

test('approvazione: Cursor guarda gli ultimi DUE bubble, un messaggio arrivato dopo non la nasconde', () => {
  const s = setup({ approvalDelayMs: 0 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 600_000, header: { unfinishedRunAt: T0 - 60_000 } });
  s.watcher.tick();
  approvingConversation(s.fx, id, { toolCallId: 'tc-ap', at: T0 + 500, composerStatus: 'aborted', trailing: [{ id: 'b3', type: 2, createdAt: T0 + 900, text: 'Aspetto il via libera' }] });
  s.tick(1000);
  assert.deepEqual(s.events.map((e) => e.dedupeKey), [`a:${id}:tc-ap`]);
  assert.equal(s.chatOf(id).attention.bubbleId, 'b2');
  // due bubble dopo: non e' piu' tra gli ultimi due (e' un residuo)
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

test('una run che si ferma su un\'approvazione non e\' "finita": prima l\'approvazione, mai "finita" mentre aspetta', () => {
  const s = setup({ approvalDelayMs: 0 });
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick(); // run in corso all'avvio: "lunga abbastanza"
  approvingConversation(s.fx, id, { at: T0 + 2000, composerStatus: 'completed' });
  s.fx.chat(id, { lastUpdatedAt: T0 + 40_000, header: flagged({ unfinishedRunAt: undefined }) });
  s.tick(40_000);
  s.tick(10_000);
  assert.deepEqual(s.events.map((e) => e.type), ['attention']);
  s.cleanup();
});

test('una run che termina con messaggi in coda non e\' "finita"', () => {
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

test('assestamento: "finita" solo dopo doneSettleMs senza che la run riprenda', () => {
  const s = setup({ doneSettleMs: 5000 });
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 2000, header: { unfinishedRunAt: undefined } });
  s.tick(); // fine run osservata
  s.tick(); // +1 s
  s.tick(2000); // +3 s
  assert.deepEqual(s.events, [], 'ancora nella finestra di assestamento');
  s.tick(3000); // +6 s
  assert.deepEqual(s.events.map((e) => e.type), ['done']);
  s.cleanup();
});

test('assestamento: se la run riprende entro la finestra (passo successivo dell\'agente) non c\'e\' "finita"', () => {
  const s = setup({ doneSettleMs: 5000 });
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 500 } });
  s.watcher.tick();
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 2000, header: { unfinishedRunAt: undefined } });
  s.tick();
  s.tick(2000);
  s.fx.chat('chat-00000001', { lastUpdatedAt: T0 + 4000, header: { unfinishedRunAt: T0 + 4000 } }); // riparte
  s.tick();
  s.tick(10_000);
  assert.deepEqual(s.events, []);
  assert.equal(s.chatOf('chat-00000001').running, true);
  s.cleanup();
});

test('esclusioni: archiviate, sottoagenti, bozze, vuote e remote non compaiono; le classiche seguono l\'opzione', () => {
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
  assert.equal(s.chatOf('classica-0001').workspaceName, 'classico', 'risolta da workspaceStorage');
  s.cleanup();

  const t = setup({ includeClassicChats: false });
  t.fx.chat('classica-0001', { location: null });
  t.fx.chat('normale-00001');
  t.watcher.tick();
  assert.deepEqual(t.watcher.last.chats.map((c) => c.id), ['normale-00001']);
  t.cleanup();
});

test('progetti rimossi dalla sidebar: le loro chat non compaiono ne\' notificano; se il progetto torna, riappaiono', () => {
  const s = setup();
  s.fx.chat('normale-00001');
  // non archiviata, ma il progetto e' stato rimosso dalla sidebar di Cursor (colonna workspaceId)
  s.fx.chat('rimossa-00001', { workspaceId: 'ws-rimosso', path: '/Users/demo/vecchio' });
  // stesso progetto riconosciuto solo da header.workspaceIdentifier.id
  s.fx.chat('rimossa-00002', { workspaceId: 'altra-colonna', path: '/Users/demo/vecchio', header: { workspaceIdentifier: { id: 'ws-rimosso' } } });
  // una domanda viva in un progetto rimosso non deve mai arrivare come notifica
  s.fx.chat('domanda-00003', { workspaceId: 'ws-rimosso', path: '/Users/demo/vecchio', lastUpdatedAt: T0 - 1000, header: flagged() });
  askingConversation(s.fx, 'domanda-00003', { toolCallId: 'tc-rem', at: T0 - 2000, status: 'completed', additionalData: { status: 'pending' } });
  s.fx.setRemovedProjects(['ws-rimosso', 'ws-mai-usato']);

  s.watcher.tick();
  s.tick();
  assert.deepEqual(s.watcher.last.chats.map((c) => c.id), ['normale-00001']);
  assert.deepEqual(s.events, [], 'nessuna notifica per chat che la sidebar non mostra');

  // l'utente ri-aggiunge il progetto: dopo la rilettura delle impostazioni (10 s) le chat riappaiono
  s.fx.setRemovedProjects([]);
  s.tick(11_000);
  assert.deepEqual(s.watcher.last.chats.map((c) => c.id).sort(), ['domanda-00003', 'normale-00001', 'rimossa-00001', 'rimossa-00002']);
  s.cleanup();
});

test('progetti rimossi: elenco assente, illeggibile o con voci incomplete = nessuna chat nascosta', () => {
  for (const raw of [undefined, 'non e\' json', '{"a":1}', '[null, 7, {"id":"x"}, {"workspaceIdentifier":{}}, {"workspaceIdentifier":{"id":42}}]']) {
    const s = setup();
    s.fx.chat('chat-00000001', { workspaceId: 'ws-1' });
    if (raw !== undefined) s.fx.setRemovedProjects(raw);
    s.watcher.tick();
    assert.equal(s.watcher.status.ok, true);
    assert.deepEqual(s.watcher.last.chats.map((c) => c.id), ['chat-00000001'], `valore: ${String(raw).slice(0, 20)}`);
    s.cleanup();
  }
});

test('database illeggibile: nessuna eccezione, stato non ok; al ritorno si riprende da solo', () => {
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

test('SOLA LETTURA: il file del database di Cursor non cambia dopo scansioni complete', () => {
  const s = setup();
  s.fx.chat('chat-00000001', { header: flagged() });
  askingConversation(s.fx, 'chat-00000001');
  s.fx.setSidebar({ groupBy: 'workspace', sortGroupsBy: 'manual' });
  s.fx.close(); // chiude la connessione di scrittura: da qui nessuno scrive
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

test('dettaglio on-demand: ultimo messaggio dell\'assistente e testo della domanda (aperta o gia\' risposta)', () => {
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
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'domanda');
  const d = s.watcher.detail('chat-00000001');
  assert.equal(d.lastMessage.text, 'Ultima risposta');
  assert.equal(d.question.title, QUESTION_PARAMS.title);
  assert.equal(s.watcher.detail('inesistente'), null);

  // domanda gia' risposta ma flag ancora acceso (residuo): il testo resta consultabile
  conversation('submitted');
  s.tick();
  assert.equal(s.chatOf('chat-00000001').attention.kind, 'residuo');
  assert.equal(s.watcher.detail('chat-00000001').question.title, QUESTION_PARAMS.title);
  s.cleanup();
});

test('dettaglio on-demand: "attivita\' recente" in ordine dal piu\' recente, solo il tipo di azione dei tool (mai comandi o percorsi)', () => {
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
    a.map((x) => [x.kind, x.label, x.state]),
    [
      ['tool', 'Esegue un\u2019azione', 'running'],
      ['tool', 'Esegue un comando', 'done'],
      ['assistant', 'Risposta dell\u2019agente', ''],
      ['tool', 'Legge un file', 'done'],
      ['user', 'Messaggio inviato', ''],
    ],
  );
  assert.equal(a[4].preview, 'Fai il refactoring');
  const json = JSON.stringify(a);
  assert.equal(json.includes('segreto'), false);
  s.cleanup();
});

test('domanda appena creata: params ancora vuoto ma il testo si legge dal toolCallBinary (e poi dai params, uguale)', () => {
  const s = setup();
  const id = 'chat-00000001';
  s.fx.chat(id, { lastUpdatedAt: T0, header: flagged() });
  const q = { title: 'Titolo', questions: [{ id: 'q1', prompt: 'Quale?', options: [{ id: 'a', label: 'Uno' }, { id: 'b', label: 'Due' }] }] };
  const tool = (extra) => ({ name: 'ask_question', status: 'loading', toolCallId: 'tc-bin', ...extra });
  const bubbles = (t) => [{ id: 'b1', type: 2, createdAt: T0 - 500, tool: t }];
  s.fx.conversation(id, bubbles(tool({ binary: encodeQuestion(q) })));
  s.tick();
  assert.equal(s.chatOf(id).attention.kind, 'domanda');
  assert.equal(s.watcher.detail(id).question.questions[0].prompt, 'Quale?');
  assert.deepEqual(s.watcher.detail(id).question.questions[0].options.map((o) => o.id), ['a', 'b']);
  // poi Cursor scrive i params: stessa domanda
  s.fx.conversation(id, bubbles(tool({ status: 'completed', params: q, binary: encodeQuestion(q), additionalData: { status: 'pending' } })));
  s.tick();
  assert.equal(s.watcher.detail(id).question.questions[0].prompt, 'Quale?');
  // binario vuoto e params vuoti (argomenti non ancora scritti): attenzione viva ma senza testo
  s.fx.conversation(id, bubbles(tool({})));
  s.tick(2000);
  assert.equal(s.chatOf(id).attention.kind, 'domanda');
  assert.equal(s.watcher.detail(id).question, null);
  s.cleanup();
});
