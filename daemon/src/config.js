// Daemon configuration: everything from environment variables, with sensible defaults.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function int(env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}: invalid numeric value`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function bool(env, name, def) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  return ['1', 'true', 'si', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function list(env, name) {
  return String(env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const cursorUser = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  const hours = int(env, 'CP_PENDING_AFTER_HOURS', 24, { min: 0, max: 24 * 365 });
  return Object.freeze({
    // Daemon listens ONLY on loopback: exposure is via `tailscale serve`.
    host: '127.0.0.1',
    port: int(env, 'CP_PORT', 8787, { min: 1, max: 65535 }),

    cursorDbPath: env.CP_CURSOR_DB || path.join(cursorUser, 'globalStorage', 'state.vscdb'),
    workspaceStorageDir: env.CP_WORKSPACE_STORAGE || path.join(cursorUser, 'workspaceStorage'),

    dataDir: env.CP_DATA_DIR || path.join(repoRoot, 'daemon', 'data'),
    pwaDir: env.CP_PWA_DIR || path.join(repoRoot, 'pwa'),

    // Cursor database polling.
    pollMs: int(env, 'CP_POLL_MS', 1000, { min: 200, max: 60_000 }),
    // How often to deep-rescan even "quiet" chats.
    fullScanMs: int(env, 'CP_FULL_SCAN_MS', 1000, { min: 500, max: 600_000 }),
    // After a chat stops running: wait before declaring it done (avoids false positives between ticks).
    doneSettleMs: int(env, 'CP_DONE_SETTLE_MS', 5000, { min: 0, max: 120_000 }),
    // "Chat done" notifies only if the run lasted at least this long (avoids noise for sub-second replies).
    minRunMs: int(env, 'CP_MIN_RUN_SECONDS', 20, { min: 0, max: 3600 }) * 1000,
    // A run marker older than this is treated as stale (Cursor closed mid-run).
    staleRunMs: int(env, 'CP_STALE_RUN_HOURS', 12, { min: 1, max: 24 * 30 }) * 3_600_000,
    // On startup, questions newer than this (and never notified) get notified; older ones do not.
    startupGraceMs: int(env, 'CP_STARTUP_GRACE_SECONDS', 300, { min: 0, max: 86_400 }) * 1000,
    // Approval requests notify only if still pending after this long (0 = immediately): someone at the Mac
    // who approves in seconds does not get a useless notification.
    approvalDelayMs: int(env, 'CP_APPROVAL_DELAY_SECONDS', 8, { min: 0, max: 600 }) * 1000,

    // Questions older than this move from "Need attention" to "Pending" (0 = never).
    pendingAfterMs: hours * 3_600_000,

    // Include chats created in the classic editor (null agentLocation).
    includeClassicChats: bool(env, 'CP_INCLUDE_CLASSIC', true),

    // Actions toward Cursor (Phase 2): require Cursor started with `--remote-debugging-port=<cdpPort>` (loopback only).
    // Without the debug port the PWA is read-only; the daemon checks every `cdpPollMs` whether it appears.
    actionsEnabled: bool(env, 'CP_ACTIONS', true),
    // Approve or reject pending commands from the phone (Run/Skip clicks in Cursor). More sensitive than replies:
    // can be disabled alone with CP_APPROVALS=0 while replies and messages stay on.
    approvalsEnabled: bool(env, 'CP_APPROVALS', true),
    // Keep Mac awake while an agent works (enabled from Settings): command and grace before turning off.
    keepAwakeCmd: env.CP_KEEP_AWAKE_CMD ?? '/usr/bin/caffeinate', // empty = feature unavailable
    keepAwakeGraceMs: int(env, 'CP_KEEP_AWAKE_GRACE_MS', 120_000, { min: 0, max: 3_600_000 }),
    keepAwakePollMs: int(env, 'CP_KEEP_AWAKE_POLL_MS', 5000, { min: 200, max: 60_000 }),
    // On battery below this level the Mac may sleep again even with "lid closed" enabled.
    keepAwakeMinBattery: int(env, 'CP_KEEP_AWAKE_MIN_BATTERY', 20, { min: 0, max: 100 }),
    keepAwakeBrightnessCmd: env.CP_BRIGHTNESS_CMD ?? path.join(env.CP_DATA_DIR || path.join(repoRoot, 'daemon', 'data'), 'bin', 'cp-brightness'),
    // Compatibility with Cursor: how often the daemon re-checks the database layout and the installed version (read-only).
    compatCheckMs: int(env, 'CP_COMPAT_CHECK_SECONDS', 300, { min: 5, max: 86_400 }) * 1000,
    // Where to look for the Cursor app to read its version (empty = the usual /Applications locations).
    cursorAppDirs: list(env, 'CP_CURSOR_APP'),
    // Phone actions pause themselves after this many consecutive "Cursor's interface changed" failures (0 = never pause)...
    uiPauseFailures: int(env, 'CP_UI_PAUSE_FAILURES', 3, { min: 0, max: 50 }),
    // ...for at least this long; they resume when the page check passes again or Cursor is restarted.
    uiPauseMs: int(env, 'CP_UI_PAUSE_MINUTES', 5, { min: 1, max: 1440 }) * 60_000,
    cdpPort: int(env, 'CP_CDP_PORT', 9222, { min: 1, max: 65535 }),
    cdpPollMs: int(env, 'CP_CDP_POLL_MS', 5000, { min: 500, max: 600_000 }),
    actionTimeoutMs: int(env, 'CP_ACTION_TIMEOUT_SECONDS', 45, { min: 5, max: 300 }) * 1000,
    // After an action, reopen the chat the user had open on the Mac (best-effort).
    restoreSelection: bool(env, 'CP_RESTORE_SELECTION', true),

    // HTTP security.
    allowedHosts: list(env, 'CP_ALLOWED_HOSTS'),
    allowedTailscaleLogins: list(env, 'CP_ALLOWED_TS_LOGINS'),
    pairingTtlMs: int(env, 'CP_PAIRING_TTL_MINUTES', 15, { min: 1, max: 24 * 60 }) * 60_000,

    // Web Push: contact in VAPID headers (mailto: or https:).
    vapidSubject: env.CP_VAPID_SUBJECT || 'mailto:cursor-pocket@example.com',

    logLevel: env.CP_LOG_LEVEL || 'info',
  });
}
