#!/usr/bin/env node
// Demo server: same as the real daemon, but on a SYNTHETIC Cursor database (made-up titles) with simulated push
// delivery (no network). Use it to try and document the PWA without touching real Cursor data.
//
// Usage:  node --disable-warning=ExperimentalWarning tools/demo-server.mjs [--port 8799] [--animate] [--no-actions]
//   --animate     after startup one chat finishes and another gets a new question (to see live updates)
//   --no-actions  simulates Cursor WITHOUT a debug port (PWA stays read-only). By default a fake "Cursor"
//                 accepts answers and messages and writes them to the synthetic database, like the real one.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../daemon/src/app.js';
import { loadConfig } from '../daemon/src/config.js';
import { sectionIdFor } from '../daemon/src/cursor/workspaces.js';
import { createLogger } from '../daemon/src/log.js';
import { CursorFixture } from '../daemon/test/helpers/fixture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8799;
const animate = args.includes('--animate');
const withActions = !args.includes('--no-actions');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-demo-'));
const fx = new CursorFixture(dir);
fx.db.exec('PRAGMA journal_mode=WAL'); // like the real Cursor database: readers do not block writers

const ago = (minutes) => Date.now() - minutes * 60_000;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const WS = {
  negozio: { workspaceId: 'ws-negozio', path: '/Users/demo/negozio-online' },
  app: { workspaceId: 'ws-app', path: '/Users/demo/app-mobile' },
  sito: { workspaceId: 'ws-sito', path: '/Users/demo/sito-vetrina' },
};

const QUESTION = {
  title: 'Come gestisco gli sconti?',
  questions: [
    {
      id: 'q1',
      prompt: 'Gli sconti si applicano prima o dopo il costo di spedizione?',
      options: [
        { id: 'a', label: 'Prima della spedizione' },
        { id: 'b', label: 'Dopo la spedizione' },
      ],
      allowMultiple: false,
    },
  ],
};

const LONG_TEXT = [
  'Ho aggiunto il tema scuro alla schermata delle impostazioni e collegato la scelta al salvataggio locale.',
  '',
  'Cosa ho cambiato:',
  '- nuova sezione Aspetto con tre opzioni: Chiaro, Scuro, Automatico;',
  '- i colori sono ora definiti in un unico file di temi, senza valori ripetuti nei componenti;',
  '- la preferenza viene letta all\u2019avvio, cos\u00ec non c\u2019\u00e8 il lampo di colore sbagliato;',
  '- aggiornati gli screenshot di riferimento dei test visivi.',
  '',
  'Cosa resta da verificare:',
  '- il contrasto del testo secondario nella schermata Profilo;',
  '- il comportamento con le impostazioni di accessibilit\u00e0 di sistema attive;',
  '- la schermata di caricamento iniziale, che usa ancora un colore fisso.',
  '',
  'Fammi sapere se vuoi che proceda con il Profilo oppure se preferisci prima una revisione di quanto fatto.',
].join('\n');

const chatSpecs = new Map(); // n -> { name, where, minutesAgo }
const bubblesOf = new Map(); // n -> bubble[] (to append more)

function chat(n, name, where, minutesAgo, header = {}) {
  chatSpecs.set(n, { name, where, minutesAgo });
  fx.chat(id(n), { ...WS[where], name, lastUpdatedAt: ago(minutesAgo), createdAt: ago(minutesAgo + 600), header });
}

function talk(n, minutesAgo, assistantText, tool) {
  const t = ago(minutesAgo);
  const bubbles = [{ id: 'b1', type: 1, createdAt: t - 60_000, text: 'Procedi pure.' }];
  if (assistantText) bubbles.push({ id: 'b2', type: 2, createdAt: t - 30_000, text: assistantText });
  if (tool) bubbles.push({ id: 'b3', type: 2, createdAt: t, tool });
  bubblesOf.set(n, bubbles);
  fx.conversation(id(n), bubbles);
}

// Online store
chat(1, 'Correggi il calcolo del carrello', 'negozio', 4, { hasBlockingPendingActions: true });
talk(1, 4, 'Prima di continuare mi serve una decisione sugli sconti.', { name: 'ask_question', status: 'loading', toolCallId: 'tc-demo-1', params: QUESTION });
chat(2, 'Migrazione della tabella ordini', 'negozio', 1, { unfinishedRunAt: ago(3) });
talk(2, 1, 'Sto aggiornando le query che leggono lo storico ordini.');
{
  // A few agent steps for the "Recent activity" section (made-up commands and paths: not emitted by the daemon)
  const b = bubblesOf.get(2);
  const t = ago(1);
  b.push(
    { id: 'b4', type: 2, createdAt: t + 5_000, tool: { name: 'read_file_v2', status: 'completed', toolCallId: 'tc-demo-2a', params: { path: '/demo/ordini.sql' } } },
    { id: 'b5', type: 2, createdAt: t + 12_000, tool: { name: 'edit_file_v2', status: 'completed', toolCallId: 'tc-demo-2b', params: { path: '/demo/ordini.sql' } } },
    { id: 'b6', type: 2, createdAt: t + 20_000, tool: { name: 'run_terminal_command_v2', status: 'loading', toolCallId: 'tc-demo-2c', params: { command: 'npm test' } } },
  );
  fx.conversation(id(2), b, { status: 'generating' });
}
chat(3, 'Piano per il flusso di checkout', 'negozio', 40, { hasPendingPlan: true });
talk(3, 40, 'Ho preparato un piano in quattro passaggi: indirizzo, spedizione, pagamento, conferma.');
chat(4, 'Test per il modulo pagamenti', 'negozio', 130);
talk(4, 130, 'Ho aggiunto i test per i rimborsi parziali e per i pagamenti rifiutati.\n\n```\nnpm test -- payments\n```\nSono tutti **verdi** con `jest`.\n<script>alert(1)</script>');
chat(5, 'Ottimizza le immagini dei prodotti', 'negozio', 60 * 26);
talk(5, 60 * 26, 'Le immagini sono ora servite in formato WebP con dimensioni responsive.');
chat(6, 'Bug nel filtro per categoria', 'negozio', 60 * 50);
talk(6, 60 * 50, 'Il filtro ignorava le categorie con spazi nel nome: corretto.');
chat(7, 'Aggiorna le dipendenze', 'negozio', 60 * 24 * 4);
talk(7, 60 * 24 * 4, 'Aggiornate le librerie minori; restano due major da valutare.');
chat(8, 'Documentazione delle API', 'negozio', 60 * 24 * 9);
talk(8, 60 * 24 * 9, 'Ho generato la documentazione a partire dagli schemi.');
{
  // Long conversation (more than one page) to exercise "Earlier messages".
  const t0 = ago(60 * 24 * 9);
  const long = [];
  for (let i = 0; i < 44; i++) {
    const at = t0 - (44 - i) * 60_000;
    if (i % 4 === 2) long.push({ id: `h${i}`, type: 2, createdAt: at, tool: { name: 'read_file_v2', status: 'completed', toolCallId: `tc-h${i}`, params: { path: '/demo/schema.json' } } });
    else if (i % 2 === 0) long.push({ id: `h${i}`, type: 1, createdAt: at, text: `Domanda numero ${i / 2 + 1} sulla documentazione.` });
    else long.push({ id: `h${i}`, type: 2, createdAt: at, text: `Risposta numero ${(i - 1) / 2 + 1}.\n\n- primo punto\n- secondo punto` });
  }
  long.push({ id: 'h-last', type: 2, createdAt: t0, text: 'Ho generato la documentazione a partire dagli schemi.' });
  bubblesOf.set(8, long);
  fx.conversation(id(8), long);
}

// Mobile app
chat(9, 'Tema scuro nelle impostazioni', 'app', 25, { hasUnreadMessages: true });
talk(9, 25, LONG_TEXT);
chat(10, 'Refactor dell\u2019autenticazione', 'app', 180, { hasBlockingPendingActions: true });
talk(10, 180, 'Il refactor \u00e8 concluso, resta solo la revisione.', { name: 'edit_file', status: 'completed', toolCallId: 'tc-demo-10' });
chat(11, 'Schermata di avvio animata', 'app', 60 * 6);
talk(11, 60 * 6, 'L\u2019animazione dura 900 ms e rispetta la riduzione del movimento.');

// Two questions together: one single-choice and one multiple-choice (full questionnaire test)
chat(14, 'Preferenze di notifica', 'app', 2, { hasBlockingPendingActions: true });
talk(14, 2, 'Per configurare le notifiche mi servono due scelte.', {
  name: 'ask_question',
  status: 'loading',
  toolCallId: 'tc-demo-14',
  params: {
    title: 'Notifiche dell\u2019app',
    questions: [
      { id: 'q1', prompt: 'Quando vuoi ricevere le notifiche?', options: [{ id: 'a', label: 'Sempre' }, { id: 'b', label: 'Solo di giorno' }, { id: 'c', label: 'Mai di notte, ma i messaggi diretti s\u00ec' }], allowMultiple: false },
      { id: 'q2', prompt: 'Per quali eventi?', options: [{ id: 'a', label: 'Nuovi messaggi' }, { id: 'b', label: 'Promemoria' }, { id: 'c', label: 'Aggiornamenti dell\u2019app' }, { id: 'd', label: 'Offerte' }], allowMultiple: true },
    ],
  },
});

// One command awaiting approval (reviewData Requested): agent is paused until you decide on the Mac
chat(15, 'Pubblicazione del pacchetto', 'negozio', 1, { hasBlockingPendingActions: true, unfinishedRunAt: ago(3) });
talk(15, 1, 'Pubblico la nuova versione sul registro.', {
  name: 'run_terminal_command_v2',
  status: 'loading',
  toolCallId: 'tc-demo-15',
  params: { command: 'npm publish --access public' },
  additionalData: { reviewData: { status: 'Requested', approvalType: 'user' } },
});

// Two more pending commands: one to reject and one non-terminal (not decided from here)
chat(17, 'Pulizia della cartella temporanea', 'app', 2, { hasBlockingPendingActions: true, unfinishedRunAt: ago(4) });
talk(17, 2, 'Svuoto la cartella temporanea prima di rigenerare i file.', {
  name: 'run_terminal_command_v2',
  status: 'loading',
  toolCallId: 'tc-demo-17',
  params: { command: 'rm -rf ./tmp/cache', commandDescription: 'Svuota la cache locale' },
  additionalData: { reviewData: { status: 'Requested', approvalType: 'user' } },
});
chat(19, 'Installazione delle dipendenze', 'app', 3, { hasBlockingPendingActions: true, unfinishedRunAt: ago(5) });
talk(19, 3, 'Installo i pacchetti mancanti.', {
  name: 'run_terminal_command_v2',
  status: 'loading',
  toolCallId: 'tc-demo-19',
  params: { command: 'npm install' },
  additionalData: { reviewData: { status: 'Requested', approvalType: 'user' } },
});
chat(18, 'Chiamata a un servizio esterno', 'app', 2.5, { hasBlockingPendingActions: true, unfinishedRunAt: ago(4) });
talk(18, 2.5, 'Interrogo il servizio di prova.', {
  name: 'mcp_custom_tool',
  status: 'loading',
  toolCallId: 'tc-demo-18',
  params: {},
  additionalData: { reviewData: { status: 'Requested', approvalType: 'user' } },
});

// Fresh question: Cursor only writes the text at end of turn (empty params here, like real data for 10-30 s)
chat(16, 'Scelta del fornitore di pagamenti', 'negozio', 0.1, { hasBlockingPendingActions: true });
talk(16, 0.1, 'Mi serve una scelta sul fornitore.', { name: 'ask_question', status: 'loading', toolCallId: 'tc-demo-16', params: '' });

// Showcase site (collapsed group in the sidebar)
chat(12, 'Vecchio esperimento sul menu', 'sito', 60 * 24 * 3, { hasBlockingPendingActions: true });
talk(12, 60 * 24 * 3, 'Ho provato due varianti del menu laterale.', { name: 'edit_file', status: 'completed', toolCallId: 'tc-demo-12' });
chat(13, 'Testi della pagina iniziale', 'sito', 60 * 24 * 5);
talk(13, 60 * 24 * 5, 'Ho riscritto i titoli con un tono pi\u00f9 diretto.');
chat(20, 'Prova di un tema scuro', 'sito', 60 * 24 * 9);
talk(20, 60 * 24 * 9, 'Il tema scuro \u00e8 pronto.');
fx.chat(id(20), { archived: true });

fx.setSidebar({
  groupBy: 'workspace',
  sortGroupsBy: 'manual',
  sortAgentsBy: 'updated',
  sectionOrderByGroupBy: { workspace: [] },
  collapsedSectionIdsByGroupBy: { workspace: [sectionIdFor(`local:path:${WS.sito.path}`)] },
  removedSectionIds: [],
});

const config = loadConfig({
  CP_CURSOR_DB: fx.file,
  CP_WORKSPACE_STORAGE: fx.wsDir,
  CP_DATA_DIR: path.join(dir, 'data'),
  CP_PWA_DIR: path.join(root, 'pwa'),
  CP_PORT: String(port),
});

let pushes = 0;
let newChats = 0;

// Fake "Cursor" for phone actions: writes to the synthetic database what real Cursor would write.
const numOf = (composerId) => Number(composerId.slice(-12));
const pinnedDemo = new Set();
const demoUi = {
  async probe() {
    return { up: true, browser: 'Demo/1.0' };
  },
  async hasWindow() {
    return true;
  },
  async answer({ composerId, question, answers }) {
    const n = numOf(composerId);
    const spec = chatSpecs.get(n);
    const old = bubblesOf.get(n)?.find((b) => b.tool);
    if (!spec || !old) throw Object.assign(new Error('demo'), { code: 'no_tray' });
    const currentSelections = {};
    const freeformTexts = {};
    question.questions.forEach((q, i) => {
      currentSelections[q.id] = answers[i].optionIds;
      if (answers[i].freeform) freeformTexts[q.id] = answers[i].freeform;
    });
    await new Promise((r) => setTimeout(r, 700)); // time to click in the Cursor window
    talk(n, spec.minutesAgo, bubblesOf.get(n).find((b) => b.id === 'b2')?.text, { ...old.tool, status: 'completed', additionalData: { status: 'submitted', currentSelections, freeformTexts } });
    chat(n, spec.name, spec.where, 0, { hasBlockingPendingActions: false });
    console.log('[demo] answer recorded in chat', n);
    return { submitted: true };
  },
  async skip({ composerId }) {
    const n = numOf(composerId);
    const spec = chatSpecs.get(n);
    const old = bubblesOf.get(n)?.find((b) => b.tool);
    if (!spec || !old) throw Object.assign(new Error('demo'), { code: 'no_tray' });
    await new Promise((r) => setTimeout(r, 500));
    talk(n, spec.minutesAgo, bubblesOf.get(n).find((b) => b.id === 'b2')?.text, { ...old.tool, status: 'completed', additionalData: { status: 'skipped' } });
    chat(n, spec.name, spec.where, 0, { hasBlockingPendingActions: false });
    return { skipped: true };
  },
  async approval({ composerId, decision }) {
    const n = numOf(composerId);
    const spec = chatSpecs.get(n);
    const old = bubblesOf.get(n)?.find((b) => b.tool);
    if (!spec || !old) throw Object.assign(new Error('demo'), { code: 'no_tray' });
    await new Promise((r) => setTimeout(r, 600)); // time to click in the Cursor window
    const done = decision === 'approve' ? { status: 'completed', review: 'Done' } : { status: 'cancelled', review: 'Done' };
    talk(n, spec.minutesAgo, bubblesOf.get(n).find((b) => b.id === 'b2')?.text, { ...old.tool, status: done.status, additionalData: { reviewData: { status: done.review, approvalType: 'user' } } });
    chat(n, spec.name, spec.where, 0, { hasBlockingPendingActions: false, unfinishedRunAt: decision === 'approve' ? Date.now() : undefined });
    console.log('[demo] approval recorded:', decision, 'chat', n);
    return {};
  },
  async stop({ composerId }) {
    const n = numOf(composerId);
    const spec = chatSpecs.get(n);
    if (!spec) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    await new Promise((r) => setTimeout(r, 500));
    fx.conversation(composerId, bubblesOf.get(n), { status: 'aborted' });
    chat(n, spec.name, spec.where, 0, { unfinishedRunAt: undefined });
    console.log('[demo] agent stopped, chat', n);
    return { clicked: true, settled: true };
  },
  async newChat({ project, text, branch, model }) {
    const where = Object.keys(WS).find((k) => WS[k].path.endsWith(`/${project}`));
    if (!where) throw Object.assign(new Error('demo'), { code: 'project_not_found' });
    await new Promise((r) => setTimeout(r, 600));
    newChats += 1;
    const n = 100 + newChats;
    chat(n, (text || 'Chat con immagini').slice(0, 40) + (branch || model ? ` [${branch || ''}|${model || ''}]` : ''), where, 0, { unfinishedRunAt: Date.now() });
    talk(n, 0, null);
    return { composerId: id(n) };
  },
  async rename({ composerId, name }) {
    const n = numOf(composerId);
    const spec = chatSpecs.get(n);
    if (!spec) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    await new Promise((r) => setTimeout(r, 400));
    spec.name = name;
    fx.chat(composerId, { name });
    return { clicked: true };
  },
  async archive({ composerId }) {
    if (!chatSpecs.get(numOf(composerId))) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    await new Promise((r) => setTimeout(r, 400));
    fx.chat(composerId, { archived: true });
    return { clicked: true };
  },
  async newChatOptions() {
    await new Promise((r) => setTimeout(r, 400));
    return { branch: { current: 'main', options: ['main', 'sviluppo', 'fix/login'] }, model: { current: 'Claude Sonnet 5.5 High', options: ['Auto', 'Composer 2.5', 'Claude Sonnet 5.5 High', 'Claude Opus 4.6 High'] } };
  },
  async pinState({ composerId }) {
    if (!chatSpecs.get(numOf(composerId))) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    return { pinned: pinnedDemo.has(composerId) };
  },
  async setPinned({ composerId, pinned }) {
    if (!chatSpecs.get(numOf(composerId))) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    await new Promise((r) => setTimeout(r, 300));
    if (pinned) pinnedDemo.add(composerId);
    else pinnedDemo.delete(composerId);
    return { pinned, changed: true };
  },
  async unarchive({ composerId }) {
    if (!chatSpecs.get(numOf(composerId))) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    await new Promise((r) => setTimeout(r, 400));
    fx.chat(composerId, { archived: false });
    return { clicked: true };
  },
  async sendMessage({ composerId }) {
    const n = numOf(composerId);
    const spec = chatSpecs.get(n);
    const bubbles = bubblesOf.get(n);
    if (!spec || !bubbles) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    await new Promise((r) => setTimeout(r, 500));
    const next = [...bubbles, { id: `u${bubbles.length}`, type: 1, createdAt: Date.now(), text: 'messaggio dal telefono' }];
    bubblesOf.set(n, next);
    fx.conversation(composerId, next);
    chat(n, spec.name, spec.where, 0, { unfinishedRunAt: Date.now() }); // agent starts working
    setTimeout(() => {
      const done = [...next, { id: `a${next.length}`, type: 2, createdAt: Date.now(), text: 'Ho letto il tuo messaggio e riprendo il lavoro da l\u00ec.' }];
      bubblesOf.set(n, done);
      fx.conversation(composerId, done);
      chat(n, spec.name, spec.where, 0, { unfinishedRunAt: undefined, hasUnreadMessages: true });
    }, 6000);
    return { sent: true };
  },
};

const app = createApp({
  config,
  logger: createLogger({ level: 'warn', stream: process.stderr }),
  // Fake "keep Mac awake": no real process.
  actionsDeps: {
    ...(withActions ? { ui: demoUi } : { ui: { probe: async () => ({ up: false }), hasWindow: async () => false } }),
    awake: {
      spawn: () => Object.assign(new EventEmitter(), { kill() {}, unref() {} }),
      exists: () => true,
      // Fake Mac: no system commands, no real changes.
      power: {
        brightnessCmd: '', brightnessAvailable: true,
        canControlSleep: async () => true, setSleepDisabled: async () => {}, sleepDisabled: async () => true,
        lidClosed: async () => false, battery: async () => ({ onAC: true, percent: 100 }),
        getBrightness: async () => 0.8, setBrightness: async () => true,
      },
    },
  },
  // No real delivery: count only.
  send: async () => {
    pushes += 1;
    console.log(`[demo] simulated push #${pushes}`);
    return { ok: true, status: 201 };
  },
});
await app.start();
// A second device already paired, to show the list in Settings.
app.auth.pair(app.auth.createPairingCode().code, { label: 'iPad' });
const { code } = app.auth.createPairingCode();
console.log(`Demo running: http://127.0.0.1:${port}/`);
console.log(`Codice di abbinamento (15 min): ${code}`);

if (animate) {
  setTimeout(() => {
    chat(2, 'Migrazione della tabella ordini', 'negozio', 0, { unfinishedRunAt: undefined, hasUnreadMessages: true });
    talk(2, 0, 'La migrazione \u00e8 completata: 1.248 righe aggiornate, nessun errore.');
    console.log('[demo] chat "Migrazione della tabella ordini" finished');
  }, 15_000);
  setTimeout(() => {
    chat(11, 'Schermata di avvio animata', 'app', 0, { hasBlockingPendingActions: true });
    talk(11, 0, 'Serve una scelta sul comportamento al primo avvio.', {
      name: 'ask_question',
      status: 'loading',
      toolCallId: 'tc-demo-11',
      params: { title: 'Primo avvio', questions: [{ id: 'q1', prompt: 'Mostro la schermata di benvenuto a ogni avvio o solo la prima volta?', options: [{ id: 'a', label: 'Solo la prima volta' }, { id: 'b', label: 'A ogni avvio' }], allowMultiple: false }] },
    });
    console.log('[demo] new question in "Schermata di avvio animata"');
  }, 30_000);
}

async function shutdown() {
  await app.stop().catch(() => {});
  fx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
