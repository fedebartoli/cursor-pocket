#!/usr/bin/env node
// Server dimostrativo: il daemon vero, ma su un database di Cursor SINTETICO (titoli inventati) e con invii push
// simulati (nessuna rete). Serve a provare e documentare la PWA senza toccare i dati reali di Cursor.
//
// Uso:  node --disable-warning=ExperimentalWarning tools/demo-server.mjs [--port 8799] [--animate] [--no-actions]
//   --animate     dopo l'avvio una chat finisce e ne compare una con una nuova domanda (per vedere gli aggiornamenti live)
//   --no-actions  simula Cursor SENZA porta di debug (la PWA resta in sola lettura). Di default un "Cursor" finto
//                 accetta risposte e messaggi e li scrive nel database sintetico, come farebbe quello vero.
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
fx.db.exec('PRAGMA journal_mode=WAL'); // come il vero database di Cursor: i lettori non bloccano chi scrive

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
const bubblesOf = new Map(); // n -> bubble[] (per aggiungerne altri)

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

// Negozio online
chat(1, 'Correggi il calcolo del carrello', 'negozio', 4, { hasBlockingPendingActions: true });
talk(1, 4, 'Prima di continuare mi serve una decisione sugli sconti.', { name: 'ask_question', status: 'loading', toolCallId: 'tc-demo-1', params: QUESTION });
chat(2, 'Migrazione della tabella ordini', 'negozio', 1, { unfinishedRunAt: ago(3) });
talk(2, 1, 'Sto aggiornando le query che leggono lo storico ordini.');
{
  // Qualche passo dell'agente per la sezione "Attivita' recente" (comandi e percorsi inventati: non escono dal daemon)
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
  // Conversazione lunga (oltre una pagina) per provare "Messaggi precedenti".
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

// App mobile
chat(9, 'Tema scuro nelle impostazioni', 'app', 25, { hasUnreadMessages: true });
talk(9, 25, LONG_TEXT);
chat(10, 'Refactor dell\u2019autenticazione', 'app', 180, { hasBlockingPendingActions: true });
talk(10, 180, 'Il refactor \u00e8 concluso, resta solo la revisione.', { name: 'edit_file', status: 'completed', toolCallId: 'tc-demo-10' });
chat(11, 'Schermata di avvio animata', 'app', 60 * 6);
talk(11, 60 * 6, 'L\u2019animazione dura 900 ms e rispetta la riduzione del movimento.');

// Due domande insieme: una a scelta singola e una multipla (prova del questionario completo)
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

// Un comando in attesa di approvazione (reviewData Requested): l'agente e' fermo finche' non decidi sul Mac
chat(15, 'Pubblicazione del pacchetto', 'negozio', 1, { hasBlockingPendingActions: true, unfinishedRunAt: ago(3) });
talk(15, 1, 'Pubblico la nuova versione sul registro.', {
  name: 'run_terminal_command_v2',
  status: 'loading',
  toolCallId: 'tc-demo-15',
  params: { command: 'npm publish --access public' },
  additionalData: { reviewData: { status: 'Requested', approvalType: 'user' } },
});

// Altri due comandi in attesa: uno da rifiutare e uno non di terminale (da qui non si decide)
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

// Domanda appena creata: Cursor ne scrive il testo solo a fine turno (qui params vuoti, come nei dati reali per 10-30 s)
chat(16, 'Scelta del fornitore di pagamenti', 'negozio', 0.1, { hasBlockingPendingActions: true });
talk(16, 0.1, 'Mi serve una scelta sul fornitore.', { name: 'ask_question', status: 'loading', toolCallId: 'tc-demo-16', params: '' });

// Sito vetrina (gruppo compresso nella sidebar)
chat(12, 'Vecchio esperimento sul menu', 'sito', 60 * 24 * 3, { hasBlockingPendingActions: true });
talk(12, 60 * 24 * 3, 'Ho provato due varianti del menu laterale.', { name: 'edit_file', status: 'completed', toolCallId: 'tc-demo-12' });
chat(13, 'Testi della pagina iniziale', 'sito', 60 * 24 * 5);
talk(13, 60 * 24 * 5, 'Ho riscritto i titoli con un tono pi\u00f9 diretto.');

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

// "Cursor" finto per le azioni dal telefono: scrive nel database sintetico quello che scriverebbe Cursor vero.
const numOf = (composerId) => Number(composerId.slice(-12));
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
    await new Promise((r) => setTimeout(r, 700)); // il tempo di cliccare nella finestra di Cursor
    talk(n, spec.minutesAgo, bubblesOf.get(n).find((b) => b.id === 'b2')?.text, { ...old.tool, status: 'completed', additionalData: { status: 'submitted', currentSelections, freeformTexts } });
    chat(n, spec.name, spec.where, 0, { hasBlockingPendingActions: false });
    console.log('[demo] risposta registrata nella chat', n);
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
    await new Promise((r) => setTimeout(r, 600)); // il tempo di cliccare nella finestra di Cursor
    const done = decision === 'approve' ? { status: 'completed', review: 'Done' } : { status: 'cancelled', review: 'Done' };
    talk(n, spec.minutesAgo, bubblesOf.get(n).find((b) => b.id === 'b2')?.text, { ...old.tool, status: done.status, additionalData: { reviewData: { status: done.review, approvalType: 'user' } } });
    chat(n, spec.name, spec.where, 0, { hasBlockingPendingActions: false, unfinishedRunAt: decision === 'approve' ? Date.now() : undefined });
    console.log('[demo] approvazione registrata:', decision, 'chat', n);
    return {};
  },
  async stop({ composerId }) {
    const n = numOf(composerId);
    const spec = chatSpecs.get(n);
    if (!spec) throw Object.assign(new Error('demo'), { code: 'row_not_found' });
    await new Promise((r) => setTimeout(r, 500));
    fx.conversation(composerId, bubblesOf.get(n), { status: 'aborted' });
    chat(n, spec.name, spec.where, 0, { unfinishedRunAt: undefined });
    console.log('[demo] agente fermato, chat', n);
    return { clicked: true, settled: true };
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
    chat(n, spec.name, spec.where, 0, { unfinishedRunAt: Date.now() }); // l'agente si mette al lavoro
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
  // "Mac sveglio" finto: nessun processo vero.
  actionsDeps: {
    ...(withActions ? { ui: demoUi } : { ui: { probe: async () => ({ up: false }), hasWindow: async () => false } }),
    awake: {
      spawn: () => Object.assign(new EventEmitter(), { kill() {}, unref() {} }),
      exists: () => true,
      // Mac finto: nessun comando di sistema, nessuna modifica reale.
      power: {
        brightnessCmd: '', brightnessAvailable: true,
        canControlSleep: async () => true, setSleepDisabled: async () => {}, sleepDisabled: async () => true,
        lidClosed: async () => false, battery: async () => ({ onAC: true, percent: 100 }),
        getBrightness: async () => 0.8, setBrightness: async () => true,
      },
    },
  },
  // Nessun invio reale: si conta solo.
  send: async () => {
    pushes += 1;
    console.log(`[demo] push simulato n. ${pushes}`);
    return { ok: true, status: 201 };
  },
});
await app.start();
// Un secondo dispositivo gia' abbinato, per mostrare l'elenco in Impostazioni.
app.auth.pair(app.auth.createPairingCode().code, { label: 'iPad' });
const { code } = app.auth.createPairingCode();
console.log(`Demo attiva: http://127.0.0.1:${port}/`);
console.log(`Codice di abbinamento (15 min): ${code}`);

if (animate) {
  setTimeout(() => {
    chat(2, 'Migrazione della tabella ordini', 'negozio', 0, { unfinishedRunAt: undefined, hasUnreadMessages: true });
    talk(2, 0, 'La migrazione \u00e8 completata: 1.248 righe aggiornate, nessun errore.');
    console.log('[demo] la chat "Migrazione della tabella ordini" e\' finita');
  }, 15_000);
  setTimeout(() => {
    chat(11, 'Schermata di avvio animata', 'app', 0, { hasBlockingPendingActions: true });
    talk(11, 0, 'Serve una scelta sul comportamento al primo avvio.', {
      name: 'ask_question',
      status: 'loading',
      toolCallId: 'tc-demo-11',
      params: { title: 'Primo avvio', questions: [{ id: 'q1', prompt: 'Mostro la schermata di benvenuto a ogni avvio o solo la prima volta?', options: [{ id: 'a', label: 'Solo la prima volta' }, { id: 'b', label: 'A ogni avvio' }], allowMultiple: false }] },
    });
    console.log('[demo] nuova domanda in "Schermata di avvio animata"');
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
