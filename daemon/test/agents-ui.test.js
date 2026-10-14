// Prova agents-ui.js su un DOM vero: Chromium headless (se presente) con la pagina finta `mock-agents-page.html`, che imita
// il questionario e il composer dell'Agents Window di Cursor. Senza Chromium i test vengono saltati.
// Cosa dimostra: la logica di selezione (un secondo clic deseleziona), l'avanzamento, il campo libero, l'invio del messaggio
// e il ripristino della chat aperta. Cosa NON dimostra: che i selettori coincidano con quelli di Cursor (vedi FINDINGS sez. 10).
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
const skip = findChromium() ? false : 'Chromium non disponibile';

const RAW_Q1 = {
  id: 'q1',
  prompt: 'Quale database vuoi usare per il progetto?',
  options: [
    { id: 'a', label: 'PostgreSQL' },
    { id: 'b', label: 'SQLite' },
    { id: 'c', label: 'MySQL' },
    { id: 'x', label: 'Other' }, // Cursor non la mostra: c'e' sempre la sua voce "Other..."
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

describe('promptMatches / currentQuestionIndex (senza browser)', () => {
  it('riconosce il prompt anche se Markdown e punteggiatura differiscono', () => {
    assert.equal(promptMatches('Domanda: Quale **database** vuoi usare? PostgreSQL SQLite Skip', 'Quale `database` vuoi usare per il progetto?'), true);
    assert.equal(promptMatches('Tutt\'altro testo sulle funzioni', 'Quale database vuoi usare per il progetto?'), false);
    assert.equal(promptMatches('qualsiasi', ''), false);
  });
  it('sceglie la domanda mostrata tra piu\' domande', () => {
    const qs = norm([RAW_Q1, RAW_Q2]).questions;
    assert.equal(currentQuestionIndex({ text: 'Quale database vuoi usare per il progetto? PostgreSQL SQLite MySQL Other... Continue Skip' }, qs), 0);
    assert.equal(currentQuestionIndex({ text: 'Quali funzioni vuoi attivare? Cache Log strutturati Metriche Other... Next Skip' }, qs), 1);
    assert.equal(currentQuestionIndex({ text: 'niente a che vedere' }, qs), -1);
  });
});

describe('AgentsUi su Chromium con la pagina finta', { skip }, () => {
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

  it('inspect: conta gli elementi chiave e non restituisce testi', async () => {
    await reset({ ...withQ([RAW_Q1]), current: 'chat-a' });
    const r = await ui.inspect();
    assert.equal(r.up, true);
    assert.match(r.targets[0].title, /Agents/);
    assert.deepEqual(r.page.counts, { tray: 1, options: 3, freeform: 1, primary: 1, secondary: 1, rows: 3, composers: 2, send: 2 }); // +1 composer/pulsante: pannello nascosto (decoy)
    assert.equal(r.page.selectedKey, 'row:chat-a');
    assert.ok(!JSON.stringify(r).includes('PostgreSQL'), 'la diagnostica non deve contenere i testi della chat');
  });

  it('readTray: opzioni (senza "Other"), selezione, pulsante primario disattivo finche\' non si risponde', async () => {
    await reset({ ...withQ([RAW_Q1]), current: 'chat-a', initialSelections: { 'chat-a': {} } });
    const v = await ui.readTray();
    assert.deepEqual(v.options.map((o) => [o.badge, o.label, o.selected]), [['A', 'PostgreSQL', false], ['B', 'SQLite', false], ['C', 'MySQL', false]]);
    assert.equal(v.freeform.present, true);
    assert.equal(v.freeform.editorVisible, false);
    assert.deepEqual(v.primary, { label: 'Continue', disabled: true });
    assert.equal(v.secondary.label, 'Skip');
  });

  it('answer: scelta singola, poi Continue; la chat aperta torna quella di prima', async () => {
    await reset(withQ([RAW_Q1]));
    const question = norm([RAW_Q1]);
    const r = await ui.answer({ composerId: 'chat-a', question, answers: [{ optionIds: ['b'] }] });
    assert.deepEqual(r, { submitted: true });
    const s = await state();
    assert.deepEqual(s.submitted.map((x) => [x.chat, x.selections]), [['chat-a', { q1: ['b'] }]]);
    assert.deepEqual(s.log.filter((l) => l.startsWith('pick') || l.startsWith('primary')), ['pick:q1:b', 'primary:submit']);
    assert.equal(s.current, 'chat-b', 'dopo l\'azione si riapre la chat che era aperta prima');
  });

  it('answer: un\'opzione gia\' selezionata NON si clicca (la deselezionerebbe)', async () => {
    await reset({ ...withQ([RAW_Q1]), initialSelections: { 'chat-a': { q1: ['b'] } } });
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1]), answers: [{ optionIds: ['b'] }] });
    const s = await state();
    assert.equal(s.clicks, 0);
    assert.deepEqual(s.submitted[0].selections, { q1: ['b'] });
  });

  it('answer: scelta singola con bozza diversa -> sostituisce la selezione', async () => {
    await reset({ ...withQ([RAW_Q1]), initialSelections: { 'chat-a': { q1: ['a'] } } });
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1]), answers: [{ optionIds: ['c'] }] });
    assert.deepEqual((await state()).submitted[0].selections, { q1: ['c'] });
  });

  it('answer: due domande (singola con avanzamento automatico, poi multipla)', async () => {
    await reset(withQ([RAW_Q1, RAW_Q2]));
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1, RAW_Q2]), answers: [{ optionIds: ['c'] }, { optionIds: ['a', 'c'] }] });
    const s = await state();
    assert.deepEqual(s.submitted[0].selections, { q1: ['c'], q2: ['a', 'c'] });
    assert.deepEqual(
      s.log.filter((l) => l.startsWith('pick') || l.startsWith('primary')),
      ['pick:q1:c', 'pick:q2:a', 'pick:q2:c', 'primary:submit'],
    );
  });

  it('answer: scelta multipla con bozza -> si toglie cio\' che non serve e si aggiunge il resto', async () => {
    await reset({ ...withQ([RAW_Q2]), initialSelections: { 'chat-a': { q2: ['b'] } } });
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q2]), answers: [{ optionIds: ['a', 'c'] }] });
    assert.deepEqual((await state()).submitted[0].selections.q2.sort(), ['a', 'c']);
  });

  it('answer: risposta libera (con a capo) in scelta singola, togliendo la bozza gia\' selezionata', async () => {
    await reset({ ...withQ([RAW_Q1]), initialSelections: { 'chat-a': { q1: ['a'] } } });
    const text = 'prima riga\nseconda riga';
    await ui.answer({ composerId: 'chat-a', question: norm([RAW_Q1]), answers: [{ optionIds: [FREEFORM_ID], freeform: text }] });
    const s = await state();
    assert.deepEqual(s.submitted[0].selections, { q1: [FREEFORM_ID] });
    assert.equal(s.submitted[0].freeform.q1, text);
  });

  it('answer: la domanda sbagliata non viene toccata (mismatch)', async () => {
    await reset(withQ([RAW_Q1]));
    const other = norm([{ id: 'q9', prompt: 'Completamente un\'altra domanda sul deploy in produzione?', options: [{ id: 'z', label: 'Mai' }] }]);
    await assert.rejects(ui.answer({ composerId: 'chat-a', question: other, answers: [{ optionIds: ['z'] }] }), (e) => e instanceof UiError && e.code === 'mismatch');
    const s = await state();
    assert.equal(s.clicks, 0);
    assert.deepEqual(s.submitted, []);
    assert.equal(s.current, 'chat-b', 'anche dopo un errore la chat aperta viene ripristinata');
  });

  it('answer: chat inesistente -> row_not_found; chat senza questionario -> no_tray', async () => {
    await reset(withQ([RAW_Q1]));
    await assert.rejects(ui.answer({ composerId: 'chat-zzz', question: norm([RAW_Q1]), answers: [{ optionIds: ['a'] }] }), (e) => e.code === 'row_not_found');
    await assert.rejects(ui.answer({ composerId: 'chat-c', question: norm([RAW_Q1]), answers: [{ optionIds: ['a'] }] }), (e) => e.code === 'no_tray');
  });

  it('skip: preme "Skip" e il questionario sparisce', async () => {
    await reset(withQ([RAW_Q1]));
    assert.deepEqual(await ui.skip({ composerId: 'chat-a', question: norm([RAW_Q1]) }), { skipped: true });
    const s = await state();
    assert.deepEqual(s.skipped, ['chat-a']);
    assert.deepEqual(s.submitted, []);
  });

  it('sendMessage: scrive (a capo con Maiusc+Invio), invia, il campo si svuota e la chat precedente torna aperta', async () => {
    await reset(withQ([RAW_Q1]));
    const text = 'Ciao, controlla i test.\nPoi fai il commit.';
    assert.deepEqual(await ui.sendMessage({ composerId: 'chat-c', text }), { sent: true });
    const s = await state();
    assert.deepEqual(s.sent, [{ chat: 'chat-c', text }]);
    assert.equal(s.current, 'chat-b');
  });

  it('sendMessage con immagini: allega, scrive, invia; con solo immagini invia lo stesso; le anteprime spariscono', async () => {
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

  it('sendMessage con immagini: se Cursor non le mostra, errore e nessun invio; con bozza di immagini non si mescola', async () => {
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

  it('attachImages: allega e toglie tutto senza inviare', async () => {
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

  it('sendMessage: non mescola il messaggio con una bozza dell\'utente', async () => {
    await reset({ ...withQ([RAW_Q1]), draft: 'bozza scritta sul Mac' });
    await assert.rejects(ui.sendMessage({ composerId: 'chat-c', text: 'x' }), (e) => e.code === 'draft_not_empty');
    assert.deepEqual((await state()).sent, []);
  });

  it('sendMessage: con una domanda in attesa non scrive (question_pending)', async () => {
    await reset(withQ([RAW_Q1]));
    await assert.rejects(ui.sendMessage({ composerId: 'chat-a', text: 'x' }), (e) => e.code === 'question_pending');
    assert.deepEqual((await state()).sent, []);
  });

  describe('approvazione di un comando', () => {
    const cfg = (extra = {}) => ({
      current: 'chat-b',
      chats: {
        'chat-a': { name: 'Chat A', approvals: [{ messageId: 'm-1', command: 'echo uno' }, { messageId: 'm-2', command: 'echo due' }], ...extra },
        'chat-b': { name: 'Chat B' },
      },
    });

    it('"approve" preme Run sulla carta del bubble indicato (non su un\'altra) e riapre la chat di prima', async () => {
      await reset(cfg());
      const r = await ui.approval({ composerId: 'chat-a', bubbleId: 'm-2', decision: 'approve' });
      assert.equal(r.clicked, true);
      assert.equal(r.settled, true);
      const st = await state();
      assert.deepEqual(st.decided, { 'm-2': 'approve' });
      assert.equal(st.current, 'chat-b', 'la chat che l\'utente aveva aperta viene ripristinata');
    });

    it('"reject" preme Skip', async () => {
      await reset(cfg());
      await ui.approval({ composerId: 'chat-a', bubbleId: 'm-1', decision: 'reject' });
      assert.deepEqual((await state()).decided, { 'm-1': 'reject' });
    });

    it('senza la carta di quel bubble: errore e nessun clic', async () => {
      await reset(cfg());
      await assert.rejects(() => ui.approval({ composerId: 'chat-a', bubbleId: 'm-9', decision: 'approve' }), (e) => e instanceof UiError && e.code === 'no_approval');
      assert.deepEqual((await state()).decided, {});
    });

    it('con pulsanti diversi da Run/Skip non preme nulla', async () => {
      await reset(cfg({ approvals: [{ messageId: 'm-1', command: 'x', order: [['Altro', 'approve'], ['Boh', 'reject']] }] }));
      await assert.rejects(() => ui.approval({ composerId: 'chat-a', bubbleId: 'm-1', decision: 'approve' }), (e) => e instanceof UiError && e.code === 'no_approval');
      assert.deepEqual((await state()).decided, {});
    });

    it('decisione non valida: nessun accesso a Cursor', async () => {
      await assert.rejects(() => ui.approval({ composerId: 'chat-a', bubbleId: 'm-1', decision: 'boh' }), (e) => e.code === 'bad_decision');
    });
  });

  describe('ferma l\'agente', () => {
    const cfg = (running = true) => ({ current: 'chat-b', chats: { 'chat-a': { name: 'Chat A', running }, 'chat-b': { name: 'Chat B', running: true } } });

    it('preme "Stop generation" nella chat indicata (non nel pannello nascosto), poi riapre la chat di prima', async () => {
      await reset(cfg());
      const r = await ui.stop({ composerId: 'chat-a' });
      assert.deepEqual(r, { clicked: true, settled: true });
      const st = await state();
      assert.deepEqual(st.stopped, ['chat-a']);
      assert.equal(st.current, 'chat-b');
    });

    it('se la chat non sta lavorando: not_running e nessun clic', async () => {
      await reset(cfg(false));
      await assert.rejects(() => ui.stop({ composerId: 'chat-a' }), (e) => e instanceof UiError && e.code === 'not_running');
      assert.deepEqual((await state()).stopped, []);
    });
  });

  describe('menu della riga: rinomina, archivia, ripristina', () => {
    const cfg = () => ({ current: 'chat-b', chats: { 'chat-a': { name: 'Chat A' }, 'chat-b': { name: 'Chat B' }, 'chat-z': { name: 'Chat Z', archived: true } } });

    it('rinomina: tasto destro, "Rename", testo scritto al posto di quello selezionato, Invio; non cambia la chat aperta', async () => {
      await reset(cfg());
      const r = await ui.rename({ composerId: 'chat-a', name: 'Nome nuovo' });
      assert.equal(r.clicked, true);
      const st = await state();
      assert.deepEqual(st.renamed, [{ id: 'chat-a', name: 'Nome nuovo' }]);
      assert.equal(st.renaming, null);
      assert.equal(st.current, 'chat-b');
    });

    it('rinomina: chat non in sidebar -> row_not_found; nome vuoto -> bad_name', async () => {
      await reset(cfg());
      await assert.rejects(() => ui.rename({ composerId: 'chat-x', name: 'x' }), (e) => e.code === 'row_not_found');
      await assert.rejects(() => ui.rename({ composerId: 'chat-a', name: '  ' }), (e) => e.code === 'bad_name');
      assert.deepEqual((await state()).renamed, []);
    });

    it('archivia: voce "Archive" del menu della riga', async () => {
      await reset(cfg());
      await ui.archive({ composerId: 'chat-a' });
      assert.deepEqual((await state()).archived, ['chat-a']);
    });

    it('ripristina: accende il filtro "Archived", usa "Unarchive" e RIMETTE il filtro com\'era', async () => {
      await reset(cfg());
      const r = await ui.unarchive({ composerId: 'chat-z' });
      assert.equal(r.clicked, true);
      const st = await state();
      assert.deepEqual(st.unarchived, ['chat-z']);
      assert.equal(st.showArchived, false, 'il filtro delle archiviate torna spento');
    });

    it('ripristina con il filtro gia\' acceso: lo lascia acceso', async () => {
      await reset(cfg());
      await browser.evalPage(`document.querySelector('#customize').click(); document.querySelector('[role="menuitemcheckbox"]').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 0`);
      await ui.unarchive({ composerId: 'chat-z' });
      assert.equal((await state()).showArchived, true);
    });

    it('ripristina una chat che non c\'e\': row_not_found e filtro rimesso a posto', async () => {
      await reset(cfg());
      await assert.rejects(() => ui.unarchive({ composerId: 'chat-nope' }), (e) => e.code === 'row_not_found');
      assert.equal((await state()).showArchived, false);
    });
  });

  describe('nuova chat su un progetto', () => {
    const cfg = (extra = {}) => ({ current: 'chat-b', projects: ['Progetto A', 'Progetto B'], chats: { 'chat-a': { name: 'Chat A' }, 'chat-b': { name: 'Chat B' } }, ...extra });

    it('apre "New Agent" del progetto giusto, controlla progetto e ambiente, scrive, invia e ridà l\'id della chat nuova', async () => {
      await reset(cfg());
      const r = await ui.newChat({ project: 'Progetto B', text: 'Crea un README\ncon le istruzioni' });
      assert.deepEqual(r, { composerId: 'new-1' });
      const s = await state();
      assert.deepEqual(s.newChats, [{ id: 'new-1', project: 'Progetto B', text: 'Crea un README\ncon le istruzioni', images: 0 }]);
      assert.deepEqual(s.sent, []);
      assert.equal(s.current, 'chat-b', 'la chat che era aperta torna aperta');
    });

    it('con sole immagini (niente testo) crea la chat lo stesso', async () => {
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

    it('rifiuta senza inviare: progetto assente, nome doppio, ambiente non locale', async () => {
      await reset(cfg());
      await assert.rejects(ui.newChat({ project: 'Inesistente', text: 'x' }), (e) => e.code === 'project_not_found');
      await reset(cfg({ projects: ['Progetto A', 'Progetto A'] }));
      await assert.rejects(ui.newChat({ project: 'Progetto A', text: 'x' }), (e) => e.code === 'project_ambiguous');
      await reset(cfg({ env: 'New Worktree' }));
      await assert.rejects(ui.newChat({ project: 'Progetto A', text: 'x' }), (e) => e.code === 'not_local');
      assert.deepEqual((await state()).newChats, []);
    });

    it('dryRun: arriva ai controlli e non invia', async () => {
      await reset(cfg());
      const r = await ui.newChat({ project: 'Progetto A', text: 'x', dryRun: true });
      assert.equal(r.dryRun, true);
      assert.deepEqual((await state()).newChats, []);
    });
  });
});
