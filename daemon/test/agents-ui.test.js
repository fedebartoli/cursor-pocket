// Tests agents-ui.js on a real DOM: headless Chromium (when available) with fake page `mock-agents-page.html`, mimicking
// the questionnaire and composer of Cursor's Agents Window. Without Chromium, tests are skipped.
// What it proves: selection logic (second click deselects), advancing, freeform field, sending a message,
// and restoring the previously open chat. What it does NOT prove: selectors match Cursor's (see FINDINGS sec. 10).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentsUi, FREEFORM_ID, UiError, currentQuestionIndex, promptMatches } from '../src/cursor/agents-ui.js';
import { normalizeQuestionParams } from '../src/cursor/questions.js';
import { findChromium, launchChromium } from './helpers/chromium.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(here, 'helpers', 'mock-agents-page.html');
const skip = findChromium() ? false : 'Chromium not available';

const RAW_Q1 = {
  id: 'q1',
  prompt: 'Quale database vuoi usare per il progetto?',
  options: [
    { id: 'a', label: 'PostgreSQL' },
    { id: 'b', label: 'SQLite' },
    { id: 'c', label: 'MySQL' },
    { id: 'x', label: 'Other' }, // Cursor does not show it: it always has its own "Other..." entry
  ],
};
const RAW_Q2 = {
  id: 'q2',
  prompt: 'Quali funzioni vuoi attivare?',
  allowMultiple: true,
  options: [
    { id: 'a', label: 'Cache' },
    { id: 'b', label: 'Log strutturati' },
    { id: 'c', label: 'Metriche' },
  ],
};
const norm = (raw) => normalizeQuestionParams({ questions: raw });

describe('promptMatches / currentQuestionIndex (no browser)', () => {
  it('recognizes the prompt when Markdown and punctuation differ', () => {
    assert.equal(promptMatches('Domanda: Quale **database** vuoi usare? PostgreSQL SQLite Skip', 'Quale `database` vuoi usare per il progetto?'), true);
    assert.equal(promptMatches('Tutt\'altro testo sulle funzioni', 'Quale database vuoi usare per il progetto?'), false);
    assert.equal(promptMatches('qualsiasi', ''), false);
  });
  it('picks the question on screen among multiple questions', () => {
    const qs = norm([RAW_Q1, RAW_Q2]).questions;
    assert.equal(currentQuestionIndex({ text: 'Quale database vuoi usare per il progetto? PostgreSQL SQLite MySQL Other... Continue Skip' }, qs), 0);
    assert.equal(currentQuestionIndex({ text: 'Quali funzioni vuoi attivare? Cache Log strutturati Metriche Other... Next Skip' }, qs), 1);
    assert.equal(currentQuestionIndex({ text: 'niente a che vedere' }, qs), -1);
  });
});

describe('AgentsUi on Chromium with the fake page', { skip }, () => {
  let browser;
  let ui;
  before(async () => {
    browser = await launchChromium(HTML);
    ui = new AgentsUi({ port: browser.port, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 40))) });
  });
  after(async () => {
    await browser?.close();
  });

  const reset = (cfg) => browser.evalPage(`window.__mock.reset(${JSON.stringify(cfg)})`);
  const state = async () => JSON.parse(await browser.evalPage('window.__mock.state()'));
  const withQ = (questions) => ({
    current: 'chat-b',
    chats: { 'chat-a': { name: 'Chat A', questions }, 'chat-b': { name: 'Chat B' }, 'chat-c': { name: 'Chat C' } },
  });

  it('inspect: counts key elements and does not return text content', async () => {
    await reset({ ...withQ([RAW_Q1]), current: 'chat-a' });
    const r = await ui.inspect();
    assert.equal(r.up, true);
    assert.match(r.targets[0].title, /Agents/);
    assert.deepEqual(r.page.counts, { tray: 1, options: 3, freeform: 1, primary: 1, secondary: 1, rows: 3, composers: 2, send: 2 }); // +1 composer/button: hidden panel (decoy)
    assert.equal(r.page.selectedKey, 'row:chat-a');
    assert.ok(!JSON.stringify(r).includes('PostgreSQL'), 'diagnostics must not contain chat text');
  });

  it('selfTest: reports which elements exist, as counts only', async () => {
    await reset({ ...withQ([RAW_Q1]), current: 'chat-a' });
    const t = await ui.selfTest();
    assert.equal(t.rows, 3);
    assert.equal(t.panel, 1);
    assert.equal(t.composer, 1);
    assert.equal(t.send, 1);
    assert.ok(Object.values(t).every((v) => typeof v === 'number'), 'counts only: no text from the page');
  });

  it('readTray: options (without "Other"), selection, primary button disabled until answered', async () => {
    await reset({ ...withQ([RAW_Q1]), current: 'chat-a', initialSelections: { 'chat-a': {} } });
    const v = await ui.readTray();
    assert.deepEqual(v.options.map((o) => [o.badge, o.label, o.selected]), [['A', 'PostgreSQL', false], ['B', 'SQLite', false], ['C', 'MySQL', false]]);
    assert.equal(v.freeform.present, true);
    assert.equal(v.freeform.editorVisible, false);
    assert.deepEqual(v.primary, { label: 'Continue', disabled: true });
    assert.equal(v.secondary.label, 'Skip');
  });

  it('answer: single choice, then Continue; previously open chat is restored', async () => {
    await reset(withQ([RAW_Q1]));
    const question = norm([RAW_Q1]);
    const r = await ui.answer({ composerId: 'chat-a', question, answers: [{ optionIds: ['b'] }] });
    assert.deepEqual(r, { submitted: true });
    const s = await state();
    assert.deepEqual(s.submitted.map((x) => [x.chat, x.selections]), [['chat-a', { q1: ['b'] }]]);
    assert.deepEqual(s.log.filter((l) => l.startsWith('pick') || l.startsWith('primary')), ['pick:q1:b', 'primary:submit']);
    assert.equal(s.current, 'chat-b', 'after the action the chat that was open before is reopened');
  });

  it('answer: an already selected option is NOT clicked (would deselect it)', async () => {
    await reset({ ...withQ([RAW_Q1]), initialSelections: { 'chat-a': { q1: ['b'] } } });
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1]), answers: [{ optionIds: ['b'] }] });
    const s = await state();
    assert.equal(s.clicks, 0);
    assert.deepEqual(s.submitted[0].selections, { q1: ['b'] });
  });

  it('answer: single choice with different draft -> replaces selection', async () => {
    await reset({ ...withQ([RAW_Q1]), initialSelections: { 'chat-a': { q1: ['a'] } } });
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1]), answers: [{ optionIds: ['c'] }] });
    assert.deepEqual((await state()).submitted[0].selections, { q1: ['c'] });
  });

  it('answer: two questions (single with auto-advance, then multiple)', async () => {
    await reset(withQ([RAW_Q1, RAW_Q2]));
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1, RAW_Q2]), answers: [{ optionIds: ['c'] }, { optionIds: ['a', 'c'] }] });
    const s = await state();
    assert.deepEqual(s.submitted[0].selections, { q1: ['c'], q2: ['a', 'c'] });
    assert.deepEqual(
      s.log.filter((l) => l.startsWith('pick') || l.startsWith('primary')),
      ['pick:q1:c', 'pick:q2:a', 'pick:q2:c', 'primary:submit'],
    );
  });

  it('answer: multiple choice with draft -> removes what is not needed and adds the rest', async () => {
    await reset({ ...withQ([RAW_Q2]), initialSelections: { 'chat-a': { q2: ['b'] } } });
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q2]), answers: [{ optionIds: ['a', 'c'] }] });
    assert.deepEqual((await state()).submitted[0].selections.q2.sort(), ['a', 'c']);
  });

  it('answer: freeform (with newlines) in single choice, clearing an already selected draft', async () => {
    await reset({ ...withQ([RAW_Q1]), initialSelections: { 'chat-a': { q1: ['a'] } } });
    const text = 'prima riga\nseconda riga';
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1]), answers: [{ optionIds: [FREEFORM_ID], freeform: text }] });
    const s = await state();
    assert.deepEqual(s.submitted[0].selections, { q1: [FREEFORM_ID] });
    assert.equal(s.submitted[0].freeform.q1, text);
  });

  it('answer: wrong question is left alone (mismatch)', async () => {
    await reset(withQ([RAW_Q1]));
    const other = norm([{ id: 'q9', prompt: 'Completamente un\'altra domanda sul deploy in produzione?', options: [{ id: 'z', label: 'Mai' }] }]);
    await assert.rejects(ui.answer({ composerId: 'chat-a', question: other, answers: [{ optionIds: ['z'] }] }), (e) => e instanceof UiError && e.code === 'mismatch');
    const s = await state();
    assert.equal(s.clicks, 0);
    assert.deepEqual(s.submitted, []);
    assert.equal(s.current, 'chat-b', 'even after an error the open chat is restored');
  });

  it('answer: missing chat -> row_not_found; chat without questionnaire -> no_tray', async () => {
    await reset(withQ([RAW_Q1]));
    await assert.rejects(ui.answer({ composerId: 'chat-zzz', question: norm([RAW_Q1]), answers: [{ optionIds: ['a'] }] }), (e) => e.code === 'row_not_found');
    await assert.rejects(ui.answer({ composerId: 'chat-c', question: norm([RAW_Q1]), answers: [{ optionIds: ['a'] }] }), (e) => e.code === 'no_tray');
  });

  it('skip: presses "Skip" and the questionnaire disappears', async () => {
    await reset(withQ([RAW_Q1]));
    assert.deepEqual(await ui.skip({ composerId: 'chat-a', question: norm([RAW_Q1]) }), { skipped: true });
    const s = await state();
    assert.deepEqual(s.skipped, ['chat-a']);
    assert.deepEqual(s.submitted, []);
  });

  it('sendMessage: types (newline with Shift+Enter), sends, field clears and previous chat is reopened', async () => {
    await reset(withQ([RAW_Q1]));
    const text = 'Ciao, controlla i test.\nPoi fai il commit.';
    assert.deepEqual(await ui.sendMessage({ composerId: 'chat-c', text }), { sent: true });
    const s = await state();
    assert.deepEqual(s.sent, [{ chat: 'chat-c', text }]);
    assert.equal(s.current, 'chat-b');
  });

  it('sendMessage with images: attach, type, send; images-only still sends; previews disappear', async () => {
    const f = path.join(os.tmpdir(), `cp-test-${process.pid}.png`);
    fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    try {
      await reset(withQ([RAW_Q1]));
      await ui.sendMessage({ composerId: 'chat-c', text: 'guarda', files: [f, f] });
      await ui.sendMessage({ composerId: 'chat-c', text: '', files: [f] });
      const s = await state();
      assert.deepEqual(s.sent, [{ chat: 'chat-c', text: 'guarda', images: 2 }, { chat: 'chat-c', text: '', images: 1 }]);
      assert.equal(await browser.evalPage(`document.querySelectorAll('.ui-prompt-input-image-preview').length`), 0);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('sendMessage with images: if Cursor does not show them, error and no send; does not mix with image draft', async () => {
    const f = path.join(os.tmpdir(), `cp-test2-${process.pid}.png`);
    fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    try {
      await reset({ ...withQ([RAW_Q1]), noPreview: true });
      await assert.rejects(ui.sendMessage({ composerId: 'chat-c', text: 'x', files: [f] }), (e) => e.code === 'attach_failed');
      assert.deepEqual((await state()).sent, []);
      await reset(withQ([RAW_Q1]));
      await browser.evalPage(`(() => { const b = document.createElement('div'); b.className = 'ui-prompt-input-image-preview'; b.innerHTML = '<img alt="x">'; document.querySelector('#previews').append(b); 0; })()`);
      await assert.rejects(ui.sendMessage({ composerId: 'chat-c', text: 'x' }), (e) => e.code === 'draft_not_empty');
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('attachImages: attach and remove all without sending', async () => {
    const f = path.join(os.tmpdir(), `cp-test3-${process.pid}.png`);
    fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    try {
      await reset(withQ([RAW_Q1]));
      assert.deepEqual(await ui.attachImages({ composerId: 'chat-c', files: [f, f, f] }), { attached: 3, left: 0 });
      assert.deepEqual((await state()).sent, []);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('sendMessage: does not mix message with user draft', async () => {
    await reset({ ...withQ([RAW_Q1]), draft: 'bozza scritta sul Mac' });
    await assert.rejects(ui.sendMessage({ composerId: 'chat-c', text: 'x' }), (e) => e.code === 'draft_not_empty');
    assert.deepEqual((await state()).sent, []);
  });

  it('sendMessage: a failed send leaves no draft behind, so the next attempt works', async () => {
    await reset({ ...withQ([RAW_Q1]), sendDisabled: true });
    await assert.rejects(ui.sendMessage({ composerId: 'chat-c', text: 'messaggio da telefono' }), (e) => e.code === 'send_disabled');
    let s = await state();
    assert.equal(s.draft.trim(), '', 'the text typed by the daemon was removed');
    assert.deepEqual(s.sent, []);
    await reset(withQ([RAW_Q1]));
    assert.deepEqual(await ui.sendMessage({ composerId: 'chat-c', text: 'secondo tentativo' }), { sent: true });
    s = await state();
    assert.deepEqual(s.sent, [{ chat: 'chat-c', text: 'secondo tentativo' }]);
  });

  it('sendMessage: a leftover draft equal to the message (or to what the daemon typed) is cleared; others are never touched', async () => {
    await reset({ ...withQ([RAW_Q1]), draft: 'stesso testo' });
    assert.deepEqual(await ui.sendMessage({ composerId: 'chat-c', text: 'stesso testo' }), { sent: true });
    assert.deepEqual((await state()).sent, [{ chat: 'chat-c', text: 'stesso testo' }]);
    await reset({ ...withQ([RAW_Q1]), draft: 'bozza vera scritta a mano' });
    await assert.rejects(ui.sendMessage({ composerId: 'chat-c', text: 'altro testo' }), (e) => e.code === 'draft_not_empty');
    assert.equal((await state()).draft, 'bozza vera scritta a mano');
  });

  it('sendMessage: if Cursor does not switch to the chat, nothing is typed (chat_not_open)', async () => {
    await reset({ ...withQ([RAW_Q1]), stuckOpen: true });
    await assert.rejects(ui.sendMessage({ composerId: 'chat-c', text: 'x' }), (e) => e.code === 'chat_not_open');
    const s = await state();
    assert.deepEqual(s.sent, []);
    assert.equal(s.draft.trim(), '');
  });

  it('hidden sidebar: it is shown for the action and hidden again afterwards', async () => {
    await reset({ ...withQ([RAW_Q1]), sidebarHidden: true });
    assert.deepEqual(await ui.sendMessage({ composerId: 'chat-c', text: 'con barra chiusa' }), { sent: true });
    const s = await state();
    assert.deepEqual(s.sent, [{ chat: 'chat-c', text: 'con barra chiusa' }]);
    assert.deepEqual(s.log.filter((l) => l.startsWith('sidebar:')), ['sidebar:show', 'sidebar:hide']);
    assert.equal(s.sidebarHidden, true);
    assert.equal(s.current, 'chat-b', 'previous chat restored too');
  });

  it('visible sidebar: it is not touched', async () => {
    await reset(withQ([RAW_Q1]));
    await ui.sendMessage({ composerId: 'chat-c', text: 'ciao' });
    assert.deepEqual((await state()).log.filter((l) => l.startsWith('sidebar:')), []);
  });

  it('sendMessage: with pending question does not write (question_pending)', async () => {
    await reset(withQ([RAW_Q1]));
    await assert.rejects(ui.sendMessage({ composerId: 'chat-a', text: 'x' }), (e) => e.code === 'question_pending');
    assert.deepEqual((await state()).sent, []);
  });

  describe('command approval', () => {
    const cfg = (extra = {}) => ({
      current: 'chat-b',
      chats: {
        'chat-a': { name: 'Chat A', approvals: [{ messageId: 'm-1', command: 'echo uno' }, { messageId: 'm-2', command: 'echo due' }], ...extra },
        'chat-b': { name: 'Chat B' },
      },
    });

    it('"approve" presses Run on the indicated bubble card (not another) and reopens the previous chat', async () => {
      await reset(cfg());
      const r = await ui.approval({ composerId: 'chat-a', bubbleId: 'm-2', decision: 'approve' });
      assert.equal(r.clicked, true);
      assert.equal(r.settled, true);
      const st = await state();
      assert.deepEqual(st.decided, { 'm-2': 'approve' });
      assert.equal(st.current, 'chat-b', 'the chat the user had open is restored');
    });

    it('"reject" presses Skip', async () => {
      await reset(cfg());
      await ui.approval({ composerId: 'chat-a', bubbleId: 'm-1', decision: 'reject' });
      assert.deepEqual((await state()).decided, { 'm-1': 'reject' });
    });

    it('without that bubble card: error and no click', async () => {
      await reset(cfg());
      await assert.rejects(() => ui.approval({ composerId: 'chat-a', bubbleId: 'm-9', decision: 'approve' }), (e) => e instanceof UiError && e.code === 'no_approval');
      assert.deepEqual((await state()).decided, {});
    });

    it('with buttons other than Run/Skip does not press anything', async () => {
      await reset(cfg({ approvals: [{ messageId: 'm-1', command: 'x', order: [['Altro', 'approve'], ['Boh', 'reject']] }] }));
      await assert.rejects(() => ui.approval({ composerId: 'chat-a', bubbleId: 'm-1', decision: 'approve' }), (e) => e instanceof UiError && e.code === 'no_approval');
      assert.deepEqual((await state()).decided, {});
    });

    it('invalid decision: no access to Cursor', async () => {
      await assert.rejects(() => ui.approval({ composerId: 'chat-a', bubbleId: 'm-1', decision: 'boh' }), (e) => e.code === 'bad_decision');
    });
  });

  describe('stop agent', () => {
    const cfg = (running = true) => ({ current: 'chat-b', chats: { 'chat-a': { name: 'Chat A', running }, 'chat-b': { name: 'Chat B', running: true } } });

    it('presses "Stop generation" in the indicated chat (not the hidden panel), then reopens the previous chat', async () => {
      await reset(cfg());
      const r = await ui.stop({ composerId: 'chat-a' });
      assert.deepEqual(r, { clicked: true, settled: true });
      const st = await state();
      assert.deepEqual(st.stopped, ['chat-a']);
      assert.equal(st.current, 'chat-b');
    });

    it('when chat is not working: not_running and no click', async () => {
      await reset(cfg(false));
      await assert.rejects(() => ui.stop({ composerId: 'chat-a' }), (e) => e instanceof UiError && e.code === 'not_running');
      assert.deepEqual((await state()).stopped, []);
    });
  });

  describe('row menu: rename, archive, unarchive', () => {
    const cfg = () => ({ current: 'chat-b', chats: { 'chat-a': { name: 'Chat A' }, 'chat-b': { name: 'Chat B' }, 'chat-z': { name: 'Chat Z', archived: true } } });

    it('rename: right-click, "Rename", text replaces selection, Enter; does not change open chat', async () => {
      await reset(cfg());
      const r = await ui.rename({ composerId: 'chat-a', name: 'Nome nuovo' });
      assert.equal(r.clicked, true);
      const st = await state();
      assert.deepEqual(st.renamed, [{ id: 'chat-a', name: 'Nome nuovo' }]);
      assert.equal(st.renaming, null);
      assert.equal(st.current, 'chat-b');
    });

    it('rename: chat not in sidebar -> row_not_found; empty name -> bad_name', async () => {
      await reset(cfg());
      await assert.rejects(() => ui.rename({ composerId: 'chat-x', name: 'x' }), (e) => e.code === 'row_not_found');
      await assert.rejects(() => ui.rename({ composerId: 'chat-a', name: '  ' }), (e) => e.code === 'bad_name');
      assert.deepEqual((await state()).renamed, []);
    });

    it('archive: row menu "Archive" item', async () => {
      await reset(cfg());
      await ui.archive({ composerId: 'chat-a' });
      assert.deepEqual((await state()).archived, ['chat-a']);
    });

    it('unarchive: enables "Archived" filter, uses "Unarchive" and RESTORES filter as before', async () => {
      await reset(cfg());
      const r = await ui.unarchive({ composerId: 'chat-z' });
      assert.equal(r.clicked, true);
      const st = await state();
      assert.deepEqual(st.unarchived, ['chat-z']);
      assert.equal(st.showArchived, false, 'archived filter is turned off again');
    });

    it('unarchive with filter already on: leaves it on', async () => {
      await reset(cfg());
      await browser.evalPage(`document.querySelector('#customize').click(); document.querySelector('[role="menuitemcheckbox"]').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 0`);
      await ui.unarchive({ composerId: 'chat-z' });
      assert.equal((await state()).showArchived, true);
    });

    it('unarchive missing chat: row_not_found and filter restored', async () => {
      await reset(cfg());
      await assert.rejects(() => ui.unarchive({ composerId: 'chat-nope' }), (e) => e.code === 'row_not_found');
      assert.equal((await state()).showArchived, false);
    });
  });

  describe('pin chat (Pin)', () => {
    const cfg = (extra = {}) => ({ current: 'chat-b', projects: ['Progetto A'], chats: { 'chat-a': { name: 'Chat A' }, 'chat-b': { name: 'Chat B', pinned: true } }, ...extra });

    it('reads whether chat is pinned (before project headers)', async () => {
      await reset(cfg());
      assert.deepEqual(await ui.pinState({ composerId: 'chat-a' }), { pinned: false });
      assert.deepEqual(await ui.pinState({ composerId: 'chat-b' }), { pinned: true });
      await assert.rejects(() => ui.pinState({ composerId: 'chat-nope' }), (e) => e.code === 'row_not_found');
    });

    it('pin and unpin via the correct menu item, and no-op when already in that state', async () => {
      await reset(cfg());
      assert.deepEqual(await ui.setPinned({ composerId: 'chat-a', pinned: true }), { pinned: true, changed: true });
      assert.deepEqual(await ui.pinState({ composerId: 'chat-a' }), { pinned: true });
      assert.deepEqual(await ui.setPinned({ composerId: 'chat-a', pinned: true }), { pinned: true, changed: false });
      assert.deepEqual(await ui.setPinned({ composerId: 'chat-b', pinned: false }), { pinned: false, changed: true });
      assert.deepEqual((await state()).pins, [{ id: 'chat-a', pinned: true }, { id: 'chat-b', pinned: false }]);
    });

    it('rejects non-boolean value', async () => {
      await reset(cfg());
      await assert.rejects(() => ui.setPinned({ composerId: 'chat-a', pinned: 'si' }), (e) => e.code === 'bad_pin');
    });
  });

  describe('new chat on a project', () => {
    const cfg = (extra = {}) => ({ current: 'chat-b', projects: ['Progetto A', 'Progetto B'], chats: { 'chat-a': { name: 'Chat A' }, 'chat-b': { name: 'Chat B' } }, ...extra });

    it('opens the right project "New Agent", checks project and environment, types, sends and returns new chat id', async () => {
      await reset(cfg());
      const r = await ui.newChat({ project: 'Progetto B', text: 'Crea un README\ncon le istruzioni' });
      assert.deepEqual(r, { composerId: 'new-1' });
      const s = await state();
      assert.deepEqual(s.newChats, [{ id: 'new-1', project: 'Progetto B', text: 'Crea un README\ncon le istruzioni', images: 0 }]);
      assert.deepEqual(s.sent, []);
      assert.equal(s.current, 'chat-b', 'the chat that was open stays open');
    });

    it('with images only (no text) still creates the chat', async () => {
      const f = path.join(os.tmpdir(), `cp-test4-${process.pid}.png`);
      fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      try {
        await reset(cfg());
        await ui.newChat({ project: 'Progetto A', text: '', files: [f, f] });
        assert.deepEqual((await state()).newChats.map((c) => [c.project, c.text, c.images]), [['Progetto A', '', 2]]);
      } finally {
        fs.rmSync(f, { force: true });
      }
    });

    it('rejects without sending: missing project, duplicate name, non-local environment', async () => {
      await reset(cfg());
      await assert.rejects(ui.newChat({ project: 'Inesistente', text: 'x' }), (e) => e.code === 'project_not_found');
      await reset(cfg({ projects: ['Progetto A', 'Progetto A'] }));
      await assert.rejects(ui.newChat({ project: 'Progetto A', text: 'x' }), (e) => e.code === 'project_ambiguous');
      await reset(cfg({ env: 'New Worktree' }));
      await assert.rejects(ui.newChat({ project: 'Progetto A', text: 'x' }), (e) => e.code === 'not_local');
      const after = await state();
      assert.deepEqual(after.newChats, []);
      assert.equal(after.current, 'chat-b', 'after an error the previously open chat is restored (not stuck on new-chat screen)');
    });

    it('newChatOptions reads branch and model without choosing and reopens previous chat', async () => {
      await reset(cfg({ branches: ['main', 'sviluppo'], branch: 'main', models: ['Auto', 'Composer 2.5', 'Claude Sonnet 5.5 High', 'Claude Opus 4.6 High'], model: 'Claude Sonnet 5.5 High' }));
      const r = await ui.newChatOptions({ project: 'Progetto A' });
      assert.deepEqual(r, { branch: { current: 'main', options: ['main', 'sviluppo'] }, model: { current: 'Claude Sonnet 5.5 High', options: ['Auto', 'Composer 2.5', 'Claude Sonnet 5.5 High', 'Claude Opus 4.6 High'] } });
      const s = await state();
      assert.deepEqual(s.picks, [], 'no choices made');
      assert.equal(s.current, 'chat-b', 'previous chat is reopened');
    });

    it('newChat with branch and model: picks them before typing and passes them to created chat; no-op when already set', async () => {
      await reset(cfg({ branches: ['main', 'sviluppo'], branch: 'main' }));
      const r = await ui.newChat({ project: 'Progetto B', text: 'ciao', branch: 'sviluppo', model: 'Claude Opus 4.6 High' });
      assert.equal(r.composerId, 'new-1');
      const s = await state();
      // choices for new chat, then Cursor defaults restored (Cursor remembers last choice)
      assert.deepEqual(s.picks, [{ branch: 'sviluppo' }, { model: 'Claude Opus 4.6 High' }, { branch: 'main' }, { model: 'Claude Sonnet 5.5 High' }]);
      assert.deepEqual(s.choices, [{ branch: 'sviluppo', model: 'Claude Opus 4.6 High' }], 'chat starts with chosen branch/model');
      assert.deepEqual([s.branch, s.model], ['main', 'Claude Sonnet 5.5 High'], 'previous defaults restored');
      assert.equal(s.current, 'chat-b');
      await reset(cfg({ branches: ['main', 'sviluppo'], branch: 'main' }));
      await ui.newChat({ project: 'Progetto B', text: 'ciao', branch: 'main', model: 'Claude Sonnet 5.5 High' });
      assert.deepEqual((await state()).picks, [], 'already set: no clicks');
    });

    it('missing branch or model: error, no send, previous chat reopened', async () => {
      await reset(cfg({ branches: ['main'] }));
      await assert.rejects(ui.newChat({ project: 'Progetto B', text: 'x', branch: 'non-esiste' }), (e) => e.code === 'branch_not_found');
      await assert.rejects(ui.newChat({ project: 'Progetto B', text: 'x', model: 'Modello Inventato' }), (e) => e.code === 'model_not_found');
      const s = await state();
      assert.deepEqual(s.newChats, []);
      assert.deepEqual(s.picks, []);
      assert.equal(s.current, 'chat-b');
    });

    it('error after choosing branch and model: defaults restored and nothing sent', async () => {
      await reset(cfg({ branches: ['main', 'sviluppo'], branch: 'main' }));
      await assert.rejects(ui.newChat({ project: 'Progetto B', text: '', branch: 'sviluppo', model: 'Composer 2.5' }), (e) => e.code === 'send_disabled');
      const s = await state();
      assert.deepEqual(s.newChats, []);
      assert.deepEqual([s.branch, s.model], ['main', 'Claude Sonnet 5.5 High']);
      assert.equal(s.current, 'chat-b');
    });

    it('dryRun with choices: applies and reports them without sending', async () => {
      await reset(cfg({ branches: ['main', 'sviluppo'], branch: 'main' }));
      const r = await ui.newChat({ project: 'Progetto A', text: 'x', dryRun: true, branch: 'sviluppo', model: 'Composer 2.5' });
      assert.deepEqual(r.chosen, { branch: 'sviluppo', model: 'Composer 2.5' });
      const s = await state();
      assert.deepEqual(s.newChats, []);
      assert.deepEqual([s.branch, s.model], ['main', 'Claude Sonnet 5.5 High'], 'defaults restored in dry run too');
    });

    it('dryRun: reaches controls and does not send', async () => {
      await reset(cfg());
      const r = await ui.newChat({ project: 'Progetto A', text: 'x', dryRun: true });
      assert.equal(r.dryRun, true);
      assert.deepEqual((await state()).newChats, []);
    });
  });
});
