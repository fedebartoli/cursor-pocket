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
// pure functions
// ----------------------------------------------------------------------------------------------------------------

test('validateAnswers: single choice, multiple choice, freeform and multiple questions', () => {
  assert.deepEqual(validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a'] }]), [{ questionId: 'q1', optionIds: ['a'], freeform: '' }]);
  assert.deepEqual(validateAnswers(MULTI, [{ questionId: 'q1', optionIds: ['a', 'c'] }]), [{ questionId: 'q1', optionIds: ['a', 'c'], freeform: '' }]);
  // freeform only: reserved id added, text cleaned
  assert.deepEqual(validateAnswers(SINGLE, [{ questionId: 'q1', freeform: '  altro\r\ntesto  ' }]), [{ questionId: 'q1', optionIds: [FREEFORM_ID], freeform: 'altro\ntesto' }]);
  // multiple: options + freeform (freeform always last)
  assert.deepEqual(validateAnswers(MULTI, [{ questionId: 'q1', optionIds: [FREEFORM_ID, 'b'], freeform: 'x' }]), [{ questionId: 'q1', optionIds: ['b', FREEFORM_ID], freeform: 'x' }]);
  // two questions: order follows question, not request
  const out = validateAnswers(TWO, [{ questionId: 'q2', optionIds: ['x', 'y'] }, { questionId: 'q1', optionIds: ['a'] }]);
  assert.deepEqual(out.map((o) => o.questionId), ['q1', 'q2']);
});

test('validateAnswers: rejects anything that does not match the real question', () => {
  bad(() => validateAnswers(SINGLE, undefined), /missing/i);
  bad(() => validateAnswers(SINGLE, 'a'), /missing/i);
  bad(() => validateAnswers(SINGLE, []), /not answered/i);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: [] }]), /at least/i);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['zzz'] }]), /unknown/i);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a', 'b'] }]), /one answer/i);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a'], freeform: 'altro' }]), /one answer/i);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: ['a', 'a'] }]), /duplicate/i);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: [FREEFORM_ID] }]), /free-form/i);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: [1] }]), /invalid options/i);
  bad(() => validateAnswers(MULTI, [{ questionId: 'q1', optionIds: 'a' }]), /invalid options/i);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', freeform: 'x'.repeat(LIMITS.freeformChars + 1) }]), /too long/i);
  bad(() => validateAnswers(SINGLE, [{ questionId: 'q1', optionIds: ['a'] }, { questionId: 'q1', optionIds: ['b'] }]), /too many/i);
  bad(() => validateAnswers(TWO, [{ questionId: 'q1', optionIds: ['a'] }]), /not answered/i);
  bad(() => validateAnswers(SINGLE, [null]), /not answered/i);
  bad(() => validateAnswers({ questions: [] }, []), /invalid question/i);
  bad(() => validateAnswers(null, []), /invalid question/i);
});

test('cleanText: normalized newlines, no control chars, Unicode preserved', () => {
  assert.equal(cleanText('a\r\nb\rc\u0000d\u0007e\u001bf'), 'a\nb\ncdef');
  assert.equal(cleanText('Perche\u0301 \u2014 \u4f60\u597d \u{1f600}'), 'Perche\u0301 \u2014 \u4f60\u597d \u{1f600}');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(12), '12');
});

test('answersMatch: compares option sets and freeform (normalized spaces)', () => {
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
// service: queue, timeout, status (fake db/watcher/ui)
// ----------------------------------------------------------------------------------------------------------------

function service({ ui, config = {}, chats = [{ id: 'c1', attention: null }, { id: 'c2', attention: null }], db, now } = {}) {
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
    ...(now ? { now } : {}),
  });
  return { a, logs, state };
}

const upUi = (extra = {}) => ({ probe: async () => ({ up: true }), hasWindow: async () => true, ...extra });

test('actions: concurrent requests run one at a time', async () => {
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
  assert.equal(maxActive, 1, 'never two actions at once on Cursor window');
  assert.equal(sent, 3);
  assert.ok(out.every((r) => r.ok));
});

test('actions: on timeout caller gets 504 immediately but queue stays busy until Cursor finishes', async () => {
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
  assert.ok(Date.now() - t0 < 500, 'error does not wait for underlying work to finish');

  const next = a.sendMessage('c2', { text: 'successivo' });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(started, ['bloccato'], 'second action does not start while first still working');
  release();
  await next;
  assert.deepEqual(started, ['bloccato', 'successivo']);
});

test('actions: after 504 immediate resend rejected (otherwise queued and sent twice)', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const sent = [];
  const { a } = service({
    config: { actionTimeoutMs: 30 },
    ui: upUi({
      async sendMessage({ text }) {
        sent.push(text);
        if (sent.length === 1) await gate;
      },
    }),
  });
  await a.refresh();
  await assert.rejects(a.sendMessage('c1', { text: 'ciao' }), (e) => e.code === 'timeout');
  await assert.rejects(a.sendMessage('c1', { text: 'ciao' }), (e) => e.status === 409 && e.code === 'already_sent');
  release();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(sent, ['ciao'], 'message sent only once');
});

test('actions: status and disable', async () => {
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
  assert.deepEqual(seen, ['ok', 'no_window', 'off'], 'event only when status changes');

  let probed = 0;
  const off = service({ ui: { probe: async () => (probed++, { up: true }), hasWindow: async () => true }, config: { actionsEnabled: false } }).a;
  assert.deepEqual(off.status, { available: false, reason: 'disabled' });
  await off.refresh();
  assert.equal(probed, 0, 'disabled: debug port not even probed');
  await assert.rejects(off.sendMessage('c1', { text: 'x' }), (e) => e.status === 503 && e.code === 'actions_disabled');
});

test('actions: Cursor UI error clears queue and does not block following requests', async () => {
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
  await assert.rejects(a.sendMessage('c1', { text: 'uno' }), (e) => e.status === 409 && e.code === 'ui_changed' && e.detail === 'no_composer');
  const ok = await a.sendMessage('c1', { text: 'uno' }); // same text: failure does not "consume" it
  assert.equal(ok.ok, true);
});

// ----------------------------------------------------------------------------------------------------------------
// HTTP integration with fake Cursor UI (writes outcome to synthetic DB, as Cursor would)
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
  async pinState(args) {
    this.calls.push(['pinState', args]);
    if (this.fail) throw this.fail;
    return { pinned: this.pinned === true };
  }
  async setPinned(args) {
    this.calls.push(['setPinned', args]);
    if (this.fail) throw this.fail;
    this.pinned = args.pinned;
    return { pinned: args.pinned, changed: true };
  }
  async newChatOptions(args) {
    this.calls.push(['newChatOptions', args]);
    if (this.fail) throw this.fail;
    return { branch: { current: 'main', options: ['main', 'sviluppo'] }, model: { current: 'Auto', options: ['Auto', 'Composer 2.5'] } };
  }
  async newChat(args) {
    this.calls.push(['newChat', args]);
    if (this.fail) throw this.fail;
    return this.onNewChat(args);
  }
}

/** Cursor "records" the answer: bubble becomes `submitted` and header blocking-action flag turns off. */
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

test('HTTP actions: no debug port 503; status on /api/info and /api/state', async () => {
  const { h, ui, cookie, post } = await setup();
  try {
    assert.equal((await h.req({ path: '/api/info', cookie })).json().actions.reason, 'ok');
    assert.equal((await h.req({ path: '/api/state', cookie })).json().status.actions, 'ok');
    ui.up = false;
    await h.app.actions.refresh();
    const info = (await h.req({ path: '/api/info', cookie })).json().actions;
    assert.deepEqual(info, { available: false, reason: 'off', port: 9222 });
    assert.equal((await h.req({ path: '/api/state', cookie })).json().status.actions, 'off', 'status published to listening clients too');
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

test('HTTP answer: sends choice, verifies from DB, resend and stale key rejected', async () => {
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

    // double tap: same request right after -> does not run again
    const again = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['b'] }] });
    assert.equal(again.status, 409);
    assert.equal(again.json().error, 'already_sent');
    assert.equal(ui.calls.length, 1);

    // daemon sees answer: question no longer current
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

test('HTTP answer: checks before touching Cursor (key, answers, method, chat)', async () => {
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
    assert.equal((await h.req({ method: 'POST', path: `/api/chats/${ID}/answer`, body: { key: 'tc-1', answers: good } })).status, 401, 'session required');
    assert.equal(
      (await h.req({ method: 'POST', path: `/api/chats/${ID}/answer`, cookie, headers: { Origin: 'https://evil.example.com' }, body: { key: 'tc-1', answers: good } })).status,
      403,
      'Origin different from Host = blocked',
    );
    assert.equal(ui.calls.length, 0, 'no failed check must reach Cursor');
  } finally {
    await h.stop();
  }
});

test('HTTP answer: freeform, translated Cursor errors, retryable; no content in logs', async () => {
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
      assert.doesNotMatch(r.text, /dettaglio-interno|SEGRETO/, 'internal detail never exposed to client');
    }
    ui.fail = null;
    ui.onAnswer = () => submit(h, { selections: { q1: [FREEFORM_ID] }, freeform: { q1: SECRET } });
    const ok = await post('answer', body); // after failures same request still allowed
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json(), { ok: true, verified: true });
    assert.deepEqual(ui.calls.at(-1)[1].answers, [{ optionIds: [FREEFORM_ID], freeform: SECRET }]);

    const logs = h.logLines.join('');
    assert.match(logs, /action_failed/);
    assert.match(logs, /action_ok/);
    assert.doesNotMatch(logs, /SEGRETO|dettaglio-interno|Quale approccio|Veloce|Accurato/, 'no chat content in logs');
  } finally {
    await h.stop();
  }
});

test('HTTP answer: if DB does not confirm or confirms differently (verified: false)', async () => {
  const { h, ui, post } = await setup();
  try {
    // Cursor writes nothing within wait time
    const r1 = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['a'] }] });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json(), { ok: true, verified: false });

    // Cursor records choice different from sent
    ui.onAnswer = () => submit(h, { selections: { q1: ['a'] } });
    const r2 = await post('answer', { key: 'tc-1', answers: [{ questionId: 'q1', optionIds: ['b'] }] });
    assert.equal(r2.status, 409, 'same request already sent (60 s)'); // same key: duplicate-send protection
    assert.equal(r2.json().error, 'already_sent');
  } finally {
    await h.stop();
  }
});

test('HTTP answer: outcome differs from sent = verified false with warning', async () => {
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

test('HTTP skip: uses question key and verifies no longer pending', async () => {
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

test('HTTP message: cleaned text, DB verify, queue, duplicate send and limits', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    assert.equal((await post('message', {})).json().error, 'bad_text');
    assert.equal((await post('message', { text: '   \n ' })).json().error, 'bad_text');
    assert.equal((await post('message', { text: 12 })).json().error, 'bad_text');
    const long = await post('message', { text: 'x'.repeat(LIMITS.messageChars + 1) });
    assert.equal(long.status, 400);
    assert.equal(long.json().error, 'too_long');
    assert.equal(ui.calls.length, 0);

    // Cursor adds bubble: confirmed
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

    // the same text again right after a confirmed delivery is a deliberate repeat ("yes", "continue"); this time the
    // database shows nothing new, so the outcome is uncertain
    const again = await post('message', { text: 'ciao\ncome va' });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json().verified, false);
    assert.equal(ui.calls.length, 2);

    // uncertain outcome: a tap on the same text is refused, "send anyway" (force) is accepted
    const dup = await post('message', { text: 'ciao\ncome va' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json().error, 'already_sent');
    assert.equal(ui.calls.length, 2);
    assert.equal((await post('message', { text: 'ciao\ncome va', force: true })).status, 200);
    assert.equal(ui.calls.length, 3);

    // different text ok; Cursor queues it (agent working)
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

    // nothing visible: no confirm but message was sent
    ui.onMessage = null;
    const nov = await post('message', { text: 'terza cosa' });
    assert.deepEqual(nov.json(), { ok: true, verified: false, queued: false });
  } finally {
    await h.stop();
  }
});

test('HTTP message: pending question blocks message send', async () => {
  const { h, ui, post } = await setup();
  try {
    const r = await post('message', { text: 'ciao' });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'question_pending');
    assert.equal(ui.calls.length, 0);
    // body limit: 64 KB for actions (over = 413), 16 KB for rest
    const huge = await h.req({ method: 'POST', path: `/api/chats/${ID}/message`, cookie: await h.pair(), body: { text: 'x'.repeat(70 * 1024) } });
    assert.equal(huge.status, 413);
  } finally {
    await h.stop();
  }
});

test('HTTP message: pending approval blocks send (could cancel command); allowed after decision', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    approvingConversation(h.fx, ID, { at: T0 - 2000, composerStatus: 'aborted' });
    h.fx.chat(ID, { lastUpdatedAt: T0 - 1000, header: { unfinishedRunAt: T0 - 30_000 } });
    h.tick();
    const r = await post('message', { text: 'ciao' });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'approval_pending');
    assert.match(r.json().message, /approval/i);
    assert.equal(ui.calls.length, 0, 'Cursor not touched');

    // approved on Mac: reviewData Done and can message again
    approvingConversation(h.fx, ID, { at: T0 - 2000, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
    h.tick();
    const ok = await post('message', { text: 'ciao' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ui.calls.length, 1);
  } finally {
    await h.stop();
  }
});

test('HTTP message: long non-ASCII text within 64 KB body limit', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    ui.onMessage = () =>
      h.fx.conversation(ID, [
        { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
        { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Fatto.' },
        { id: 'b3', type: 1, createdAt: T0 - 1000, text: 'x' },
      ]);
    const text = '\u00e8'.repeat(LIMITS.messageChars); // 2 bytes per char: ~16 KB, above generic limit
    const r = await post('message', { text });
    assert.equal(r.status, 200, r.text);
    assert.equal(ui.calls[0][1].text.length, LIMITS.messageChars);
  } finally {
    await h.stop();
  }
});

test('nullLogger and service: Actions without window never throws from status check', async () => {
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
// approve / reject a command from phone
// ----------------------------------------------------------------------------------------------------------------

async function setupApproval({ config } = {}) {
  const s = await setup({ withQuestion: false });
  approvingConversation(s.h.fx, ID, { toolCallId: 'tc-ap', at: T0 - 2000, composerStatus: 'aborted' });
  s.h.fx.chat(ID, { lastUpdatedAt: T0 - 1000, header: { hasBlockingPendingActions: true, unfinishedRunAt: T0 - 30_000 } });
  s.h.tick();
  return s;
}

test('HTTP approval: detail shows command to decide; approve clicks Run on correct bubble and DB confirms', async () => {
  const { h, ui, cookie, post } = await setupApproval();
  try {
    const d = (await h.req({ path: `/api/chats/${ID}`, cookie })).json();
    assert.equal(d.approval.supported, true);
    assert.equal(d.approval.key, 'tc-ap');
    assert.equal(d.approval.command, 'echo prova');
    assert.equal(d.approval.action, 'run_command');
    // Cursor records decision: reviewData becomes Done
    ui.onApproval = () => approvingConversation(h.fx, ID, { toolCallId: 'tc-ap', at: T0 - 2000, reviewStatus: 'Done', toolStatus: 'completed', composerStatus: 'aborted' });
    const r = await post('approval', { key: 'tc-ap', decision: 'approve' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { ok: true, verified: true, decision: 'approve' });
    assert.deepEqual(ui.calls.map((c) => [c[0], c[1].composerId, c[1].bubbleId, c[1].decision]), [['approval', ID, 'b2', 'approve']]);
    // logs: decision and outcome only, never command
    assert.equal(h.logLines.join('').includes('echo prova'), false);
    assert.match(h.logLines.join(''), /approval_decision/);
    // repeated same send rejected
    const again = await post('approval', { key: 'tc-ap', decision: 'approve' });
    assert.ok([409].includes(again.status));
  } finally {
    await h.stop();
  }
});

test('HTTP approval: rejects stale key, invalid decision, non-terminal tool and disabled feature (Cursor never touched)', async () => {
  const { h, ui, post } = await setupApproval();
  try {
    assert.equal((await post('approval', { key: 'altra', decision: 'approve' })).json().error, 'stale');
    assert.equal((await post('approval', { key: 'tc-ap', decision: 'forse' })).json().error, 'bad_decision');
    assert.equal((await post('approval', { decision: 'approve' })).json().error, 'bad_key');
    assert.equal(ui.calls.length, 0);

    // not a terminal command: cannot decide from here
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

test('HTTP approval: if Cursor card closes (settled) confirm is immediate even if DB not changed yet', async () => {
  const { h, ui, post } = await setupApproval();
  try {
    ui.onApproval = null;
    ui.approval = async (args) => (ui.calls.push(['approval', args]), { clicked: true, settled: true });
    const t = Date.now();
    const r = await post('approval', { key: 'tc-ap', decision: 'reject' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().verified, true);
    assert.ok(Date.now() - t < 2000, 'no pointless wait');
  } finally {
    await h.stop();
  }
});

test('HTTP approval: command too long to read fully can reject but not approve from here', async () => {
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

test('HTTP stop agent: only when running, correct chat click, verified outcome, no duplicate send', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    // idle chat: no click
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

test('HTTP stop agent: translated Cursor error, no action with debug port closed', async () => {
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

test('HTTP rename: cleaned validated name, correct chat click, outcome from DB, no duplicate send', async () => {
  const { h, ui, post } = await setup({ withQuestion: false });
  try {
    ui.onRename = ({ name }) => h.fx.chat(ID, { name });
    assert.equal((await post('rename', {})).status, 400);
    assert.equal((await post('rename', { name: '   ' })).status, 400);
    assert.equal((await post('rename', { name: 'x'.repeat(101) })).status, 400);
    assert.equal(ui.calls.length, 0, 'no Cursor access with invalid name');

    const r = await post('rename', { name: '  Nuovo\n  nome\u0007 ' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().verified, true);
    assert.deepEqual(ui.calls.map((c) => [c[0], c[1].composerId, c[1].name]), [['rename', ID, 'Nuovo nome']]);
    assert.equal((await post('rename', { name: 'Nuovo nome' })).json().error, 'already_sent');
    assert.equal((await h.req({ method: 'POST', path: '/api/chats/22222222-2222-4222-8222-222222222222/rename', cookie: h.cookie ?? (await h.pair()), body: { name: 'x' } })).status, 404);

    ui.onRename = null; // Cursor does not change name: not confirmed
    const nc = await post('rename', { name: 'Altro' });
    assert.equal(nc.json().verified, false);
    assert.ok(!h.logLines.join('').includes('Nuovo nome'), 'name not in logs');
  } finally {
    await h.stop();
  }
});

test('HTTP pin chat: state from Cursor, boolean required, auth required', async () => {
  const { h, ui, cookie, post } = await setup({ withQuestion: false });
  try {
    const get = await h.req({ path: `/api/chats/${ID}/pin`, cookie });
    assert.equal(get.status, 200, get.text);
    assert.equal(get.json().pinned, false);
    assert.equal((await h.req({ path: `/api/chats/${ID}/pin` })).status, 401);
    assert.equal((await post('pin', {})).status, 400);
    assert.equal((await post('pin', { pinned: 'si' })).status, 400);
    assert.equal(ui.calls.filter((c) => c[0] === 'setPinned').length, 0, 'no action with invalid values');
    const r = await post('pin', { pinned: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().pinned, true);
    assert.deepEqual(ui.calls.find((c) => c[0] === 'setPinned')[1], { composerId: ID, pinned: true });
    assert.equal((await h.req({ path: `/api/chats/${ID}/pin`, cookie })).json().pinned, true);
  } finally {
    await h.stop();
  }
});

test('HTTP archive and restore: not while running; archived list; DB verify', async () => {
  const { h, ui, cookie, post } = await setup({ withQuestion: false });
  try {
    // chat running: no
    h.fx.chat(ID, { name: 'Titolo', lastUpdatedAt: T0 - 500, header: { unfinishedRunAt: T0 - 1000 } });
    h.fx.conversation(ID, [{ id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' }, { id: 'b2', type: 2, createdAt: T0 - 2000, text: '...' }], { status: 'generating' });
    h.tick();
    const busy = await post('archive', {});
    assert.equal(busy.status, 409);
    assert.equal(busy.json().error, 'running');
    assert.equal(ui.calls.length, 0);

    // idle: can archive
    h.fx.chat(ID, { header: { unfinishedRunAt: undefined } });
    h.fx.db.prepare('UPDATE cursorDiskKV SET value = json_set(value, \'$.status\', \'completed\') WHERE key = ?').run(`composerData:${ID}`);
    h.tick();
    ui.onArchive = () => h.fx.chat(ID, { archived: true });
    const r = await post('archive', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().verified, true);
    h.tick();

    // now archived: in list, not in main state
    const list = (await h.req({ path: '/api/archived', cookie })).json().chats;
    assert.deepEqual(list.map((c) => c.id), [ID]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'lastUpdatedAt', 'name', 'sectionId', 'workspaceName']);
    assert.equal((await h.req({ path: '/api/archived' })).status, 401);

    // restore: archived only
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

test('images: content-checked upload, message with attachments, files deleted after send', async () => {
  const { h, ui, cookie, post } = await setup({ withQuestion: false });
  try {
    const up = (body, type = 'image/png') => h.req({ method: 'POST', path: '/api/uploads', cookie, headers: { 'Content-Type': type }, body });
    assert.equal((await h.req({ method: 'POST', path: '/api/uploads', headers: { 'Content-Type': 'image/png' }, body: PNG })).status, 401);
    assert.equal((await up(Buffer.from('non sono un\'immagine'))).status, 415, 'content matters, not declared type');
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

    // fake id / not a list / too many attachments
    assert.equal((await post('message', { text: 'x', images: ['a'.repeat(32)] })).json().error, 'image_expired');
    assert.equal((await post('message', { text: 'x', images: 'no' })).json().error, 'bad_images');
    assert.equal((await post('message', { text: 'x', images: [id, id, id, id, id] })).json().error, 'bad_images');
    assert.equal((await post('message', { images: [] })).json().error, 'bad_text');
    assert.equal(ui.calls.length, 0);

    // image-only (no text) send ok; UI gets file path
    ui.onMessage = () =>
      h.fx.conversation(ID, [
        { id: 'b1', type: 1, createdAt: T0 - 3000, text: 'Fai' },
        { id: 'b2', type: 2, createdAt: T0 - 2000, text: 'Fatto.' },
        { id: 'b3', type: 1, createdAt: T0 - 1000, text: '' },
      ]);
    const r = await post('message', { images: [id] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ui.calls[0][1], { composerId: ID, text: '', files: [path.join(dir, `${id}.png`)] });
    assert.deepEqual(fs.readdirSync(dir), [], 'after send file is gone');
    assert.ok(!h.logLines.join('').includes(id), 'no id or path in logs');
    assert.equal((await post('message', { text: 'x', images: [id] })).json().error, 'image_expired');

    // if send fails file remains (retry) and can delete
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

test('new chat: branch and model options from Cursor, choices validated before touching Cursor', async () => {
  const { h, ui, cookie } = await setup({ withQuestion: false });
  try {
    const sectionId = h.app.watcher.last.chats[0].sectionId;
    const project = h.app.watcher.last.chats[0].workspaceName;
    const opts = await h.req({ path: `/api/projects/${sectionId}/newchat-options`, cookie });
    assert.equal(opts.status, 200, opts.text);
    assert.deepEqual(opts.json().branch, { current: 'main', options: ['main', 'sviluppo'] });
    assert.deepEqual(ui.calls[0], ['newChatOptions', { project }]);
    assert.equal((await h.req({ path: `/api/projects/${sectionId}/newchat-options` })).status, 401);
    assert.equal((await h.req({ path: '/api/projects/sconosciuto/newchat-options', cookie })).status, 404);

    const create = (body) => h.req({ method: 'POST', path: '/api/chats', cookie, body });
    const before = ui.calls.length;
    assert.equal((await create({ sectionId, text: 'x', branch: 5 })).json().error, 'bad_branch');
    assert.equal((await create({ sectionId, text: 'x', model: '' })).json().error, 'bad_model');
    assert.equal((await create({ sectionId, text: 'x', model: 'a'.repeat(200) })).json().error, 'bad_model');
    assert.equal(ui.calls.length, before, 'invalid choices: Cursor not touched');

    ui.onNewChat = () => {
      h.fx.chat(NEW_ID, { name: 'Nuova', lastUpdatedAt: T0 - 100 });
      return { composerId: NEW_ID };
    };
    const r = await create({ sectionId, text: 'ciao', branch: ' sviluppo ', model: 'Composer 2.5' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ui.calls.at(-1)[1], { project, text: 'ciao', branch: 'sviluppo', model: 'Composer 2.5' });
  } finally {
    await h.stop();
  }
});

test('HTTP new chat: project resolved by daemon, checks, attachments, new chat confirmed by DB', async () => {
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
    assert.equal((await create({ sectionId, text: 'Crea  un\nREADME' })).json().error, 'already_sent', 'double tap');
    assert.ok(!h.logLines.join('').includes('README'), 'text not in logs');

    // draft row (isDraft) is not real chat: not verified
    ui.onNewChat = () => {
      h.fx.chat('44444444-4444-4444-8444-444444444444', { name: 'Bozza', header: { isDraft: true } });
      return { composerId: '44444444-4444-4444-8444-444444444444' };
    };
    const dr = await create({ sectionId, text: 'terza' });
    assert.equal(dr.status, 200, dr.text);
    assert.equal(dr.json().verified, false);

    // translated UI errors
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

// ----------------------------------------------------------------------------------------------------------------
// circuit breaker: Cursor's interface changed
// ----------------------------------------------------------------------------------------------------------------

const uiError = (code) => Object.assign(new Error(code), { code });

function breaker({ fail = 'no_composer', config = {}, ui = {} } = {}) {
  const calls = { send: 0 };
  const ctl = { fail, health: { rows: 3, panel: true, composer: true, send: true }, up: true };
  const { a, logs, state } = service({
    config: { uiPauseFailures: 3, uiPauseMs: 0, ...config },
    ui: {
      probe: async () => ({ up: ctl.up }),
      hasWindow: async () => true,
      selfTest: async () => ctl.health,
      async sendMessage() {
        calls.send++;
        if (ctl.fail) throw uiError(ctl.fail);
        state.count++;
      },
      ...ui,
    },
  });
  return { a, ctl, calls, logs };
}

const send = (a, i = 0) => a.sendMessage('c1', { text: `m${i}` });

test('breaker: three "interface changed" failures in a row pause actions, and the phone is told why', async () => {
  const { a, calls } = breaker();
  await a.refresh();
  const seen = [];
  a.on('change', (s) => seen.push(s.reason));
  for (let i = 0; i < 3; i++) await assert.rejects(send(a, i), (e) => e.code === 'ui_changed');
  assert.deepEqual(a.status, { available: false, reason: 'ui_changed' });
  assert.deepEqual(seen, ['ui_changed']);
  await assert.rejects(send(a, 9), (e) => e.status === 503 && e.code === 'actions_paused');
  assert.equal(calls.send, 3, 'while paused nothing is sent to Cursor');
});

test('breaker: a success in between clears the count; other kinds of failure never count', async () => {
  const { a, ctl } = breaker();
  await a.refresh();
  await assert.rejects(send(a, 1));
  await assert.rejects(send(a, 2));
  ctl.fail = null;
  await send(a, 3);
  ctl.fail = 'no_composer';
  await assert.rejects(send(a, 4));
  await assert.rejects(send(a, 5));
  assert.equal(a.status.reason, 'ok', 'two failures after a success: not paused');

  ctl.fail = 'click_failed'; // maps to ui_failed: not an interface change
  for (let i = 0; i < 6; i++) await assert.rejects(send(a, 10 + i), (e) => e.code === 'ui_failed');
  assert.equal(a.status.reason, 'ok');
});

test('breaker: can be turned off (CP_UI_PAUSE_FAILURES=0)', async () => {
  const { a } = breaker({ config: { uiPauseFailures: 0 } });
  await a.refresh();
  for (let i = 0; i < 5; i++) await assert.rejects(send(a, i), (e) => e.code === 'ui_changed');
  assert.equal(a.status.reason, 'ok');
});

test('breaker: stays paused for the minimum time, then resumes only when the page check passes', async () => {
  const { a } = breaker({ config: { uiPauseMs: 60_000 } });
  await a.refresh();
  for (let i = 0; i < 3; i++) await assert.rejects(send(a, i));
  await a.refresh();
  assert.equal(a.status.reason, 'ui_changed', 'too early to look again');

  const { a: b, ctl: ctlB } = breaker();
  await b.refresh();
  for (let i = 0; i < 3; i++) await assert.rejects(send(b, i));
  ctlB.health = { rows: 3, panel: true, composer: false, send: true };
  await b.refresh();
  assert.equal(b.status.reason, 'ui_changed', 'composer missing: still paused');
  ctlB.health = { rows: 0, panel: false, composer: false, send: false };
  await b.refresh();
  assert.equal(b.status.reason, 'ui_changed', 'no sidebar rows: still paused');
  ctlB.health = { rows: 3, panel: false, composer: false, send: false };
  await b.refresh();
  assert.deepEqual(b.status, { available: true, reason: 'ok' }, 'rows found and no chat open: nothing wrong visible');
});

test('breaker: after resuming, ONE more failure pauses again; a success makes it normal', async () => {
  const { a, ctl, calls } = breaker();
  await a.refresh();
  for (let i = 0; i < 3; i++) await assert.rejects(send(a, i));
  await a.refresh();
  assert.equal(a.status.reason, 'ok');
  await assert.rejects(send(a, 4), (e) => e.code === 'ui_changed');
  assert.equal(a.status.reason, 'ui_changed', 'half-open: a single failure is enough');
  assert.equal(calls.send, 4);

  await a.refresh();
  ctl.fail = null;
  await send(a, 5);
  ctl.fail = 'no_composer';
  await assert.rejects(send(a, 6));
  assert.equal(a.status.reason, 'ok', 'after a success the full count applies again');
});

test('breaker: closing Cursor clears the pause (an update is applied by restarting it)', async () => {
  const { a, ctl, logs } = breaker({ config: { uiPauseMs: 60_000 } });
  await a.refresh();
  for (let i = 0; i < 3; i++) await assert.rejects(send(a, i));
  ctl.up = false;
  await a.refresh();
  assert.deepEqual(a.status, { available: false, reason: 'off' });
  ctl.up = true;
  ctl.fail = null;
  await a.refresh();
  assert.deepEqual(a.status, { available: true, reason: 'ok' });
  await send(a, 7);
  assert.ok(logs.some(([, m, f]) => m === 'actions_resumed' && f.reason === 'restart'));
  assert.ok(logs.some(([, m]) => m === 'actions_paused'));
});

// ----------------------------------------------------------------------------------------------------------------
// a slow write must not turn into a double send
// ----------------------------------------------------------------------------------------------------------------

test('message: the page reports "not sent" but Cursor wrote it late: success, not an error, and it does not count against the breaker', async () => {
  const { a, state } = service({
    config: { uiPauseFailures: 2 },
    ui: upUi({
      async sendMessage() {
        state.count++; // the click landed and the database caught up...
        throw uiError('send_failed'); // ...but the page check had already given up
      },
    }),
  });
  await a.refresh();
  for (let i = 0; i < 4; i++) {
    const r = await a.sendMessage('c1', { text: `late ${i}` });
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
  }
  assert.equal(a.status.reason, 'ok', 'real deliveries are never counted as interface failures');
});

test('message: not sent and nothing in the database: error, but the same text is refused for a while (it may still arrive)', async () => {
  const clock = { t: 1_000_000 };
  const { a } = service({
    now: () => clock.t,
    ui: upUi({
      async sendMessage() {
        throw uiError('send_failed');
      },
    }),
  });
  await a.refresh();
  await assert.rejects(a.sendMessage('c1', { text: 'ciao' }), (e) => e.code === 'ui_changed');
  await assert.rejects(a.sendMessage('c1', { text: 'ciao' }), (e) => e.status === 409 && e.code === 'already_sent');
  await a.sendMessage('c2', { text: 'ciao' }).catch((e) => assert.equal(e.code, 'ui_changed')); // another chat is not blocked
  clock.t += 20_000;
  await assert.rejects(a.sendMessage('c1', { text: 'ciao' }), (e) => e.code === 'already_sent', 'still inside the hold');
  clock.t += 20_000;
  await assert.rejects(a.sendMessage('c1', { text: 'ciao' }), (e) => e.code === 'ui_changed', 'after the hold it is tried again');
});

test('message: sent but the database did not confirm: "verified: false" and the same text is refused for 30 s', async () => {
  const clock = { t: 1_000_000 };
  let sent = 0;
  const { a } = service({
    now: () => clock.t,
    ui: upUi({
      async sendMessage() {
        sent++; // goes out, the database never changes
      },
    }),
  });
  await a.refresh();
  const r = await a.sendMessage('c1', { text: 'ciao' });
  assert.equal(r.verified, false);
  clock.t += 10_000;
  await assert.rejects(a.sendMessage('c1', { text: 'ciao' }), (e) => e.code === 'already_sent', 'past the old 8 s window, still held');
  clock.t += 25_000;
  await a.sendMessage('c1', { text: 'ciao' });
  assert.equal(sent, 2);
});

// ----------------------------------------------------------------------------------------------------------------
// a deliberate repeat ("yes", "continue") must not be refused
// ----------------------------------------------------------------------------------------------------------------

test('message: a delivery the database confirmed does not block the same short text sent again', async () => {
  const { a, state } = service({
    ui: upUi({
      async sendMessage() {
        state.count++;
      },
    }),
  });
  await a.refresh();
  assert.equal((await a.sendMessage('c1', { text: 'yes' })).verified, true);
  assert.equal((await a.sendMessage('c1', { text: 'yes' })).verified, true, 'a repeat right away is deliberate');
  assert.equal(state.count, 2);
});

test('message: concurrent double tap is still refused, even with force', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { a, state } = service({
    ui: upUi({
      async sendMessage() {
        await gate;
        state.count++;
      },
    }),
  });
  await a.refresh();
  const first = a.sendMessage('c1', { text: 'yes' });
  await assert.rejects(a.sendMessage('c1', { text: 'yes' }), (e) => e.code === 'already_sent');
  await assert.rejects(a.sendMessage('c1', { text: 'yes', force: true }), (e) => e.code === 'already_sent', 'force does not skip the in-flight guard');
  release();
  await first;
});

test('message: force skips the hold of an uncertain delivery, and only that one', async () => {
  const clock = { t: 1_000_000 };
  let sent = 0;
  const { a } = service({
    now: () => clock.t,
    ui: upUi({
      async sendMessage() {
        sent++; // goes out, the database never changes
      },
    }),
  });
  await a.refresh();
  assert.equal((await a.sendMessage('c1', { text: 'yes' })).verified, false);
  await assert.rejects(a.sendMessage('c1', { text: 'yes' }), (e) => e.code === 'already_sent');
  assert.equal((await a.sendMessage('c1', { text: 'yes', force: true })).verified, false, 'send anyway');
  assert.equal(sent, 2);
  await assert.rejects(a.sendMessage('c1', { text: 'yes' }), (e) => e.code === 'already_sent', 'the new send is held again');
});
