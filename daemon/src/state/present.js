// Presentazione: trasforma le chat "grezze" del modello nel payload per la PWA.
// Funzione PURA e deterministica (stesso input -> stesso output, senza orari relativi), cosi' il daemon puo'
// confrontare gli snapshot e notificare i client solo quando qualcosa cambia davvero.
import { collapsedIds, orderSections } from '../cursor/sidebar.js';
export const STATES = Object.freeze({
  RUNNING: 'in_corso',
  ATTENTION: 'attenzione',
  PENDING: 'in_sospeso',
  DONE: 'finita',
  IDLE: 'inattiva',
});

export function ignoreKey(chatId, key) {
  return `${chatId}|${key}`;
}

export function attentionLabel(a) {
  switch (a.kind) {
    case 'domanda':
      return 'Domanda in attesa';
    case 'approvazione':
      return 'Approvazione richiesta';
    case 'piano':
      return 'Piano in attesa';
    default:
      return 'Richiesta non risolta';
  }
}

/** Cosa chiede di approvare un tool (solo il TIPO: mai il comando o i percorsi). */
export function toolActionLabel(toolName) {
  switch (toolName) {
    case 'run_terminal_command_v2':
      return 'Comando da eseguire';
    case 'edit_file':
    case 'edit_file_v2':
      return 'Modifica di un file';
    case 'mcp':
    case 'call_mcp_tool':
    case 'read_mcp_resource':
      return 'Strumento MCP';
    case 'web_fetch':
      return 'Richiesta web';
    default:
      return 'Azione da approvare';
  }
}

// [nomi del tool, etichetta, categoria (la PWA sceglie l'icona dalla categoria)]
const TOOLS = [
  [['read_file', 'read_file_v2'], 'Legge un file', 'read'],
  [['edit_file', 'edit_file_v2', 'search_replace', 'write', 'apply_patch', 'multi_edit'], 'Modifica un file', 'edit'],
  [['delete_file'], 'Elimina un file', 'delete'],
  [['run_terminal_command_v2', 'run_terminal_cmd', 'run_terminal_command'], 'Esegue un comando', 'terminal'],
  [['grep', 'ripgrep', 'ripgrep_raw_search', 'codebase_search', 'semantic_search', 'grep_search'], 'Cerca nel codice', 'search'],
  [['glob_file_search', 'list_dir', 'file_search', 'list_dir_v2'], 'Esplora i file', 'search'],
  [['web_search', 'web_fetch'], 'Cerca sul web', 'web'],
  [['ask_question'], 'Pone una domanda', 'question'],
  [['create_plan'], 'Prepara un piano', 'plan'],
  [['todo_write'], 'Aggiorna le attivit\u00e0', 'todo'],
  [['task', 'task_v2'], 'Avvia un sotto-agente', 'agent'],
  [['read_lints'], 'Controlla gli errori', 'search'],
  [['mcp', 'call_mcp_tool', 'read_mcp_resource'], 'Usa uno strumento MCP', 'tool'],
];

/** Etichetta italiana e categoria del TIPO di azione di un tool (mai i parametri: comandi e percorsi non escono dal daemon). */
export function toolActivity(name) {
  for (const [names, label, category] of TOOLS) if (names.includes(name)) return { label, category };
  return { label: 'Esegue un\u2019azione', category: 'tool' };
}

function toolState(status) {
  switch (status) {
    case 'completed':
      return 'done';
    case 'loading':
    case 'running':
    case 'pending':
      return 'running';
    case 'error':
    case 'failed':
      return 'error';
    case 'cancelled':
    case 'aborted':
    case 'rejected':
      return 'stopped';
    default:
      return '';
  }
}

// Un tool rimasto "in corso" da molto tempo e' quasi sempre un residuo (chat interrotta): non si mostra come attivo.
const STALE_RUNNING_MS = 15 * 60_000;
const staleRunning = (state, at, now) => (state === 'running' && at && now - at > STALE_RUNNING_MS ? '' : state);

const firstLine = (t, n) => {
  const line = String(t ?? '').split('\n').find((l) => l.trim()) ?? '';
  const s = line.trim().replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
};

/**
 * "Attivita' recente" di una chat dai bubble (db.recentActivity), dal piu' recente al piu' vecchio:
 * `{ id (bubble), at, kind: 'user' | 'assistant' | 'tool', category (solo tool), label, state, preview }`. I tool mostrano solo il tipo di azione;
 * i bubble vuoti (senza testo ne' tool) si saltano. Un tool "in corso" da piu' di 15 minuti non e' piu' dato per attivo.
 */
export function activityOf(items, now = Date.now()) {
  const out = [];
  for (const b of items ?? []) {
    if (b.tool) {
      const { label, category } = toolActivity(b.tool.name);
      out.push({ id: b.id, at: b.at, kind: 'tool', category, label, state: staleRunning(toolState(b.tool.status), b.at, now), preview: '' });
    } else if (b.text) {
      out.push(
        b.type === 1
          ? { id: b.id, at: b.at, kind: 'user', label: 'Messaggio inviato', state: '', preview: firstLine(b.text, 140) }
          : { id: b.id, at: b.at, kind: 'assistant', label: 'Risposta dell\u2019agente', state: '', preview: firstLine(b.text, 140) },
      );
    }
  }
  return out.reverse();
}

/**
 * Stato di una chat applicando "Ignora" e la soglia "In sospeso".
 *
 * Una chat che sta LAVORANDO non e' ferma in attesa di te: il flag di Cursor (`hasBlockingPendingActions`) resta spesso
 * acceso da una vecchia domanda e Cursor lo mostra come pallino anche mentre l'agente lavora (FINDINGS 9.1, 9.7).
 * Quindi durante la run conta come attenzione solo una richiesta VIVA (una domanda aperta o un'approvazione in attesa
 * adesso); un residuo o un piano non risolto tornano visibili quando la run finisce.
 */
export function stateOf(chat, { ignored, now, pendingAfterMs }) {
  const a = chat.attention;
  if (a && (a.live || !chat.running)) {
    const isIgnored = ignored.has(ignoreKey(chat.id, a.key));
    const isOld = pendingAfterMs > 0 && now - a.since > pendingAfterMs;
    if (isIgnored) return { state: STATES.PENDING, reason: 'ignorata' };
    if (isOld) return { state: STATES.PENDING, reason: 'vecchia' };
    return { state: STATES.ATTENTION, reason: null };
  }
  if (chat.running) return { state: STATES.RUNNING, reason: null };
  if (chat.unread) return { state: STATES.DONE, reason: null };
  return { state: STATES.IDLE, reason: null };
}

function card(chat, label, ctx) {
  const { state, reason } = stateOf(chat, ctx);
  const a = chat.attention;
  return {
    id: chat.id,
    name: chat.name,
    subtitle: chat.subtitle,
    sectionId: chat.sectionId,
    workspaceName: label,
    state,
    running: chat.running,
    unread: chat.unread,
    mode: chat.mode,
    lastUpdatedAt: chat.lastUpdatedAt,
    attention: a
      ? {
          kind: a.kind,
          key: a.key,
          live: a.live,
          since: a.since,
          label: attentionLabel(a),
          detail: a.kind === 'approvazione' ? toolActionLabel(a.toolName) : '',
          reason,
          title: a.question?.title ?? '',
          prompt: a.question?.questions?.[0]?.prompt?.slice(0, 160) ?? '',
        }
      : null,
  };
}

/**
 * @param {object} p
 * @param {object[]} p.chats      chat del modello (buildChat + attention arricchita)
 * @param {object|null} p.settings impostazioni sidebar di Cursor (puo' essere null)
 * @param {Set<string>} p.ignored  coppie ignoreKey(chatId, key)
 * @param {number} p.now
 * @param {number} p.pendingAfterMs
 */
export function presentState({ chats, settings, ignored, now, pendingAfterMs }) {
  const ctx = { ignored, now, pendingAfterMs };
  const groupBy = 'workspace';

  // Sezioni per workspace.
  const sections = new Map();
  for (const c of chats) {
    let s = sections.get(c.sectionId);
    if (!s) {
      s = { id: c.sectionId, name: c.workspaceName, parent: c.workspaceParent, home: c.workspaceHome, lastUpdatedAt: 0, chats: [] };
      sections.set(c.sectionId, s);
    }
    s.chats.push(c);
    if (c.lastUpdatedAt > s.lastUpdatedAt) s.lastUpdatedAt = c.lastUpdatedAt;
  }

  // Nomi duplicati (due cartelle con lo stesso nome): aggiungo la cartella superiore.
  const byName = new Map();
  for (const s of sections.values()) byName.set(s.name, (byName.get(s.name) || 0) + 1);
  for (const s of sections.values()) {
    s.label = byName.get(s.name) > 1 && s.parent ? `${s.name} (${s.parent})` : s.name;
  }

  const ordered = orderSections([...sections.values()].map((s) => ({ ...s, label: s.label })), settings, groupBy);
  const collapsed = collapsedIds(settings, groupBy);

  const attention = [];
  const pending = [];
  let running = 0;
  const workspaces = ordered.map((s) => {
    const cards = s.chats
      .slice()
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt || (a.id < b.id ? -1 : 1))
      .map((c) => card(c, s.label, ctx));
    let wsAttention = 0;
    let wsRunning = 0;
    for (const k of cards) {
      if (k.state === STATES.ATTENTION) {
        attention.push(k);
        wsAttention++;
      } else if (k.state === STATES.PENDING) {
        pending.push(k);
      }
      if (k.running) wsRunning++;
    }
    running += wsRunning;
    return {
      id: s.id,
      name: s.label,
      home: s.home,
      collapsed: collapsed.has(s.id),
      lastUpdatedAt: s.lastUpdatedAt,
      counts: { attention: wsAttention, running: wsRunning, total: cards.length },
      chats: cards,
    };
  });

  const bySince = (a, b) => b.attention.since - a.attention.since || (a.id < b.id ? -1 : 1);
  attention.sort(bySince);
  pending.sort(bySince);

  return {
    counts: { attention: attention.length, pending: pending.length, running, total: chats.length },
    attention,
    pending,
    workspaces,
  };
}
