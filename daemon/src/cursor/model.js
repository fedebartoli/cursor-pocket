// Domain model: PURE functions that interpret Cursor chat headers and tails.
//
// All rules below were verified in Phase 0 (see docs/FINDINGS.md, section 8):
//  - visible chat = not archived, not subagent, not draft, with activity (lastUpdatedAt > 0),
//    local (null agentLocation = classic chat, `local` or `worktree`);
//  - "Need attention" like Cursor's red dot: hasBlockingPendingActions or hasPendingPlan;
//  - the flag alone does not say what kind of request it is: look at the last bubble. A question (ask_question)
//    is `loading` only for a few seconds: then the agent turn ends and the bubble becomes `completed` with
//    additionalData.status `pending`, but the question stays pending (and the flag on) until answered
//    (`submitted`). So "pending" is decided on additionalData.status, not tool status
//    (live trace, FINDINGS 9.1);
//  - an approval ("allow" for a command, MCP tool, web request...) is a tool bubble with
//    additionalData.reviewData.status === 'Requested', searched like Cursor among the LAST TWO bubbles (FINDINGS 11).
//
// Cursor internal detail: kept in `daemon/src/cursor/`.
import { clampStr } from '../util.js';

/**
 * @param {object} entry row from listHeaders()
 * @param {object} [o]
 * @param {boolean} [o.includeClassic]  also show classic chats (null agentLocation)
 * @param {Set<string>} [o.removedWorkspaceIds]  workspaces of projects removed from the sidebar (CursorDb.removedWorkspaceIds)
 * @returns {boolean} true if the chat should be shown (same definition as the sidebar, see FINDINGS 8.2).
 */
export function isVisibleLocalChat(entry, { includeClassic = true, removedWorkspaceIds } = {}) {
  const h = entry.header || {};
  if (h.isDraft === true || h.isArchived === true || h.isSubagent === true) return false;
  if (!(entry.lastUpdatedAt > 0)) return false;
  // Chats for a project removed from the sidebar do not appear in the Agents Window, even if not archived.
  if (removedWorkspaceIds?.size) {
    if (removedWorkspaceIds.has(entry.workspaceId) || removedWorkspaceIds.has(h.workspaceIdentifier?.id)) return false;
  }
  const loc = h.agentLocation;
  if (loc) return loc.type === 'local' || loc.type === 'worktree';
  return includeClassic;
}

/**
 * A chat is "running" if the header has `unfinishedRunAt` (set by Cursor only while
 * the composer is generating). If too old it is a leftover (Cursor closed mid-run).
 */
export function isRunning(header, now, staleRunMs) {
  const at = header?.unfinishedRunAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return now - at < staleRunMs;
}

/** Signature of header fields that, when changed, require re-reading the chat "tail". */
export function headerSignature(entry) {
  const h = entry.header || {};
  return [
    entry.lastUpdatedAt,
    h.hasBlockingPendingActions === true ? 1 : 0,
    h.hasPendingPlan === true ? 1 : 0,
    h.unfinishedRunAt ?? '',
    h.hasUnreadMessages === true ? 1 : 0,
  ].join('|');
}

/**
 * Question (`ask_question`) still unanswered.
 * Lifecycle observed live: created with tool `loading`; after 5-33 s the bubble becomes `completed` with
 * additionalData.status `pending` (turn finished, question waiting); on answer becomes `submitted`.
 */
export function isPendingQuestion(tool) {
  if (!tool || tool.name !== 'ask_question') return false;
  if (tool.additionalStatus === 'submitted') return false;
  return tool.status === 'loading' || tool.additionalStatus === 'pending';
}

/**
 * How long an unanswered question counts as "just posted" (from bubble creation). Must cover one
 * Cursor header write cycle (60 s) with margin: beyond that, the header flag has arrived.
 */
export const FRESH_QUESTION_MS = 120_000;

const AUTOMATIC_APPROVALS = new Set(['allowlist', 'full_auto']);

/** Value of `reviewData.status` while Cursor shows the approval request to the user (enum: None, Requested, Done). */
export const REVIEW_REQUESTED = 'Requested';

/**
 * Tool awaiting user approval: bubble has `reviewData.status === 'Requested'` (Cursor: "card" with
 * Run/Skip). `reviewData` appears ONLY when review is needed (2 bubbles of 5274 in real data), so the signal
 * is specific: unlike a `loading` tool, a running command never has it (FINDINGS 9.1, 11).
 * Excludes questions (their own path) and plans (`hasPendingPlan` flag, `reviewData` stays `Requested` for hours).
 */
/** Terminal tools: the only ones whose approval we can drive (Cursor `.ui-shell-tool-call` card). */
export const SHELL_TOOLS = new Set(['run_terminal_command_v2', 'run_terminal_command', 'run_terminal_cmd']);

export function isPendingReview(tool) {
  if (!tool?.review) return false;
  if (tool.name === 'ask_question' || tool.name === 'create_plan') return false;
  // Automatic approval (allowlist or "full auto" mode: `approvalType` enum in the bundle): Cursor decides
  // instantly, nobody to wait for. Unknown or missing type does NOT exclude: better an extra notification.
  if (AUTOMATIC_APPROVALS.has(tool.review.approvalType)) return false;
  return tool.review.status === REVIEW_REQUESTED;
}

/**
 * Classifies attention required by a chat. Pure function: no state.
 *
 * @param {object} p
 * @param {object} p.entry          row from listHeaders()
 * @param {object|null} p.tail      CursorDb.composerTail() (may be missing)
 * @param {object|null} p.bubble    CursorDb.bubbleSummary() of the last bubble (may be missing)
 * @param {object|null} [p.prevBubble] CursorDb.bubbleSummary() of the second-to-last bubble (find pending approval)
 * @param {boolean} [p.running]     chat is working now (header + composer state)
 * @param {number} p.now
 * @returns {null | {kind: 'domanda'|'approvazione'|'piano'|'residuo', key: string, live: boolean, since: number,
 *                   toolName: string|null, toolCallId: string|null, bubbleId: string|null}}
 */
export function classifyAttention({ entry, tail, bubble, prevBubble = null, running = false, now }) {
  const h = entry.header || {};
  const flag = h.hasBlockingPendingActions === true;
  const plan = h.hasPendingPlan === true;

  const lastId = tail?.lastBubble?.id ?? null;
  const tool = bubble?.tool ?? null;
  const baseSince = entry.lastUpdatedAt || entry.createdAt || now;

  // The header (where the flag comes from) Cursor writes LATE: observed live +4.8 s and +41 s after the question, because
  // it waits for a general write or the periodic one every 60 s (FINDINGS 9.7). The bubble is immediate: a RECENT
  // unanswered question is live even with flag off, so notification does not wait for the header. Recent only:
  // without the flag an old question may be leftover (e.g. tool stuck `loading` from interrupted run).
  const pending = isPendingQuestion(tool);
  const fresh = pending && typeof bubble?.createdAt === 'number' && now - bubble.createdAt <= FRESH_QUESTION_MS;

  if (pending && (flag || fresh)) {
    // Verified live (FINDINGS 9.1): flag on + last bubble `ask_question` unanswered.
    // Key is toolCallId: stays the same even if Cursor rewrites the bubble (changes `createdAt`).
    return {
      kind: 'domanda',
      key: tool.toolCallId || `b:${lastId}`,
      live: true,
      since: bubble.createdAt ?? baseSince,
      toolName: tool.name,
      toolCallId: tool.toolCallId,
      bubbleId: lastId,
    };
  }
  // Tool approval (FINDINGS 11). NOT from `loading` + missing `userDecision`: disproved live
  // (FINDINGS 9.1: a running command looks the same, 68 false events in 28 minutes). True signal is
  // `reviewData.status === 'Requested'`, searched among the last two bubbles like Cursor. Live if flag is on,
  // chat is working (agent stopped waiting), or just appeared (header is late): a request stuck `Requested` in a
  // idle chat without flag is leftover (e.g. Cursor closed mid-way) and does not count.
  const reviewBubble = isPendingReview(tool) ? bubble : isPendingReview(prevBubble?.tool) ? prevBubble : null;
  if (reviewBubble) {
    const rt = reviewBubble.tool;
    const rid = reviewBubble === bubble ? lastId : (tail?.prevBubble?.id ?? null);
    const freshReview = typeof reviewBubble.createdAt === 'number' && now - reviewBubble.createdAt <= FRESH_QUESTION_MS;
    if (flag || running || freshReview) {
      return {
        kind: 'approvazione',
        key: rt.toolCallId || `b:${rid}`,
        live: true,
        since: reviewBubble.createdAt ?? baseSince,
        toolName: rt.name,
        toolCallId: rt.toolCallId,
        bubbleId: rid,
      };
    }
  }

  if (!flag && !plan) return null;

  if (flag) {
    // Flag on but last bubble is not an open question (e.g. already answered or superseded by other
    // messages, or chat is working): Cursor "stuck" leftover that did not recalculate the flag.
    return {
      kind: 'residuo',
      key: tool?.toolCallId || (lastId ? `b:${lastId}` : 'chat'),
      live: false,
      since: baseSince,
      toolName: tool?.name ?? null,
      toolCallId: tool?.toolCallId ?? null,
      bubbleId: lastId,
    };
  }

  return {
    kind: 'piano',
    key: `plan:${lastId ?? 'chat'}`,
    live: false,
    since: baseSince,
    toolName: null,
    toolCallId: null,
    bubbleId: lastId,
  };
}

/** Public view of a chat (no paths, no raw Cursor data). */
export function buildChat({ entry, ws, attention, now, staleRunMs, running }) {
  const h = entry.header || {};
  return {
    id: entry.id,
    name: clampStr(typeof h.name === 'string' && h.name.trim() ? h.name.trim() : 'Senza titolo', 200),
    subtitle: clampStr(typeof h.subtitle === 'string' ? h.subtitle.trim() : '', 300),
    mode: typeof h.unifiedMode === 'string' ? h.unifiedMode : null,
    sectionId: ws.sectionId,
    workspaceName: ws.name,
    workspaceParent: ws.parent,
    workspaceHome: ws.home,
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
    lastUpdatedAt: entry.lastUpdatedAt,
    unread: h.hasUnreadMessages === true,
    // `running` may come from the watcher (header + composer state); otherwise header only.
    running: typeof running === 'boolean' ? running : isRunning(h, now, staleRunMs),
    attention,
  };
}
