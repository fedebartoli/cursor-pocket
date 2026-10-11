// Configurazione del daemon: tutto da variabili d'ambiente, con default sensati.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function int(env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}: valore numerico non valido`);
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
    // Il daemon ascolta SOLO su loopback: l'esposizione avviene via `tailscale serve`.
    host: '127.0.0.1',
    port: int(env, 'CP_PORT', 8787, { min: 1, max: 65535 }),

    cursorDbPath: env.CP_CURSOR_DB || path.join(cursorUser, 'globalStorage', 'state.vscdb'),
    workspaceStorageDir: env.CP_WORKSPACE_STORAGE || path.join(cursorUser, 'workspaceStorage'),

    dataDir: env.CP_DATA_DIR || path.join(repoRoot, 'daemon', 'data'),
    pwaDir: env.CP_PWA_DIR || path.join(repoRoot, 'pwa'),

    // Polling del database di Cursor.
    pollMs: int(env, 'CP_POLL_MS', 1000, { min: 200, max: 60_000 }),
    // Ogni quanto rileggere in profondita' anche le chat "tranquille".
    fullScanMs: int(env, 'CP_FULL_SCAN_MS', 1000, { min: 500, max: 600_000 }),
    // Una chat torna da "in corso" a ferma: attesa prima di dichiararla finita (evita falsi positivi tra due passi).
    doneSettleMs: int(env, 'CP_DONE_SETTLE_MS', 5000, { min: 0, max: 120_000 }),
    // "Chat finita" si notifica solo se la run e' durata almeno cosi' (evita rumore per risposte di pochi secondi).
    minRunMs: int(env, 'CP_MIN_RUN_SECONDS', 20, { min: 0, max: 3600 }) * 1000,
    // Un marcatore di run piu' vecchio di cosi' si considera residuo (Cursor chiuso durante la run).
    staleRunMs: int(env, 'CP_STALE_RUN_HOURS', 12, { min: 1, max: 24 * 30 }) * 3_600_000,
    // All'avvio le domande piu' recenti di cosi' (e mai notificate) vengono notificate; le altre no.
    startupGraceMs: int(env, 'CP_STARTUP_GRACE_SECONDS', 300, { min: 0, max: 86_400 }) * 1000,
    // Una richiesta di approvazione si notifica solo se e' ancora in attesa dopo cosi' tanto (0 = subito): chi e' al Mac
    // e approva in pochi secondi non riceve una notifica inutile.
    approvalDelayMs: int(env, 'CP_APPROVAL_DELAY_SECONDS', 8, { min: 0, max: 600 }) * 1000,

    // Domande piu' vecchie di cosi' passano da "Need attention" a "In sospeso" (0 = mai).
    pendingAfterMs: hours * 3_600_000,

    // Includere le chat create nell'editor classico (agentLocation nullo).
    includeClassicChats: bool(env, 'CP_INCLUDE_CLASSIC', true),

    // Azioni verso Cursor (Fase 2): richiedono Cursor avviato con `--remote-debugging-port=<cdpPort>` (solo loopback).
    // Senza la porta di debug la PWA resta in sola lettura; il daemon controlla ogni `cdpPollMs` se compare.
    actionsEnabled: bool(env, 'CP_ACTIONS', true),
    // Approvare o rifiutare dal telefono i comandi in attesa (clic su "Run"/"Skip" in Cursor). Piu' delicato delle risposte:
    // si puo' spegnere da solo con CP_APPROVALS=0 lasciando attive risposte e messaggi.
    approvalsEnabled: bool(env, 'CP_APPROVALS', true),
    cdpPort: int(env, 'CP_CDP_PORT', 9222, { min: 1, max: 65535 }),
    cdpPollMs: int(env, 'CP_CDP_POLL_MS', 5000, { min: 500, max: 600_000 }),
    actionTimeoutMs: int(env, 'CP_ACTION_TIMEOUT_SECONDS', 45, { min: 5, max: 300 }) * 1000,
    // Dopo un'azione si riapre la chat che l'utente aveva aperta sul Mac (best-effort).
    restoreSelection: bool(env, 'CP_RESTORE_SELECTION', true),

    // Sicurezza HTTP.
    allowedHosts: list(env, 'CP_ALLOWED_HOSTS'),
    allowedTailscaleLogins: list(env, 'CP_ALLOWED_TS_LOGINS'),
    pairingTtlMs: int(env, 'CP_PAIRING_TTL_MINUTES', 15, { min: 1, max: 24 * 60 }) * 60_000,

    // Web Push: contatto indicato nelle intestazioni VAPID (mailto: o https:).
    vapidSubject: env.CP_VAPID_SUBJECT || 'mailto:cursor-pocket@example.com',

    logLevel: env.CP_LOG_LEVEL || 'info',
  });
}
