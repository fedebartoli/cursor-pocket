import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Actions, ActionError, answersMatch, cleanText, LIMITS, validateAnswers } from '../src/actions.js';
import { FREEFORM_ID } from '../src/cursor/questions.js';
import { nullLogger } from '../src/log.js';
import { approvingConversation, askingConversation } from './helpers/fixture.js';
import { T0, startHarness } from './helpers/harness.js';

const ID = 'chat-0000-0001';
const ID2 = 'chat-0000-0002';
const fast = async () => {};

const SINGLE = { title: 'T', questions: [{ id: 'q1', prompt: 'Scegli', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false }] };
const MULTI = { title: 'T', questions: [{ id: 'q1', prompt: 'Scegli', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], allowMultiple: true }] };
const TWO = {
  title: 'T',
  questions: [
    { id: 'q1', prompt: 'Uno', options: [{ id: 'a', label: 'A' }], allowMultiple: false },
    { id: 'q2', prompt: 'Due', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], allowMultiple: true },
  ],
};

function bad(fn, re) {
  assert.throws(fn, (e) => e instanceof ActionError && e.status === 400 && e.code === 'bad_answer' && (!re || re.test(e.message)));
}

// ----------------------------------------------------------------------------------------------------------------
// funzioni pure
// ----------------------------------------------------------------------------------------------------------------

test('validateAnswers: scelta singola, multipla, testo libero e domande multiple', () => {
  assert.deepEqual(validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a'] }]), [{ questionId: 'q1', optionIds: ['a'], freeform: '' }]);
  assert.deepEqual(validateAnswers(MULTI, [{ questionId: 'q1', optionIds: ['a', 'c'] }]), [{ questionId: 'q1', optionIds: ['a', 'c'], freeform: '' }]);
  // solo testo libero: l'id riservato viene aggiunto, il testo e' ripulito
  assert.deepEqual(validateAnswers(SINGLE, [{ questionId: 'q1', freeform: '  altro\r\ntesto  ' }]), [{ questionId: 'q1', optionIds: [FREEFORM_ID], freeform: 'altro\ntesto' }]);
  // multipla: opzioni + testo libero (testo libero sempre per ultimo)
  assert.deepEqual(validateAnswers(MULTI, [{ questionId: 'q1', optionIds: [FREEFORM_ID, 'b'], freeform: 'x' }]), [{ questionId: 'q1', optionIds: ['b', FREEFORM_ID], freeform: 'x' }]);
  // due domande: l'ordine segue la domanda, non la richiesta
  const out = validateAnswers(TWO, [{ questionId: 'q2', optionIds: ['x', 'y'] }, { questionId: 'q1', optionIds: ['a'] }]);
  assert.deepEqual(out.map((o) => o.questionId), ['q1', 'q2']);
});

test('validateAnswers: rifiuta tutto cio\' che non combacia con la domanda vera', () => {
  bad(() => validateAnswers(SINGLE, undefined), /mancanti/);
  bad(() => validateAnswers(SINGLE, 'a'), /mancanti/);
  bad(() => validateAnswers(SINGLE, []), /Manca/);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: [] }]), /almeno/);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['zzz'] }]), /sconosciuta/);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a', 'b'] }]), /una sola/);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a'], freeform: 'altro' }]), /una sola/);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: ['a', 'a'] }]), /duplicate/);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: [FREEFORM_ID] }]), /testo/);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: [1] }]), /non valide/);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: 'a' }]), /non valide/);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', freeform: 'x'.repeat(LIMITS.freeformChars + 1) }]), /lunga/);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a'] }, { questionId: 'q1', optionIds: ['b'] }]), /Troppe/);
  bad(() => validateAnswers(TWO, [{ questionId: 'q1', optionIds: ['a'] }]), /Manca/);
  bad(() => validateAnswers(SINGLE, [null]), /Manca/);
  bad(() => validateAnswers({ questions: [] }, []), /Domanda/);
  bad(() => validateAnswers(null, []), /Domanda/);
});

test('cleanText: a capo normalizzati, niente caratteri di controllo, Unicode intatto', () => {
  assert.equal(cleanText('a\r\nb\rc\u0000d\u0007e\u001bf'), 'a\nb\ncdef');
  assert.equal(cleanText('Perche\u0301 \u2014 \u4f60\u597d \u{1f600}'), 'Perche\u0301 \u2014 \u4f60\u597d \u{1f600}');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(12), '12');
});

test('answersMatch: confronta insiemi di opzioni e testo libero (spazi normalizzati)', () => {
  const exp = [{ questionId: 'q1', optionIds: ['a', FREEFORM_ID], freeform: 'ciao  mondo' }];
  assert.equal(answersMatch({ selections: { q1: [FREEFORM_ID, 'a'] }, freeform: { q1: ' ciao mondo ' } }, exp), true);
  assert.equal(answersMatch({ selections: { q1: ['a'] }, freeform: {} }, exp), false);
  assert.equal(answersMatch({ selections: { q1: ['a', FREEFORM_ID] }, freeform: { q1: 'altro' } }, exp), false);
  assert.equal(answersMatch({ selections: { q1: ['a', 'b'] } }, [{ questionId: 'q1', optionIds: ['a'], freeform: '' }]), false);
  assert.equal(answersMatch({ selections: { q2: ['a'] } }, [{ questionId: 'q1', optionIds: ['a'], freeform: '' }]), false);
  assert.equal(answersMatch({ selections: null }, exp), false);
  assert.equal(answersMatch(null, exp), false);
});

// ----------------------------------------------------------------------------------------------------------------
// servizio: coda, scadenza, stato (con finti db/watcher/interfaccia)
// ----------------------------------------------------------------------------------------------------------------

function service({ ui, config = {}, chats = [{ id: 'c1', attention: null }, { id: 'c2', attention: null }], db } = {}) {
  const logs = [];
  const logger = { info: (m, f) => logs.push(['info', m, f]), warn: (m, f) => logs.push(['warn', m, f]), error: (m, f) => logs.push(['error', m, f]), debug() {} };
  const state = { count: 0 };
  const fakeDb = db ?? { composerTail: () => ({ bubbleCount: state.count, queueLength: 0 }), questionResult: () => null };
  const a = new Actions({
    ui,
    db: fakeDb,
    watcher: { last: { chats }, detail: () => null },
    config: { actionsEnabled: true, cdpPollMs: 60_000, actionTimeoutMs: 1000, ...config },
    logger,
    sleep: fast,
  });
  return { a, logs, state };
}

const upUi = (extra = {}) => ({ probe: async () => ({ up: true }), hasWindow: async () => true, ...extra });

test('azioni: due richieste insieme vengono eseguite una alla volta', async () => {
  let active = 0;
  let maxActive = 0;
  let sent = 0;
  const { a, state } = service({
    ui: upUi({
      async sendMessage() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        sent++;
        state.count++;
      },
    }),
  });
  await a.refresh();
  const out = await Promise.all([a.sendMessage('c1', { text: 'uno' }), a.sendMessage('c2', { text: 'due' }), a.sendMessage('c1', { text: 'tre' })]);
  assert.equal(maxActive, 1, 'mai due azioni insieme sulla finestra di Cursor');
  assert.equal(sent, 3);
  assert.ok(out.every((r) => r.ok));
});

test('azioni: alla scadenza il chiamante riceve subito 504, ma la coda resta occupata finche\' Cursor non finisce', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const started = [];
  const { a, state } = service({
    config: { actionTimeoutMs: 30 },
    ui: upUi({
      async sendMessage({ text }) {
        started.push(text);
        if (text === 'bloccato') await gate;
        state.count++;
      },
    }),
  });
  await a.refresh();
  const t0 = Date.now();
  await assert.rejects(a.sendMessage('c1', { text: 'bloccato' }), (e) => e.status === 504 && e.code === 'timeout');
  assert.ok(Date.now() - t0 < 500, 'l\'errore non aspetta la fine del lavoro sottostante');

  const next = a.sendMessage('c2', { text: 'successivo' });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(started, ['bloccato'], 'la seconda azione non parte mentre la prima sta ancora lavorando');
  release();
  await next;
  assert.deepEqual(started, ['bloccato', 'successivo']);
});

test('azioni: stato e disattivazione', async () => {
  const ui = { up: false, window: true, probe: async () => ({ up: ui.up }), hasWindow: async () => ui.window };
  const { a } = service({ ui });
  const seen = [];
  a.on('change', (s) => seen.push(s.reason));
  assert.deepEqual(a.status, { available: false, reason: 'off' });
  await a.refresh();
  assert.deepEqual(a.status, { available: false, reason: 'off' });
  ui.up = true;
  await a.refresh();
  await a.refresh();
  assert.deepEqual(a.status, { available: true, reason: 'ok' });
  ui.window = false;
  await a.refresh();
  assert.deepEqual(a.status, { available: false, reason: 'no_window' });
  ui.up = false;
  await a.refresh();
  assert.deepEqual(seen, ['ok', 'no_window', 'off'], 'l\'evento parte solo quando lo stato cambia');

  let probed = 0;
  const off = service({ ui: { probe: async () => (probed++, { up: true }), hasWindow: async () => true }, config: { actionsEnabled: false } }).a;
  assert.deepEqual(off.status, { available: false, reason: 'disabled' });
  await off.refresh();
  assert.equal(probed, 0, 'disattivate: nemmeno si controlla la porta di debug');
  await assert.rejects(off.sendMessage('c1', { text: 'x' }), (e) => e.status === 503 && e.code === 'actions_disabled');
});

test('azioni: un errore dell\'interfaccia di Cursor sparisce dalla coda e non blocca le richieste seguenti', async () => {
  let n = 0;
  const { a, state } = service({
    ui: upUi({
      async sendMessage() {
        if (n++ === 0) throw Object.assign(new Error('x'), { code: 'no_composer' });
        state.count++;
      },
    }),
  });
  await a.refresh();
  await assert.rejects(a.sendMessage('c1', { text: 'uno' }), (e) => e.status === 502 && e.code === 'ui_failed');
  const ok = await a.sendMessage('c1', { text: 'uno' }); // stesso testo: il fallimento non lo "consuma"
  assert.equal(ok.ok, true);
});

// ----------------------------------------------------------------------------------------------------------------
// integrazione HTTP con interfaccia di Cursor finta (scrive l'esito nel database sintetico, come farebbe Cursor)
// ----------------------------------------------------------------------------------------------------------------

class FakeUi {
  constructor(h) {
    this.h = h;
    this.up = true;
    this.window = true;
    this.calls = [];
    this.fail = null;
    this.onAnswer = null;
    this.onSkip = null;
    this.onMessage = null;
    this.onApproval = null;
    this.onStop = null;
    this.onRename = null;
    this.onArchive = null;
    this.onUnarchive = null;
    this.onNewChat = null;
  }
  async probe() {
    return { up: this.up };
  }
  async hasWindow() {
    return this.up && this.window;
  }
  async #run(kind, args, hook) {
    this.calls.push([kind, args]);
    if (this.fail) throw this.fail;
    await hook?.(args);
    return {};
  }
  async answer(args) {
    return this.#run('answer', args, this.onAnswer);
  }
  async skip(args) {
    return this.#run('skip', args, this.onSkip);
  }
  async sendMessage(args) {
    return this.#run('message', args, this.onMessage);
  }
  async approval(args) {
    return this.#run('approval', args, this.onApproval);
  }
  async stop(args) {
    return this.#run('stop', args, this.onStop);
  }
  async rename(args) {
    return this.#run('rename', args, this.onRename);
  }
  async archive(args) {
    return this.#run('archive', args, this.onArchive);
  }
  async unarchive(args) {
    return this.#run('unarchive', args, this.onUnarchive);
  }
  async newChat(args) {
    this.calls.push(['newChat', args]);
    if (this.fail) throw this.fail;
    return this.onNewChat(args);
  }
}

/** Cursor "registra" la risposta: il bubble passa a `submitted` e il flag "azione bloccante" dell'header si spegne. */
function submit(h, { toolCallId = 'tc-1', selections = {}, freeform = {}, status = 'submitted' } = {}) {
  askingConversation(h.fx, ID, { toolCallId, at: T0 - 2000, status: 'completed', additionalData: { status, currentSelections: selections, freeformTexts: freeform } });
  h.fx.chat(ID, { header: { hasBlockingPendingActions: false } });
}

async function setup({ withQuestion = true } = {}) {
  const ui = new FakeUi();
  const h = await startHarness({ actionsDeps: { ui, sleep: fast } });
  ui.h = h;
  const cookie = await h.pair();
  h.tick();
  if (withQuestion) {
    h.fx.chat(ID, { name: 'Titolo', lastUpdatedAt: T0 - 1000, header: { hasBlockingPendingActions: true } });
    askingConversation(h.fx, ID, { toolCallId: 'tc-1', at: T0 - 2000 });
  } else {
    h.fx.chat(ID, { name: 'Titolo', lastUpdatedAt: T0 - 1000 });
    h.fx.conversation(ID, [
      { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
      { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Fatto.' },
    ]);
  }
  h.tick();
  await h.app.actions.refresh();
  const post = (p, body) => h.req({ method: 'POST', path: `/api/chats/${ID}/${p}`, cookie, body });
  return { h, ui, cookie, post };
}

test('azioni via HTTP: senza porta di debug 503; lo stato arriva a /api/info e /api/state', async () => {
  const { h, ui, cookie, post } = await setup();
  try {
    assert.equal((await h.req({ path: '/api/info', cookie })).json().actions.reason, 'ok');
    assert.equal((await h.req({ path: '/api/state', cookie })).json().status.actions, 'ok');
    ui.up = false;
    await h.app.actions.refresh();
    const info = (await h.req({ path: '/api/info', cookie })).json().actions;
    assert.deepEqual(info, { available: false, reason: 'off', port: 9222 });
    assert.equal((await h.req({ path: '/api/state', cookie })).json().status.actions, 'off', 'lo stato e\' pubblicato anche ai client in ascolto');
    const r = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['a'] }] });
    assert.equal(r.status, 503);
    assert.equal(r.json().error, 'actions_unavailable');
    assert.equal((await post('message', { text: 'ciao' })).status, 503);
    assert.equal((await post('skip', { key: 'tc-1' })).status, 503);
    assert.equal(ui.calls.length, 0);
    ui.up = true;
    ui.window = false;
    await h.app.actions.refresh();
    assert.equal((await h.req({ path: '/api/state', cookie })).json().status.actions, 'no_window');
  } finally {
    await h.stop();
  }
});

test('risposta via HTTP: invia la scelta, la verifica dal database, un secondo invio e una chiave vecchia vengono rifiutati', async () => {
  const { h, ui, cookie, post } = await setup();
  try {
    ui.onAnswer = () => submit(h, { selections: { q1: ['b'] } });
    const r = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['b'] }] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { ok: true, verified: true });
    assert.equal(ui.calls.length, 1);
    const [kind, args] = ui.calls[0];
    assert.equal(kind, 'answer');
    assert.equal(args.composerId, ID);
    assert.equal(args.question.questions[0].prompt, 'Quale approccio preferisci?');
    assert.deepEqual(args.answers, [{ optionIds: ['b'], freeform: '' }]);

    // doppio tocco: stessa richiesta subito dopo -> non parte di nuovo
    const again = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['b'] }] });
    assert.equal(again.status, 409);
    assert.equal(again.json().error, 'already_sent');
    assert.equal(ui.calls.length, 1);

    // il daemon vede la risposta: la domanda non e' piu' attuale
    h.tick();
    const late = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['a'] }] });
    assert.equal(late.status, 409);
    assert.equal(late.json().error, 'stale');
    assert.equal(ui.calls.length, 1);
    assert.equal((await h.req({ path: '/api/state', cookie })).json().state.counts.attention, 0);
  } finally {
    await h.stop();
  }
});

test('risposta via HTTP: controlli prima di toccare Cursor (chiave, risposte, metodo, chat)', async () => {
  const { h, ui, cookie, post } = await setup();
  try {
    const good = [{ questionId: 'q1', optionIds: ['a'] }];
    assert.equal((await post('answer', { answers: good })).json().error, 'bad_key');
    assert.equal((await post('answer', { key: 'tc-1' })).json().error, 'bad_answer');
    assert.equal((await post('answer', { key: 'altra', answers: good })).json().error, 'stale');
    assert.equal((await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['zzz'] }] })).json().error, 'bad_answer');
    assert.equal((await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['a', 'b'] }] })).json().error, 'bad_answer');
    assert.equal((await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: [FREEFORM_ID] }] })).json().error, 'bad_answer');
    assert.equal((await h.req({ method: 'GET', path: `/api/chats/${ID}/answer`, cookie })).status, 405);
    assert.equal((await h.req({ method: 'POST', path: '/api/chats/zzzzzzzz-nuova/answer', cookie, body: { key: 'x', answers: good } })).status, 404);
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/answer`, body: { key: 'tc-1', answers: good } })).status, 401, 'serve la sessione');
    assert.equal(
      (await h.req({ method: 'POST', path: `/api/chats/${ID}/answer`, cookie, headers: { Origin: 'https://evil.example.com' }, body: { key: 'tc-1', answers: good } })).status,
      403,
      'Origin diverso dal Host = bloccato',
    );
    assert.equal(ui.calls.length, 0, 'nessun controllo fallito deve arrivare a Cursor');
  } finally {
    await h.stop();
  }
});

test('risposta via HTTP: testo libero, errori di Cursor tradotti, ritentabile; nessun contenuto nei log', async () => {
  const { h, ui, post } = await setup();
  try {
    const SECRET = 'SEGRETO-RISPOSTA-XYZ';
    const body = { key: 'tc-1', answers: [{ questionId: 'q1', freeform: SECRET }] };
    const expectCode = { mismatch: [409, 'mismatch'], row_not_found: [409, 'chat_not_in_sidebar'], no_tray: [409, 'no_question'], draft_not_empty: [409, 'draft_not_empty'], timeout: [504, 'timeout'], closed: [503, 'actions_unavailable'], weird: [502, 'ui_failed'] };
    for (const [code, [status, error]] of Object.entries(expectCode)) {
      ui.fail = Object.assign(new Error(`dettaglio-interno ${SECRET}`), { code });
      const r = await post('answer', body);
      assert.equal(r.status, status, code);
      assert.equal(r.json().error, error, code);
      assert.doesNotMatch(r.text, /dettaglio-interno|SEGRETO/, 'il dettaglio interno non esce mai al client');
    }
    ui.fail = null;
    ui.onAnswer = () => submit(h, { selections: { q1: [FREEFORM_ID] }, freeform: { q1: SECRET } });
    const ok = await post('answer', body); // dopo i fallimenti la stessa richiesta e' ancora ammessa
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json(), { ok: true, verified: true });
    assert.deepEqual(ui.calls.at(-1)[1].answers, [{ optionIds: [FREEFORM_ID], freeform: SECRET }]);

    const logs = h.logLines.join('');
    assert.match(logs, /action_failed/);
    assert.match(logs, /action_ok/);
    assert.doesNotMatch(logs, /SEGRETO|dettaglio-interno|Quale approccio|Veloce|Accurato/, 'nessun contenuto di chat nei log');
  } finally {
    await h.stop();
  }
});

test('risposta via HTTP: se il database non conferma, o conferma altro, lo si dice (verified: false)', async () => {
  const { h, ui, post } = await setup();
  try {
    // Cursor non scrive nulla entro il tempo di attesa
    const r1 = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['a'] }] });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json(), { ok: true, verified: false });

    // Cursor registra una scelta diversa da quella inviata
    ui.onAnswer = () => submit(h, { selections: { q1: ['a'] } });
    const r2 = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['b'] }] });
    assert.equal(r2.status, 409, 'la stessa richiesta e\' gia\' stata inviata (60 s)'); // stessa chiave: protezione dal doppio invio
    assert.equal(r2.json().error, 'already_sent');
  } finally {
    await h.stop();
  }
});

test('risposta via HTTP: esito diverso da quello inviato = verified false con avviso', async () => {
  const { h, ui, post } = await setup();
  try {
    ui.onAnswer = () => submit(h, { selections: { q1: ['a'] } });
    const r = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['b'] }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, verified: false, warning: 'differs' });
  } finally {
    await h.stop();
  }
});

test('salta via HTTP: usa la chiave della domanda e verifica che non sia piu\' in attesa', async () => {
  const { h, ui, post } = await setup();
  try {
    assert.equal((await post('skip', {})).json().error, 'bad_key');
    assert.equal((await post('skip', { key: 'altra' })).json().error, 'stale');
    ui.onSkip = () => submit(h, { status: 'skipped' });
    const r = await post('skip', { key: 'tc-1' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, verified: true });
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0][0], 'skip');
    assert.equal((await post('skip', { key: 'tc-1' })).json().error, 'already_sent');
  } finally {
    await h.stop();
  }
});

test('messaggio via HTTP: testo ripulito, verifica dal database, coda, doppio invio e limiti', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    assert.equal((await post('message', {})).json().error, 'bad_text');
    assert.equal((await post('message', { text: '   \n ' })).json().error, 'bad_text');
    assert.equal((await post('message', { text: 12 })).json().error, 'bad_text');
    const long = await post('message', { text: 'x'.repeat(LIMITS.messageChars + 1) });
    assert.equal(long.status, 400);
    assert.equal(long.json().error, 'too_long');
    assert.equal(ui.calls.length, 0);

    // Cursor aggiunge un bubble: confermato
    ui.onMessage = () =>
      h.fx.conversation(ID, [
        { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
        { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Fatto.' },
        { id: 'b3', type: 1, createdAt: T0 - 1000, text: 'ciao' },
      ]);
    const r = await post('message', { text: '  ciao\r\ncome va\u0000  ' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { ok: true, verified: true, queued: false });
    assert.deepEqual(ui.calls[0][1], { composerId: ID, text: 'ciao\ncome va' });

    // doppio tocco con lo stesso testo
    const dup = await post('message', { text: 'ciao\ncome va' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json().error, 'already_sent');
    assert.equal(ui.calls.length, 1);

    // un testo diverso va; Cursor lo mette in coda (l'agente sta lavorando)
    ui.onMessage = () =>
      h.fx.conversation(
        ID,
        [
          { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
          { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Fatto.' },
          { id: 'b3', type: 1, createdAt: T0 - 1000, text: 'ciao' },
        ],
        { queueItems: [{ id: 'q' }] },
      );
    const q = await post('message', { text: 'ancora una cosa' });
    assert.deepEqual(q.json(), { ok: true, verified: true, queued: true });

    // niente di visibile: nessuna conferma, ma il messaggio e' partito
    ui.onMessage = null;
    const nov = await post('message', { text: 'terza cosa' });
    assert.deepEqual(nov.json(), { ok: true, verified: false, queued: false });
  } finally {
    await h.stop();
  }
});

test('messaggio via HTTP: con una domanda in attesa si risponde alla domanda, non si scrive', async () => {
  const { h, ui, post } = await setup();
  try {
    const r = await post('message', { text: 'ciao' });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'question_pending');
    assert.equal(ui.calls.length, 0);
    // limite del corpo: 64 KB per le azioni (oltre = 413), 16 KB per il resto
    const huge = await h.req({ method: 'POST', path: `/api/chats/${ID}/message`, cookie: await h.pair(), body: { text: 'x'.repeat(70 * 1024) } });
    assert.equal(huge.status, 413);
  } finally {
    await h.stop();
  }
});

test('messaggio via HTTP: con un\'approvazione in attesa non si scrive (potrebbe annullare il comando); a decisione presa si', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    approvingConversation(h.fx, ID, { at: T0 - 2000, composerStatus: 'aborted' });
    h.fx.chat(ID, { lastUpdatedAt: T0 - 1000, header: { unfinishedRunAt: T0 - 30_000 } });
    h.tick();
    const r = await post('message', { text: 'ciao' });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'approval_pending');
    assert.match(r.json().message, /approvazione/);
    assert.equal(ui.calls.length, 0, 'Cursor non viene toccato');

    // approvata dal Mac: reviewData passa a Done e si puo' scrivere di nuovo
    approvingConversation(h.fx, ID, { at: T0 - 2000, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
    h.tick();
    const ok = await post('message', { text: 'ciao' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ui.calls.length, 1);
  } finally {
    await h.stop();
  }
});

test('messaggio via HTTP: testo non ASCII lungo entra nel limite di 64 KB del corpo', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    ui.onMessage = () =>
      h.fx.conversation(ID, [
        { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
        { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Fatto.' },
        { id: 'b3', type: 1, createdAt: T0 - 1000, text: 'x' },
      ]);
    const text = '\u00e8'.repeat(LIMITS.messageChars); // 2 byte per carattere: ~16 KB, sopra il limite generico
    const r = await post('message', { text });
    assert.equal(r.status, 200, r.text);
    assert.equal(ui.calls[0][1].text.length, LIMITS.messageChars);
  } finally {
    await h.stop();
  }
});

test('nullLogger e servizio: un Actions senza finestra non lancia mai dal controllo di stato', async () => {
  const a = new Actions({
    ui: { probe: async () => { throw new Error('boom'); }, hasWindow: async () => true },
    db: {},
    watcher: { last: { chats: [] } },
    config: { actionsEnabled: true, cdpPollMs: 5000, actionTimeoutMs: 1000 },
    logger: nullLogger,
  });
  assert.deepEqual(await a.refresh(), { available: false, reason: 'off' });
});

// ----------------------------------------------------------------------------------------------------------------
// approvare / rifiutare un comando dal telefono
// ----------------------------------------------------------------------------------------------------------------

async function setupApproval({ config } = {}) {
  const s = await setup({ withQuestion: false });
  approvingConversation(s.h.fx, ID, { toolCallId: 'tc-ap', at: T0 - 2000, composerStatus: 'aborted' });
  s.h.fx.chat(ID, { lastUpdatedAt: T0 - 1000, header: { hasBlockingPendingActions: true, unfinishedRunAt: T0 - 30_000 } });
  s.h.tick();
  return s;
}

test('approvazione via HTTP: il dettaglio mostra il comando da decidere; "approve" clicca Run sul bubble giusto e il database conferma', async () => {
  const { h, ui, cookie, post } = await setupApproval();
  try {
    const d = (await h.req({ path: `/api/chats/${ID}`, cookie })).json();
    assert.equal(d.approval.supported, true);
    assert.equal(d.approval.key, 'tc-ap');
    assert.equal(d.approval.command, 'echo prova');
    assert.equal(d.approval.type, 'Esegue un comando');
    // Cursor registra la decisione: reviewData diventa Done
    ui.onApproval = () => approvingConversation(h.fx, ID, { toolCallId: 'tc-ap', at: T0 - 2000, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
    const r = await post('approval', { key: 'tc-ap', decision: 'approve' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { ok: true, verified: true, decision: 'approve' });
    assert.deepEqual(ui.calls.map((c) => [c[0], c[1].composerId, c[1].bubbleId, c[1].decision]), [['approval', ID, 'b2', 'approve']]);
    // nei log solo decisione ed esito, mai il comando
    assert.equal(h.logLines.join('').includes('echo prova'), false);
    assert.match(h.logLines.join(''), /approval_decision/);
    // lo stesso invio ripetuto e' rifiutato
    const again = await post('approval', { key: 'tc-ap', decision: 'approve' });
    assert.ok([409].includes(again.status));
  } finally {
    await h.stop();
  }
});

test('approvazione via HTTP: rifiuta chiave vecchia, decisione non valida, tool non di terminale e funzione disattivata (Cursor mai toccato)', async () => {
  const { h, ui, post } = await setupApproval();
  try {
    assert.equal((await post('approval', { key: 'altra', decision: 'approve' })).json().error, 'stale');
    assert.equal((await post('approval', { key: 'tc-ap', decision: 'forse' })).json().error, 'bad_decision');
    assert.equal((await post('approval', { decision: 'approve' })).json().error, 'bad_key');
    assert.equal(ui.calls.length, 0);

    // non e' un comando di terminale: da qui non si decide
    h.fx.conversation(ID, [
      { id: 'b1', type: 1, createdAt: T0 - 5000, text: 'Fai' },
      { id: 'b2', type: 2, createdAt: T0 - 2000, tool: { name: 'mcp_tool_x', status: 'loading', toolCallId: 'tc-mcp', params: {}, additionalData: { reviewData: { status: 'Requested', approvalType: 'user' } } } },
    ], { status: 'aborted' });
    h.tick();
    const d = await post('approval', { key: 'tc-mcp', decision: 'approve' });
    assert.equal(d.status, 409);
    assert.equal(d.json().error, 'unsupported');
    assert.equal(ui.calls.length, 0);
  } finally {
    await h.stop();
  }

  const off = await startHarness({ configOverrides: { approvalsEnabled: false }, actionsDeps: { ui: new FakeUi(), sleep: fast } });
  try {
    const cookie = await off.pair();
    off.fx.chat(ID, { name: 'Titolo', lastUpdatedAt: T0 - 1000 });
    off.tick();
    const r = await off.req({ method: 'POST', path: `/api/chats/${ID}/approval`, cookie, body: { key: 'k', decision: 'approve' } });
    assert.equal(r.json().error, 'approvals_disabled');
  } finally {
    await off.stop();
  }
});

test('approvazione via HTTP: se la carta in Cursor si chiude (settled) la conferma e\' immediata anche se il database non e\' ancora cambiato', async () => {
  const { h, ui, post } = await setupApproval();
  try {
    ui.onApproval = null;
    ui.approval = async (args) => (ui.calls.push(['approval', args]), { clicked: true, settled: true });
    const t = Date.now();
    const r = await post('approval', { key: 'tc-ap', decision: 'reject' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().verified, true);
    assert.ok(Date.now() - t < 2000, 'nessuna attesa inutile');
  } finally {
    await h.stop();
  }
});

test('approvazione via HTTP: un comando troppo lungo per essere letto per intero si puo\' rifiutare ma non eseguire da qui', async () => {
  const { h, ui, cookie, post } = await setupApproval();
  try {
    approvingConversation(h.fx, ID, { toolCallId: 'tc-ap', at: T0 - 2000, composerStatus: 'aborted', command: 'x'.repeat(2500) });
    h.tick();
    const d = (await h.req({ path: `/api/chats/${ID}`, cookie })).json();
    assert.equal(d.approval.truncated, true);
    assert.equal(d.approval.command.length, 2000);
    const r = await post('approval', { key: 'tc-ap', decision: 'approve' });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'command_too_long');
    assert.equal(ui.calls.length, 0);
    ui.onApproval = () => approvingConversation(h.fx, ID, { toolCallId: 'tc-ap', at: T0 - 2000, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
    assert.equal((await post('approval', { key: 'tc-ap', decision: 'reject' })).status, 200);
  } finally {
    await h.stop();
  }
});

test('ferma l\'agente via HTTP: solo se sta lavorando, clic sulla chat giusta, esito verificato, niente doppio invio', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    // chat ferma: nessun clic
    const idle = await post('stop', {});
    assert.equal(idle.status, 409);
    assert.equal(idle.json().error, 'not_running');
    assert.equal(ui.calls.length, 0);

    h.fx.chat(ID, { name: 'Titolo', lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 1000 } });
    h.fx.conversation(ID, [
      { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
      { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Sto lavorando...' },
    ], { status: 'generating' });
    h.tick();
    ui.stop = async (args) => (ui.calls.push(['stop', args]), { clicked: true, settled: true });
    const r = await post('stop', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().verified, true);
    assert.deepEqual(ui.calls.map((c) => c[0]), ['stop']);
    assert.equal(ui.calls[0][1].composerId, ID);
    const again = await post('stop', {});
    assert.equal(again.status, 409);
    assert.equal(again.json().error, 'already_sent');
  } finally {
    await h.stop();
  }
});

test('ferma l\'agente via HTTP: errore di Cursor tradotto, nessuna azione con la porta di debug chiusa', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    h.fx.chat(ID, { name: 'Titolo', lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 1000 } });
    h.tick();
    ui.fail = Object.assign(new Error('x'), { code: 'not_running' });
    const r = await post('stop', {});
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'not_running');
    ui.fail = null;
    ui.up = false;
    await h.app.actions.refresh();
    const off = await post('stop', {});
    assert.equal(off.status, 503);
  } finally {
    await h.stop();
  }
});

test('rinomina via HTTP: nome ripulito e validato, clic sulla chat giusta, esito letto dal database, niente doppio invio', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    ui.onRename = ({ name }) => h.fx.chat(ID, { name });
    assert.equal((await post('rename', {})).status, 400);
    assert.equal((await post('rename', { name: '   ' })).status, 400);
    assert.equal((await post('rename', { name: 'x'.repeat(101) })).status, 400);
    assert.equal(ui.calls.length, 0, 'nessun accesso a Cursor con un nome non valido');

    const r = await post('rename', { name: '  Nuovo\n  nome\u0007 ' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().verified, true);
    assert.deepEqual(ui.calls.map((c) => [c[0], c[1].composerId, c[1].name]), [['rename', ID, 'Nuovo nome']]);
    assert.equal((await post('rename', { name: 'Nuovo nome' })).json().error, 'already_sent');
    assert.equal((await h.req({ method: 'POST', path: '/api/chats/22222222-2222-4222-8222-222222222222/rename', cookie: h.cookie ?? (await h.pair()), body: { name: 'x' } })).status, 404);

    ui.onRename = null; // Cursor non cambia il nome: non confermato
    const nc = await post('rename', { name: 'Altro' });
    assert.equal(nc.json().verified, false);
    assert.ok(!h.logLines.join('').includes('Nuovo nome'), 'il nome non finisce nei log');
  } finally {
    await h.stop();
  }
});

test('archivia e ripristina via HTTP: non una chat che lavora; elenco archiviate; verifica dal database', async () => {
  const { h, ui, cookie, post } = await setup({ withQuestion: false });
  try {
    // chat che lavora: no
    h.fx.chat(ID, { name: 'Titolo', lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 1000 } });
    h.fx.conversation(ID, [{ id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' }, { id: 'b2', type: 2, createdAt: T0 - 2000, text: '...' }], { status: 'generating' });
    h.tick();
    const busy = await post('archive', {});
    assert.equal(busy.status, 409);
    assert.equal(busy.json().error, 'running');
    assert.equal(ui.calls.length, 0);

    // ferma: si archivia
    h.fx.chat(ID, { header: { unfinishedRunAt: undefined } });
    h.fx.db.prepare('UPDATE cursorDiskKV SET value = json_set(value, \'$.status\', \'completed\') WHERE key = ?').run(`composerData:${ID}`);
    h.tick();
    ui.onArchive = () => h.fx.chat(ID, { archived: true });
    const r = await post('archive', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().verified, true);
    h.tick();

    // ora e' archiviata: compare nell'elenco, non nello stato
    const list = (await h.req({ path: '/api/archived', cookie })).json().chats;
    assert.deepEqual(list.map((c) => c.id), [ID]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'lastUpdatedAt', 'name', 'sectionId', 'workspaceName']);
    assert.equal((await h.req({ path: '/api/archived' })).status, 401);

    // ripristino: solo di una archiviata
    assert.equal((await h.req({ method: 'POST', path: '/api/archived/22222222-2222-4222-8222-222222222222/restore', cookie, body: {} })).status, 404);
    ui.onUnarchive = () => h.fx.chat(ID, { archived: false });
    const back = await h.req({ method: 'POST', path: `/api/archived/${ID}/restore`, cookie, body: {} });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json().verified, true);
    assert.deepEqual(ui.calls.map((c) => c[0]), ['archive', 'unarchive']);
    h.tick();
    assert.equal((await h.req({ path: '/api/archived', cookie })).json().chats.length, 0);
  } finally {
    await h.stop();
  }
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

test('immagini: caricamento controllato dal contenuto, messaggio con allegati, file cancellati dopo l\'invio', async () => {
  const { h, ui, cookie, post } = await setup({ withQuestion: false });
  try {
    const up = (body, type = 'image/png') => h.req({ method: 'POST', path: '/api/uploads', cookie, headers: { 'Content-Type': type }, body });
    assert.equal((await h.req({ method: 'POST', path: '/api/uploads', headers: { 'Content-Type': 'image/png' }, body: PNG })).status, 401);
    assert.equal((await up(Buffer.from('non sono un\'immagine'))).status, 415, 'il contenuto conta, non il tipo dichiarato');
    assert.equal((await up(PNG, 'text/plain')).status, 415);
    assert.equal((await up(Buffer.alloc(0))).status, 415);
    assert.equal((await up(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]))).status, 413);

    const a = await up(PNG);
    assert.equal(a.status, 200, a.text);
    const id = a.json().id;
    assert.match(id, /^[a-f0-9]{32}$/);
    const dir = path.join(h.fx.dir, 'data', 'uploads');
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, [`${id}.png`]);
    assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);

    // id inventato / non una lista / troppi allegati
    assert.equal((await post('message', { text: 'x', images: ['a'.repeat(32)] })).json().error, 'image_expired');
    assert.equal((await post('message', { text: 'x', images: 'no' })).json().error, 'bad_images');
    assert.equal((await post('message', { text: 'x', images: [id, id, id, id, id] })).json().error, 'bad_images');
    assert.equal((await post('message', { images: [] })).json().error, 'bad_text');
    assert.equal(ui.calls.length, 0);

    // con solo l'immagine (niente testo) si puo' inviare; la UI riceve il percorso del file
    ui.onMessage = () =>
      h.fx.conversation(ID, [
        { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
        { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Fatto.' },
        { id: 'b3', type: 1, createdAt: T0 - 1000, text: '' },
      ]);
    const r = await post('message', { images: [id] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ui.calls[0][1], { composerId: ID, text: '', files: [path.join(dir, `${id}.png`)] });
    assert.deepEqual(fs.readdirSync(dir), [], 'dopo l\'invio il file non c\'e\' piu\'');
    assert.ok(!h.logLines.join('').includes(id), 'nessun id o percorso nei log');
    assert.equal((await post('message', { text: 'x', images: [id] })).json().error, 'image_expired');

    // se l'invio fallisce il file resta (si puo' ritentare) e si puo' cancellare
    const b = (await up(PNG)).json().id;
    ui.onMessage = () => {
      throw Object.assign(new Error('x'), { code: 'attach_failed' });
    };
    const bad = await post('message', { text: 'ciao', images: [b] });
    assert.equal(bad.status, 409);
    assert.deepEqual(fs.readdirSync(dir), [`${b}.png`]);
    const del = await h.req({ method: 'DELETE', path: `/api/uploads/${b}`, cookie });
    assert.equal(del.status, 200);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await h.stop();
  }
});

const NEW_ID = '33333333-3333-4333-8333-333333333333';

test('nuova chat via HTTP: progetto risolto dal daemon, controlli, file allegati, chat nuova confermata dal database', async () => {
  const { h, ui, cookie, post } = await setup({ withQuestion: false });
  try {
    const sectionId = h.app.watcher.last.chats[0].sectionId;
    const project = h.app.watcher.last.chats[0].workspaceName;
    const create = (body) => h.req({ method: 'POST', path: '/api/chats', cookie, body });
    assert.equal((await h.req({ method: 'POST', path: '/api/chats', body: { sectionId, text: 'x' } })).status, 401);
    assert.equal((await create({ text: 'ciao' })).json().error, 'bad_project');
    assert.equal((await create({ sectionId, text: '  ' })).json().error, 'bad_text');
    assert.equal((await create({ sectionId, text: 'x', images: 'no' })).json().error, 'bad_images');
    assert.equal((await create({ sectionId: 'sconosciuto', text: 'ciao' })).status, 404);
    assert.equal((await create({ sectionId, text: 'x'.repeat(LIMITS.messageChars + 1) })).json().error, 'too_long');
    assert.equal(ui.calls.length, 0);

    ui.onNewChat = ({ project: p, text }) => {
      assert.equal(p, project);
      h.fx.chat(NEW_ID, { name: text.slice(0, 20), lastUpdatedAt: T0 - 100 });
      return { composerId: NEW_ID };
    };
    const r = await create({ sectionId, text: '  Crea  un\nREADME\u0000 ' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { ok: true, chatId: NEW_ID, verified: true });
    assert.deepEqual(ui.calls[0][1], { project, text: 'Crea  un\nREADME' });
    assert.equal((await create({ sectionId, text: 'Crea  un\nREADME' })).json().error, 'already_sent', 'doppio tocco');
    assert.ok(!h.logLines.join('').includes('README'), 'il testo non finisce nei log');

    // errori della UI tradotti
    ui.onNewChat = () => {
      throw Object.assign(new Error('x'), { code: 'not_local' });
    };
    const nl = await create({ sectionId, text: 'altro' });
    assert.equal(nl.status, 409);
    assert.equal(nl.json().error, 'not_local');
    ui.onNewChat = () => {
      throw Object.assign(new Error('x'), { code: 'project_not_found' });
    };
    assert.equal((await create({ sectionId, text: 'ancora' })).json().error, 'project_not_found');
  } finally {
    await h.stop();
  }
});
