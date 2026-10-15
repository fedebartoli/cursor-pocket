// Daemon module composition (used by index.js and integration tests).
import path from 'node:path';
import { Actions } from './actions.js';
import { Auth } from './auth.js';
import { KeepAwake } from './awake.js';
import { Compat, publicCompat } from './compat.js';
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
 * Health status exposed to clients: intentionally stable (no timestamps), to avoid useless pushes.
 * `actions`: ok (can respond) | off (Cursor without debug port) | no_window | disabled | ui_changed (paused: Cursor's interface changed).
 * `compat`: ok | degraded (Cursor changed how it stores chats). `cursor`: tested | untested | unknown release.
 */
export function publicStatus(s, actions = 'off', compat = { compat: 'ok', cursor: 'unknown' }) {
  return { ok: s.ok, error: s.lastError ? 'db' : null, actions, ...compat };
}

/**
 * @param {{ config: object, logger: object, now?: Function, send?: Function, actionsDeps?: { ui?: object, sleep?: Function, awake?: { spawn?: Function, exists?: Function, power?: object } } }} p
 *   `actionsDeps` for tests: fake Cursor UI and fast sleeps.
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
  const compat = new Compat({ db, watcher, config, logger, now });
  const awake = new KeepAwake({ store, config, logger, ...(actionsDeps.awake ?? {}) });
  const http = createHttpServer({ config, store, auth, hub, watcher, notifier, actions, awake, compat, uploads, logger, now });

  function publish() {
    const last = watcher.last;
    if (!last) {
      hub.update(null, publicStatus(watcher.status, actions.status.reason, publicCompat(compat.status)));
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
    hub.update(state, publicStatus(watcher.status, actions.status.reason, publicCompat(compat.status)));
  }

  watcher.on('snapshot', (snap) => awake.update(snap.chats.filter((c) => c.running).length));
  watcher.on('snapshot', publish);
  watcher.on('status', publish);
  actions.on('change', publish);
  compat.on('change', publish);
  watcher.on('event', (ev) => {
    // Badge uses state just published: event arrives after the snapshot.
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
    compat,
    awake,
    auth,
    notifier,
    http,
    async start() {
      maintain();
      maintenance = setInterval(maintain, DAY);
      maintenance.unref();
      await awake.init();
      void notifier.publicKey; // generate VAPID keys on first startup
      await http.listen();
      watcher.start();
      actions.start();
      compat.start();
    },
    async stop() {
      if (maintenance) clearInterval(maintenance);
      watcher.stop();
      actions.stop();
      compat.stop();
      await awake.close();
      await http.close();
      uploads.close();
      store.close();
    },
  };
}
