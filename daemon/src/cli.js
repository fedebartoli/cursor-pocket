// Service CLI: `npm run pair | status | probe | cdp` (from daemon/).
//
//   pair    generate a one-time pairing code to enter in the PWA on iPhone
//   status  check if the daemon responds and summarize sessions/subscriptions (no chat content)
//   probe   read Cursor database (read-only) and summarize what the daemon would see.
//           By default does NOT print titles or folder names; --names shows workspace names.
//   cdp     action diagnostics (Phase 2): `npm run cdp -- status | inspect | tray [--names|--texts]`.
//           Read-only page inspection: no clicks and no writes to Cursor.
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
  console.log(`  Pairing code:  ${code}`);
  console.log('');
  console.log(`  Valid for ${minutes} minutes (until ${fmtTime(expiresAt)}) and usable once.`);
  console.log("  Enter it on the sign-in screen of the app installed on your iPhone.");
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
  console.log(`Daemon at ${config.host}:${config.port}: ${up ? 'up' : 'NOT reachable'}`);
  try {
    const store = new Store(path.join(config.dataDir, 'store.db'));
    console.log(`Paired devices (sessions): ${store.listSessions().length}`);
    console.log(`Push subscriptions: ${store.countSubscriptions()}`);
    console.log(`Ignored requests: ${store.ignoredSet().size}`);
    store.close();
  } catch (err) {
    console.log(`Local store not readable: ${err.message}`);
  }
  process.exitCode = up ? 0 : 1;
}

async function probe() {
  const showNames = args.includes('--names');
  const db = new CursorDb(config.cursorDbPath);
  try {
    db.open();
  } catch (err) {
    console.error(`Cursor database not readable: ${err.message}`);
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

  console.log(`Visible chats: ${state.counts.total} | need attention: ${state.counts.attention} | pending: ${state.counts.pending} | running: ${state.counts.running}`);
  console.log(`Hidden because project removed from Cursor sidebar: ${hiddenByRemoval}`);
  console.log(`Cursor grouping: ${settings?.groupBy ?? '?'} | group order: ${settings?.sortGroupsBy ?? '?'}`);
  console.log('Groups in sidebar order:');
  state.workspaces.forEach((w, i) => {
    const label = showNames ? w.name : `group ${i + 1}`;
    const kinds = {};
    for (const c of w.chats) if (c.attention) kinds[c.attention.kind] = (kinds[c.attention.kind] || 0) + 1;
    const extra = Object.entries(kinds).map(([k, n]) => `${k}:${n}`).join(' ');
    console.log(`  ${String(i + 1).padStart(2)}. ${label}  chats=${w.chats.length}${w.collapsed ? ' [collapsed]' : ''}${extra ? `  ${extra}` : ''}`);
  });
}

/** Debug port and Agents page diagnostics. Never clicks or writes; texts only with --texts/--names. */
async function cdp() {
  const sub = args.find((a) => !a.startsWith('--')) ?? 'status';
  const showNames = args.includes('--names');
  const showTexts = args.includes('--texts');
  const ui = new AgentsUi({ port: config.cdpPort });
  const p = await ui.probe();
  if (!p.up) {
    console.log(`Debug port ${config.cdpPort}: CLOSED (Cursor was not started with --remote-debugging-port=${config.cdpPort}).`);
    console.log('To enable actions: quit Cursor and reopen with tools/cursor-cdp.sh (see docs/SETUP.md).');
    process.exitCode = 1;
    return;
  }
  if (sub === 'status') {
    const found = await ui.hasWindow();
    console.log(`Debug port ${config.cdpPort}: open (${p.browser ?? 'unknown version'})`);
    console.log(`Agents window: ${found ? 'found' : 'NOT found'}`);
    if (!found) process.exitCode = 1;
    return;
  }
  if (sub === 'inspect') {
    const info = await ui.inspect();
    const out = { ...info, targets: (info.targets ?? []).map((t, i) => ({ finestra: i + 1, titolo: showNames ? t.title : `(${t.title.length} chars)`, url: t.url.split('?')[0].slice(0, 60) })) };
    if (out.page && !showNames) delete out.page.title;
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (sub === 'tray') {
    const view = await ui.readTray();
    if (!view) {
      console.log('No questionnaire visible in the Agents window.');
      return;
    }
    const out = {
      opzioni: view.options.map((o) => ({ i: o.i, selezionata: o.selected, segnale: o.signal, ...(showTexts ? { badge: o.badge, etichetta: o.label } : {}) })),
      campoLibero: view.freeform,
      primario: view.primary,
      secondario: view.secondary,
      ...(showTexts ? { testo: view.text.slice(0, 600) } : {}),
    };
    if (!showTexts) out.campoLibero = { ...view.freeform, text: view.freeform.text ? '(present)' : '' };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.error('Usage: npm run cdp -- <status|inspect|tray> [--names] [--texts]');
  process.exitCode = 2;
}

const commands = { pair, status, probe, cdp };
if (!commands[cmd]) {
  console.error('Usage: node src/cli.js <pair|status|probe|cdp> [--names]');
  process.exit(2);
}
await commands[cmd]();
