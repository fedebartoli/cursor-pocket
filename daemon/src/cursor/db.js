// READ-ONLY access to Cursor's database (state.vscdb, ~17 GB, WAL).
//
// Rules (see AGENTS.md):
//  - always open with readOnly + PRAGMA query_only: writing is impossible;
//  - never scan the whole database: only exact keys (composerData:<id>, bubbleId:<id>:<bubble>);
//  - queries are short (no long transactions) to avoid blocking Cursor's WAL checkpoint.
//
// One of the modules that depend on Cursor internals: update here when Cursor changes format.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { safeJsonParse, toMs } from '../util.js';
import { decodeQuestionBinary } from './questions.js';

const SIDEBAR_KEY = 'cursor/glassSidebarSettings';
// Projects the user REMOVED from the Agents Window sidebar: their chats no longer appear there (FINDINGS 8.2).
const REMOVED_PROJECTS_KEY = 'cursor/glass.removedProjects';

export class CursorDb {
  #db = null;
  #st = null;

  constructor(dbPath) {
    this.path = dbPath;
  }

  get isOpen() {
    return this.#db !== null;
  }

  open() {
    this.close();
    if (!fs.existsSync(this.path)) {
      const err = new Error('database di Cursor non trovato');
      err.code = 'DB_NOT_FOUND';
      throw err;
    }
    const db = new DatabaseSync(this.path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 1500');
    this.#db = db;
    this.#st = {
      // Candidate chats: not archived, not subagents, with activity (lastUpdatedAt > 0).
      headers: db.prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, recency, value
           FROM composerHeaders
          WHERE COALESCE(isArchived, 0) = 0 AND COALESCE(isSubagent, 0) = 0 AND COALESCE(lastUpdatedAt, 0) > 0`,
      ),
      archived: db.prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, recency, value
           FROM composerHeaders
          WHERE COALESCE(isArchived, 0) = 1 AND COALESCE(isSubagent, 0) = 0 AND COALESCE(lastUpdatedAt, 0) > 0
          ORDER BY lastUpdatedAt DESC LIMIT ?`,
      ),
      // State of ONE chat (archived? name?), to verify archive / restore / rename.
      oneHeader: db.prepare(
        `SELECT COALESCE(isArchived, 0) AS isArchived, COALESCE(json_extract(value, '$.isDraft'), 0) AS isDraft, json_extract(value, '$.name') AS name
           FROM composerHeaders WHERE composerId = ?`,
      ),
      // Only the composerData "tail": avoids parsing megabytes in JavaScript.
      tail: db.prepare(
        `SELECT json_extract(value, '$.status') AS status,
                json_extract(value, '$.fullConversationHeadersOnly[#-1]') AS lastHeader,
                json_extract(value, '$.fullConversationHeadersOnly[#-2]') AS prevHeader,
                json_array_length(value, '$.fullConversationHeadersOnly') AS bubbleCount,
                json_array_length(value, '$.queueItems') AS queueLength
           FROM cursorDiskKV WHERE key = ?`,
      ),
      bubble: db.prepare(
        `SELECT json_extract(value, '$.type') AS type,
                json_extract(value, '$.createdAt') AS createdAt,
                json_extract(value, '$.toolFormerData.name') AS toolName,
                json_extract(value, '$.toolFormerData.status') AS toolStatus,
                json_extract(value, '$.toolFormerData.toolCallId') AS toolCallId,
                json_extract(value, '$.toolFormerData.userDecision') AS userDecision,
                json_extract(value, '$.toolFormerData.additionalData.status') AS additionalStatus,
                json_extract(value, '$.toolFormerData.additionalData.reviewData.status') AS reviewStatus,
                json_extract(value, '$.toolFormerData.additionalData.reviewData.approvalType') AS reviewType
           FROM cursorDiskKV WHERE key = ?`,
      ),
      toolParams: db.prepare(
        `SELECT json_extract(value, '$.toolFormerData.params') AS params,
                json_extract(value, '$.toolFormerData.toolCallBinary') AS binary
           FROM cursorDiskKV WHERE key = ?`,
      ),
      // Outcome of a question (`additionalData`: status, selections, freeform texts): used to verify submitted answers.
      answerData: db.prepare(
        `SELECT json_extract(value, '$.toolFormerData.additionalData.status') AS status,
                json_extract(value, '$.toolFormerData.additionalData.currentSelections') AS selections,
                json_extract(value, '$.toolFormerData.additionalData.freeformTexts') AS freeform
           FROM cursorDiskKV WHERE key = ?`,
      ),
      bubbleText: db.prepare(
        `SELECT json_extract(value, '$.type') AS type,
                json_extract(value, '$.createdAt') AS createdAt,
                substr(json_extract(value, '$.text'), 1, ?) AS text
           FROM cursorDiskKV WHERE key = ?`,
      ),
      // Brief bubble row for "Recent activity": type, time, tool (name and status) and first lines of text.
      brief: db.prepare(
        `SELECT json_extract(value, '$.type') AS type,
                json_extract(value, '$.createdAt') AS createdAt,
                json_extract(value, '$.toolFormerData.name') AS toolName,
                json_extract(value, '$.toolFormerData.status') AS toolStatus,
                substr(json_extract(value, '$.text'), 1, ?) AS text
           FROM cursorDiskKV WHERE key = ?`,
      ),
      bubbleIds: db.prepare(
        `SELECT json_extract(j.value, '$.bubbleId') AS bubbleId, json_extract(j.value, '$.type') AS type
           FROM cursorDiskKV AS c, json_each(c.value, '$.fullConversationHeadersOnly') AS j
          WHERE c.key = ? AND j.key >= ?`,
      ),
      bubbleIdsRange: db.prepare(
        `SELECT json_extract(j.value, '$.bubbleId') AS bubbleId, json_extract(j.value, '$.type') AS type
           FROM cursorDiskKV AS c, json_each(c.value, '$.fullConversationHeadersOnly') AS j
          WHERE c.key = ? AND j.key >= ? AND j.key < ?
          ORDER BY j.key`,
      ),
      item: db.prepare('SELECT value FROM ItemTable WHERE key = ?'),
    };
  }

  close() {
    if (this.#db) {
      try {
        this.#db.close();
      } catch {
        // already closed
      }
    }
    this.#db = null;
    this.#st = null;
  }

  #need() {
    if (!this.#db) {
      const err = new Error('database di Cursor non aperto');
      err.code = 'DB_NOT_OPEN';
      throw err;
    }
    return this.#st;
  }

  /** Headers of candidate chats (JSON already parsed). Unreadable rows are skipped. */
  listHeaders() {
    const rows = this.#need().headers.all();
    const out = [];
    for (const r of rows) {
      const header = safeJsonParse(r.value, null);
      if (!header || typeof header !== 'object') continue;
      out.push({
        id: r.composerId,
        workspaceId: r.workspaceId,
        createdAt: r.createdAt ?? null,
        lastUpdatedAt: r.lastUpdatedAt ?? 0,
        recency: r.recency ?? 0,
        header,
      });
    }
    return out;
  }

  /** Archived chats (most recent first), like `listHeaders` but inverted. */
  archivedHeaders(limit = 40) {
    const out = [];
    for (const r of this.#need().archived.all(limit)) {
      const header = safeJsonParse(r.value, null);
      if (!header || typeof header !== 'object') continue;
      out.push({ id: r.composerId, workspaceId: r.workspaceId, createdAt: r.createdAt ?? null, lastUpdatedAt: r.lastUpdatedAt ?? 0, recency: r.recency ?? 0, header });
    }
    return out;
  }

  /** `{ archived, name }` for a chat (null if missing). */
  chatFlags(composerId) {
    const r = this.#need().oneHeader.get(composerId);
    return r ? { archived: r.isArchived === 1, draft: r.isDraft === 1, name: typeof r.name === 'string' ? r.name : null } : null;
  }

  /** Summary state of a chat's composerData (null if missing). */
  composerTail(composerId) {
    const r = this.#need().tail.get(`composerData:${composerId}`);
    if (!r) return null;
    const last = safeJsonParse(r.lastHeader, null);
    const prev = safeJsonParse(r.prevHeader, null);
    const head = (h) => (h && h.bubbleId ? { id: h.bubbleId, type: h.type ?? null, createdAt: toMs(h.createdAt) } : null);
    return {
      status: r.status ?? null,
      bubbleCount: r.bubbleCount ?? 0,
      queueLength: r.queueLength ?? 0,
      lastBubble: head(last),
      // Second-to-last bubble: Cursor looks for pending approval among the LAST TWO (FINDINGS 11).
      prevBubble: head(prev),
    };
  }

  /** Bubble summary: type, time and (if tool call) name/status. No content. */
  bubbleSummary(composerId, bubbleId) {
    const r = this.#need().bubble.get(`bubbleId:${composerId}:${bubbleId}`);
    if (!r) return null;
    return {
      type: r.type ?? null,
      createdAt: toMs(r.createdAt),
      tool: r.toolName
        ? {
            name: r.toolName,
            status: r.toolStatus ?? null,
            toolCallId: r.toolCallId ?? null,
            userDecision: r.userDecision ?? null,
            additionalStatus: r.additionalStatus ?? null,
            // User approval request (`reviewData`): `status` None | Requested | Done (FINDINGS 11).
            review: r.reviewStatus ? { status: r.reviewStatus, approvalType: r.reviewType ?? null } : null,
          }
        : null,
    };
  }

  /** Tool call params (JSON string): used only to read `ask_question` questions. */
  toolParams(composerId, bubbleId) {
    const r = this.#need().toolParams.get(`bubbleId:${composerId}:${bubbleId}`);
    if (!r) return null;
    if (r.params) return r.params;
    // Question just created: `params` is still empty but `toolCallBinary` already has the text (see questions.js).
    return decodeQuestionBinary(r.binary);
  }

  /**
   * What a tool pending approval asks to run: ONLY for terminal commands ({command, description}).
   * Text is what the user would see on Cursor's card: show on the phone for an informed decision,
   * but never in logs or notifications.
   */
  approvalDetails(composerId, bubbleId, { maxCommand = 2000, maxDescription = 300 } = {}) {
    const r = this.#need().toolParams.get(`bubbleId:${composerId}:${bubbleId}`);
    const p = typeof r?.params === 'string' ? safeJsonParse(r.params, null) : null;
    if (!p || typeof p !== 'object') return {};
    const clip = (v, n) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n - 1)}\u2026` : v) : '');
    return {
      command: clip(p.command, maxCommand),
      description: clip(p.commandDescription, maxDescription),
      // A truncated command is not approved from here: decision without reading it all.
      truncated: typeof p.command === 'string' && p.command.length > maxCommand,
    };
  }

  /**
   * Outcome recorded by Cursor for a bubble's question: `{status, selections, freeform}` (null if bubble missing).
   * `selections` = {questionId: [optionId | "__freeform_other__"]}, `freeform` = {questionId: text} (FINDINGS sec. 2).
   */
  questionResult(composerId, bubbleId) {
    const r = this.#need().answerData.get(`bubbleId:${composerId}:${bubbleId}`);
    if (!r) return null;
    return { status: r.status ?? null, selections: safeJsonParse(r.selections, null), freeform: safeJsonParse(r.freeform, null) };
  }

  /** Last assistant message with text, searching the last `lookback` bubbles. */
  lastAssistantMessage(composerId, { lookback = 40, maxChars = 1200 } = {}) {
    const st = this.#need();
    const tail = st.tail.get(`composerData:${composerId}`);
    if (!tail || !tail.bubbleCount) return null;
    const from = Math.max(0, tail.bubbleCount - lookback);
    const ids = st.bubbleIds.all(`composerData:${composerId}`, from);
    for (let i = ids.length - 1; i >= 0; i--) {
      if (ids[i].type !== 2) continue;
      const b = st.bubbleText.get(maxChars, `bubbleId:${composerId}:${ids[i].bubbleId}`);
      const text = (b?.text ?? '').trim();
      if (text) return { text, createdAt: toMs(b.createdAt) };
    }
    return null;
  }

  /**
   * The last `limit` bubbles in chronological order (oldest first): type (1 user, 2 assistant), time,
   * tool (name and status) and a text preview. Used by the PWA "Recent activity" section.
   */
  recentActivity(composerId, { limit = 8, maxChars = 200 } = {}) {
    const st = this.#need();
    const tail = st.tail.get(`composerData:${composerId}`);
    if (!tail || !tail.bubbleCount) return [];
    const ids = st.bubbleIds.all(`composerData:${composerId}`, Math.max(0, tail.bubbleCount - limit));
    const out = [];
    for (const { bubbleId, type } of ids) {
      const r = st.brief.get(maxChars, `bubbleId:${composerId}:${bubbleId}`);
      if (!r) continue;
      out.push({
        id: bubbleId,
        type: r.type ?? type ?? null,
        at: toMs(r.createdAt),
        tool: r.toolName ? { name: r.toolName, status: r.toolStatus ?? null } : null,
        text: String(r.text ?? '').trim(),
      });
    }
    return out;
  }

  /**
   * A page of the conversation (read-only), from the bottom upward: the `limit` bubbles before index `before`
   * (default: end), chronological order. Each item: index, type, time, tool (name and status) and text (clipped to `maxChars`).
   * Query by index only: never read the full conversation.
   * @returns {{ total: number, from: number, items: object[] } | null}
   */
  conversationPage(composerId, { before = null, limit = 30, maxChars = 6000 } = {}) {
    const st = this.#need();
    const tail = st.tail.get(`composerData:${composerId}`);
    if (!tail) return null;
    const total = tail.bubbleCount ?? 0;
    const end = Math.max(0, Math.min(total, Number.isInteger(before) ? before : total));
    const from = Math.max(0, end - limit);
    const items = [];
    if (end > from) {
      const ids = st.bubbleIdsRange.all(`composerData:${composerId}`, from, end);
      ids.forEach(({ bubbleId, type }, i) => {
        const r = st.brief.get(maxChars + 1, `bubbleId:${composerId}:${bubbleId}`);
        if (!r) return;
        const text = String(r.text ?? '').trim();
        items.push({
          id: bubbleId,
          index: from + i,
          type: r.type ?? type ?? null,
          at: toMs(r.createdAt),
          tool: r.toolName ? { name: r.toolName, status: r.toolStatus ?? null } : null,
          text: text.slice(0, maxChars),
          truncated: text.length > maxChars,
        });
      });
    }
    return { total, from, items };
  }

  /** Agents Window sidebar settings (group order, grouping). */
  sidebarSettings() {
    const r = this.#need().item.get(SIDEBAR_KEY);
    return r ? safeJsonParse(r.value, null) : null;
  }

  /**
   * Workspace ids of projects REMOVED from the sidebar (`workspaceIdentifier.id` of each entry in
   * `cursor/glass.removedProjects`). Missing or unreadable key means "no removed projects".
   * The same id appears in column `workspaceId` and in `header.workspaceIdentifier.id` on chats.
   */
  removedWorkspaceIds() {
    const r = this.#need().item.get(REMOVED_PROJECTS_KEY);
    const list = r ? safeJsonParse(r.value, null) : null;
    const ids = new Set();
    if (!Array.isArray(list)) return ids;
    for (const p of list) {
      const id = p?.workspaceIdentifier?.id;
      if (typeof id === 'string' && id) ids.add(id);
    }
    return ids;
  }
}
