// CLI di servizio: `npm run pair | status | probe | cdp` (da daemon/).
//
//   pair    genera un codice di abbinamento monouso da inserire nella PWA sull'iPhone
//   status  controlla se il daemon risponde e riassume sessioni/sottoscrizioni (nessun contenuto di chat)
//   probe   legge il database di Cursor (sola lettura) e riassume cosa vedrebbe il daemon.
//           Per default NON stampa titoli ne' nomi di cartelle; con --names mostra i nomi dei workspace.
//   cdp     diagnostica delle azioni (Fase 2): `npm run cdp -- status | inspect | tray [--names|--texts]`.
//           Solo lettura della pagina: non clicca e non scrive nulla in Cursor.
import path from 'node:path';
import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import { AgentsUi } from './cursor/agents-ui.js';
import { CursorDb } from './cursor/db.js';
import { classifyAttention, buildChat, isVisibleLocalChat } from './cursor/model.js';
import { WorkspaceResolver } from './cursor/workspaces.js';
import { presentState } from './state/present.js';
import { Store } from './state/store.js';

const config = loadConfig();
const [, , cmd, ...args] = process.argv;

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

async function pair() {
  const store = new Store(path.join(config.dataDir, 'store.db'));
  const auth = new Auth({ store, config });
  const { code, expiresAt } = auth.createPairingCode();
  store.close();
  const minutes = Math.round(config.pairingTtlMs / 60_000);
  console.log('');
  console.log(`  Codice di abbinamento:  ${code}`);
  console.log('');
  console.log(`  Valido per ${minutes} minuti (fino alle ${fmtTime(expiresAt)}) e utilizzabile una sola volta.`);
  console.log("  Inseriscilo nella schermata di accesso dell'app installata sull'iPhone.");
  console.log('');
}

async function status() {
  const url = `http://${config.host}:${config.port}/healthz`;
  let up = false;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    up = r.ok;
  } catch {
    up = false;
  }
  console.log(`Daemon su ${config.host}:${config.port}: ${up ? 'attivo' : 'NON raggiungibile'}`);
  try {
    const store = new Store(path.join(config.dataDir, 'store.db'));
    console.log(`Dispositivi abbinati (sessioni): ${store.listSessions().length}`);
    console.log(`Sottoscrizioni push: ${store.countSubscriptions()}`);
    console.log(`Richieste ignorate: ${store.ignoredSet().size}`);
    store.close();
  } catch (err) {
    console.log(`Archivio locale non leggibile: ${err.message}`);
  }
  process.exitCode = up ? 0 : 1;
}

async function probe() {
  const showNames = args.includes('--names');
  const db = new CursorDb(config.cursorDbPath);
  try {
    db.open();
  } catch (err) {
    console.error(`Database di Cursor non leggibile: ${err.message}`);
    process.exit(1);
  }
  const now = Date.now();
  const resolver = new WorkspaceResolver({ dir: config.workspaceStorageDir });
  const chats = [];
  const removedWorkspaceIds = db.removedWorkspaceIds();
  let hiddenByRemoval = 0;
  for (const entry of db.listHeaders()) {
    if (!isVisibleLocalChat(entry, { includeClassic: config.includeClassicChats, removedWorkspaceIds })) {
      if (isVisibleLocalChat(entry, { includeClassic: config.includeClassicChats })) hiddenByRemoval++;
      continue;
    }
    const ws = resolver.resolve(entry);
    const h = entry.header;
    let attention = null;
    if (h.hasBlockingPendingActions === true || h.hasPendingPlan === true) {
      const tail = db.composerTail(entry.id);
      const bubble = tail?.lastBubble ? db.bubbleSummary(entry.id, tail.lastBubble.id) : null;
      attention = classifyAttention({ entry, tail, bubble, now });
    }
    chats.push(buildChat({ entry, ws, attention, now, staleRunMs: config.staleRunMs }));
  }
  const settings = db.sidebarSettings();
  db.close();
  const state = presentState({ chats, settings, ignored: new Set(), now, pendingAfterMs: config.pendingAfterMs });

  console.log(`Chat visibili: ${state.counts.total} | richiedono attenzione: ${state.counts.attention} | in sospeso: ${state.counts.pending} | in corso: ${state.counts.running}`);
  console.log(`Nascoste perche' il progetto e' rimosso dalla sidebar di Cursor: ${hiddenByRemoval}`);
  console.log(`Raggruppamento Cursor: ${settings?.groupBy ?? '?'} | ordine gruppi: ${settings?.sortGroupsBy ?? '?'}`);
  console.log('Gruppi nell\'ordine della sidebar:');
  state.workspaces.forEach((w, i) => {
    const label = showNames ? w.name : `gruppo ${i + 1}`;
    const kinds = {};
    for (const c of w.chats) if (c.attention) kinds[c.attention.kind] = (kinds[c.attention.kind] || 0) + 1;
    const extra = Object.entries(kinds).map(([k, n]) => `${k}:${n}`).join(' ');
    console.log(`  ${String(i + 1).padStart(2)}. ${label}  chat=${w.chats.length}${w.collapsed ? ' [compresso]' : ''}${extra ? `  ${extra}` : ''}`);
  });
}

/** Diagnostica della porta di debug e della pagina Agents. Mai clic, mai scritture; testi solo con --texts/--names. */
async function cdp() {
  const sub = args.find((a) => !a.startsWith('--')) ?? 'status';
  const showNames = args.includes('--names');
  const showTexts = args.includes('--texts');
  const ui = new AgentsUi({ port: config.cdpPort });
  const p = await ui.probe();
  if (!p.up) {
    console.log(`Porta di debug ${config.cdpPort}: CHIUSA (Cursor non e' stato avviato con --remote-debugging-port=${config.cdpPort}).`);
    console.log('Per attivare le azioni: chiudi Cursor e riaprilo con tools/cursor-cdp.sh (vedi docs/SETUP.md).');
    process.exitCode = 1;
    return;
  }
  if (sub === 'status') {
    const found = await ui.hasWindow();
    console.log(`Porta di debug ${config.cdpPort}: attiva (${p.browser ?? 'versione sconosciuta'})`);
    console.log(`Finestra Agents: ${found ? 'trovata' : 'NON trovata'}`);
    if (!found) process.exitCode = 1;
    return;
  }
  if (sub === 'inspect') {
    const info = await ui.inspect();
    const out = { ...info, targets: (info.targets ?? []).map((t, i) => ({ finestra: i + 1, titolo: showNames ? t.title : `(${t.title.length} caratteri)`, url: t.url.split('?')[0].slice(0, 60) })) };
    if (out.page && !showNames) delete out.page.title;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (sub === 'tray') {
    const view = await ui.readTray();
    if (!view) {
      console.log('Nessun questionario visibile nella finestra Agents.');
      return;
    }
    const out = {
      opzioni: view.options.map((o) => ({ i: o.i, selezionata: o.selected, segnale: o.signal, ...(showTexts ? { badge: o.badge, etichetta: o.label } : {}) })),
      campoLibero: view.freeform,
      primario: view.primary,
      secondario: view.secondary,
      ...(showTexts ? { testo: view.text.slice(0, 600) } : {}),
    };
    if (!showTexts) out.campoLibero = { ...view.freeform, text: view.freeform.text ? '(presente)' : '' };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.error('Uso: npm run cdp -- <status|inspect|tray> [--names] [--texts]');
  process.exitCode = 2;
}

const commands = { pair, status, probe, cdp };
if (!commands[cmd]) {
  console.error('Uso: node src/cli.js <pair|status|probe|cdp> [--names]');
  process.exit(2);
}
await commands[cmd]();
