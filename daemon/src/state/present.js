// Presentation: turns "raw" model chats into the PWA payload.
// PURE deterministic function (same input -> same output, no relative times), so the daemon can
// compare snapshots and notify clients only when something actually changed.
import { collapsedIds, orderSections } from '../cursor/sidebar.js';
export const STATES = Object.freeze({
  RUNNING: 'running',
  ATTENTION: 'attention',
  PENDING: 'pending',
  DONE: 'done',
  IDLE: 'idle',
});

export function ignoreKey(chatId, key) {
  return `${chatId}|${key}`;
}

export function attentionLabel(a) {
  switch (a.kind) {
    case 'question':
      return 'Domanda in attesa';
    case 'approval':
      return 'Approvazione richiesta';
    case 'plan':
      return 'Piano in attesa';
    default:
      return 'Richiesta non risolta';
  }
}

/** What a tool asks to approve (TYPE only: never the command or paths). */
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

// [tool names, action code (PWA translates), category (PWA picks icon from category)]
const TOOLS = [
  [['read_file', 'read_file_v2'], 'read_file', 'read'],
  [['edit_file', 'edit_file_v2', 'search_replace', 'write', 'apply_patch', 'multi_edit'], 'edit_file', 'edit'],
  [['delete_file'], 'delete_file', 'delete'],
  [['run_terminal_command_v2', 'run_terminal_cmd', 'run_terminal_command'], 'run_command', 'terminal'],
  [['grep', 'ripgrep', 'ripgrep_raw_search', 'codebase_search', 'semantic_search', 'grep_search'], 'search_code', 'search'],
  [['glob_file_search', 'list_dir', 'file_search', 'list_dir_v2'], 'explore_files', 'search'],
  [['web_search', 'web_fetch'], 'search_web', 'web'],
  [['ask_question'], 'ask_question', 'question'],
  [['create_plan'], 'create_plan', 'plan'],
  [['todo_write'], 'update_todos', 'todo'],
  [['task', 'task_v2'], 'start_subagent', 'agent'],
  [['read_lints'], 'check_errors', 'search'],
  [['mcp', 'call_mcp_tool', 'read_mcp_resource'], 'use_mcp', 'tool'],
];

/** Action code and category for a tool TYPE (never parameters: commands and paths do not leave the daemon). */
export function toolActivity(name) {
  for (const [names, action, category] of TOOLS) if (names.includes(name)) return { action, category };
  return { action: 'other_action', category: 'tool' };
}

/** Approval action TYPE for notifications (Italian text); not sent in the state payload. */
export function toolApprovalAction(toolName) {
  switch (toolName) {
    case 'run_terminal_command_v2':
    case 'run_terminal_cmd':
    case 'run_terminal_command':
      return 'run_command';
    case 'edit_file':
    case 'edit_file_v2':
      return 'edit_file';
    case 'mcp':
    case 'call_mcp_tool':
    case 'read_mcp_resource':
      return 'mcp_tool';
    case 'web_fetch':
      return 'web_request';
    default:
      return 'generic';
  }
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

// A tool stuck "running" for a long time is almost always stale (interrupted chat): do not show as active.
const STALE_RUNNING_MS = 15 * 60_000;
const staleRunning = (state, at, now) => (state === 'running' && at && now - at > STALE_RUNNING_MS ? '' : state);

/** Tool state (done | running | error | stopped | '') accounting for old stale entries. */
export const toolStateOf = (status, at, now) => staleRunning(toolState(status), at, now);

const firstLine = (t, n) => {
  const line = String(t ?? '').split('\n').find((l) => l.trim()) ?? '';
  const s = line.trim().replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
};

/**
 * Recent activity for a chat from bubbles (db.recentActivity), newest to oldest:
 * `{ id (bubble), at, kind: 'user' | 'assistant' | 'tool', category (tools only), action, state, preview }`. Tools show action type only;
 * empty bubbles (no text or tool) are skipped. A tool "running" for more than 15 minutes is no longer treated as active.
 */
export function activityOf(items, now = Date.now()) {
  const out = [];
  for (const b of items ?? []) {
    if (b.tool) {
      const { action, category } = toolActivity(b.tool.name);
      out.push({ id: b.id, at: b.at, kind: 'tool', category, action, state: staleRunning(toolState(b.tool.status), b.at, now), preview: '' });
    } else if (b.text) {
      out.push(
        b.type === 1
          ? { id: b.id, at: b.at, kind: 'user', action: 'message_sent', state: '', preview: firstLine(b.text, 140) }
          : { id: b.id, at: b.at, kind: 'assistant', action: 'agent_reply', state: '', preview: firstLine(b.text, 140) },
      );
    }
  }
  return out.reverse();
}

/**
 * Chat state applying "Ignore" and the "Pending" threshold.
 *
 * A chat that is WORKING is not idle waiting for you: Cursor's flag (`hasBlockingPendingActions`) often stays on
 * from an old question and Cursor shows the dot even while the agent works (FINDINGS 9.1, 9.7).
 * So during a run only a LIVE request counts as attention (open question or approval pending now);
 * stale or unresolved plan become visible again when the run ends.
 */
export function stateOf(chat, { ignored, now, pendingAfterMs }) {
  const a = chat.attention;
  if (a && (a.live || !chat.running)) {
    const isIgnored = ignored.has(ignoreKey(chat.id, a.key));
    const isOld = pendingAfterMs > 0 && now - a.since > pendingAfterMs;
    if (isIgnored) return { state: STATES.PENDING, reason: 'ignored' };
    if (isOld) return { state: STATES.PENDING, reason: 'old' };
    return { state: STATES.ATTENTION, reason: null };
  }
  if (chat.running) return { state: STATES.RUNNING, reason: null };
  if (chat.unread) return { state: STATES.DONE, reason: null };
  return { state: STATES.IDLE, reason: null };
}

function card(chat, label, ctx) {
  const { state, reason } = stateOf(chat, ctx);
  const pref = ctx.prefs?.get(chat.id);
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
    favorite: pref?.favorite === true,
    muted: pref?.muted === true,
    lastUpdatedAt: chat.lastUpdatedAt,
    attention: a
      ? {
          kind: a.kind,
          key: a.key,
          live: a.live,
          since: a.since,
          ...(a.kind === 'approval' ? { approvalAction: toolApprovalAction(a.toolName) } : {}),
          reason,
          title: a.question?.title ?? '',
          prompt: a.question?.questions?.[0]?.prompt?.slice(0, 160) ?? '',
        }
      : null,
  };
}

/**
 * @param {object} p
 * @param {object[]} p.chats      model chats (buildChat + enriched attention)
 * @param {object|null} p.settings Cursor sidebar settings (may be null)
 * @param {Set<string>} p.ignored  ignoreKey(chatId, key) pairs
 * @param {Map<string, {favorite: boolean, muted: boolean}>} [p.prefs] local per-chat prefs
 * @param {number} p.now
 * @param {number} p.pendingAfterMs
 */
export function presentState({ chats, settings, ignored, now, pendingAfterMs, prefs }) {
  const ctx = { ignored, now, pendingAfterMs, prefs };
  const groupBy = 'workspace';

  // Sections by workspace.
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

  // Duplicate names (two folders with the same name): append parent folder.
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
      muted: prefs?.get(`ws:${s.id}`)?.muted === true,
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
