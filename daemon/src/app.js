// Composizione dei moduli del daemon (usata da index.js e dai test di integrazione).
import path from 'node:path';
import { Actions } from './actions.js';
import { Auth } from './auth.js';
import { KeepAwake } from './awake.js';
import { AgentsUi } from './cursor/agents-ui.js';
import { CursorDb } from './cursor/db.js';
import { WorkspaceResolver } from './cursor/workspaces.js';
import { createHttpServer } from './http/server.js';
import { Hub } from './http/hub.js';
import { errorFields } from './log.js';
import { Notifier } from './push/notifier.js';
import { presentState } from './state/present.js';
import { Store } from './state/store.js';
import { Uploads } from './uploads.js';
import { Watcher } from './watcher.js';

const DAY = 24 * 3_600_000;

/**
 * Stato di salute esposto ai client: volutamente stabile (niente orari), per non causare invii inutili.
 * `actions`: ok (si puo' rispondere) | off (Cursor senza porta di debug) | no_window | disabled.
 */
export function publicStatus(s, actions = 'off') {
  return { ok: s.ok, error: s.lastError ? 'db' : null, actions };
}

/**
 * @param {{ config: object, logger: object, now?: Function, send?: Function, actionsDeps?: { ui?: object, sleep?: Function, awake?: { spawn?: Function, exists?: Function, power?: object } } }} p
 *   `actionsDeps` serve ai test: interfaccia di Cursor finta e attese veloci.
 */
export function createApp({ config, logger, now = Date.now, send, actionsDeps = {} } = {}) {
  const store = new Store(path.join(config.dataDir, 'store.db'));
  const db = new CursorDb(config.cursorDbPath);
  const resolver = new WorkspaceResolver({ dir: config.workspaceStorageDir, now });
  const hub = new Hub();
  const watcher = new Watcher({ db, resolver, store, config, logger, now });
  const auth = new Auth({ store, config, now });
  const notifier = new Notifier({
    store,
    config,
    logger,
    now,
    ...(send ? { send } : {}),
    badge: () => hub.current?.state?.counts?.attention ?? 0,
  });
  const ui = actionsDeps.ui ?? new AgentsUi({ port: config.cdpPort, restoreSelection: config.restoreSelection });
  const uploads = new Uploads({ dir: path.join(config.dataDir, 'uploads'), now });
  const actions = new Actions({ ui, db, watcher, config, logger, uploads, now, ...(actionsDeps.sleep ? { sleep: actionsDeps.sleep } : {}) });
  const awake = new KeepAwake({ store, config, logger, ...(actionsDeps.awake ?? {}) });
  const http = createHttpServer({ config, store, auth, hub, watcher, notifier, actions, awake, uploads, logger, now });

  function publish() {
    const last = watcher.last;
    if (!last) {
      hub.update(null, publicStatus(watcher.status, actions.status.reason));
      return;
    }
    const state = presentState({
      chats: last.chats,
      settings: last.settings,
      ignored: store.ignoredSet(),
      prefs: store.chatPrefs(),
      now: now(),
      pendingAfterMs: config.pendingAfterMs,
    });
    hub.update(state, publicStatus(watcher.status, actions.status.reason));
  }

  watcher.on('snapshot', (snap) => awake.update(snap.chats.filter((c) => c.running).length));
  watcher.on('snapshot', publish);
  watcher.on('status', publish);
  actions.on('change', publish);
  watcher.on('event', (ev) => {
    // Il badge usa lo stato appena pubblicato: l'evento arriva dopo lo snapshot.
    notifier.notify(ev).catch((err) => logger.error('notify_failed', errorFields(err)));
  });

  let maintenance = null;
  function maintain() {
    const t = now();
    store.pruneIgnored(t - 90 * DAY);
    store.prunePrefs?.();
    store.pruneNotified(t - 30 * DAY);
    store.pruneSessions(t - 90 * DAY);
    store.prunePairing(t - DAY);
  }

  return {
    store,
    db,
    hub,
    watcher,
    actions,
    awake,
    auth,
    notifier,
    http,
    async start() {
      maintain();
      maintenance = setInterval(maintain, DAY);
      maintenance.unref();
      await awake.init();
      void notifier.publicKey; // genera le chiavi VAPID al primo avvio
      await http.listen();
      watcher.start();
      actions.start();
    },
    async stop() {
      if (maintenance) clearInterval(maintenance);
      watcher.stop();
      actions.stop();
      await awake.close();
      await http.close();
      uploads.close();
      store.close();
    },
  };
}
