// Synthetic database with the same schema as Cursor's `state.vscdb` (only parts used by the daemon).
// Tests NEVER touch the real database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../../src/config.js';
import { nullLogger } from '../../src/log.js';

export function tmpDir(prefix = 'cp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export class CursorFixture {
  constructor(dir = tmpDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'state.vscdb');
    this.wsDir = path.join(dir, 'workspaceStorage');
    fs.mkdirSync(this.wsDir, { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
        isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT
      );
    `);
    this.chats = new Map();
  }

  close() {
    this.db.close();
  }

  setSidebar(settings) {
    this.db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursor/glassSidebarSettings', JSON.stringify(settings));
  }

  /**
   * Projects removed from the Agents Window sidebar (`cursor/glass.removedProjects`).
   * `workspaceIds`: workspace ids (as in `workspaceIdentifier.id`). A non-array value writes raw text.
   */
  setRemovedProjects(workspaceIds) {
    const value = Array.isArray(workspaceIds)
      ? JSON.stringify(
          workspaceIds.map((id, i) => ({
            type: 'workspace',
            id: `glass-project-${i}-${id}`, // distinct from workspace id, as in Cursor
            name: `Progetto ${i}`,
            repoUrls: [],
            workspaceIdentifier: { id, uri: { $mid: 1, scheme: 'file', path: `/Users/demo/${id}` } },
          })),
        )
      : String(workspaceIds);
    this.db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursor/glass.removedProjects', value);
  }

  /** Writes workspaceStorage/<id>/workspace.json with the `folder` field. */
  setWorkspaceJson(workspaceId, folderPath) {
    const d = path.join(this.wsDir, workspaceId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'workspace.json'), JSON.stringify({ folder: `file://${folderPath}` }));
  }

  /**
   * Creates or updates a chat. `header` overrides fields in the header JSON.
   * Options: path (folder), archived, subagent, location (null for classic chat).
   */
  chat(id, opts = {}) {
    const prev = this.chats.get(id) ?? {};
    const o = { workspaceId: 'ws-1', path: '/Users/demo/app', name: `Chat ${id}`, subtitle: '', createdAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_100_000, ...prev, ...opts };
    o.header = { ...(prev.header ?? {}), ...(opts.header ?? {}) };
    this.chats.set(id, o);
    const location =
      o.location === null
        ? null
        : o.location ?? { type: 'local', status: 'active', environment: { id: `env-${o.workspaceId}`, uri: { $mid: 1, scheme: 'file', path: o.path } } };
    const header = {
      composerId: id,
      name: o.name,
      subtitle: o.subtitle,
      type: 'head',
      unifiedMode: 'agent',
      createdAt: o.createdAt,
      lastUpdatedAt: o.lastUpdatedAt,
      agentLocation: location,
      ...o.header,
    };
    for (const k of Object.keys(header)) if (header[k] === undefined) delete header[k];
    this.db
      .prepare(
        `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(composerId) DO UPDATE SET workspaceId = excluded.workspaceId, createdAt = excluded.createdAt,
           lastUpdatedAt = excluded.lastUpdatedAt, isArchived = excluded.isArchived, isSubagent = excluded.isSubagent,
           recency = excluded.recency, value = excluded.value`,
      )
      .run(id, o.workspaceId, o.createdAt, o.lastUpdatedAt, o.archived ? 1 : 0, o.subagent ? 1 : 0, o.lastUpdatedAt, JSON.stringify(header));
    return this;
  }

  /**
   * Writes composerData + bubble. `bubbles`: [{id, type, createdAt (ms), text?, tool?:{name,status,toolCallId,params?,userDecision?,additionalData?}}]
   * `layout`: how the bubble list is stored. 'legacy' = `composerData.fullConversationHeadersOnly` (Cursor up to 3.25);
   * 'chunked' = empty array there, a `headerLog` and numbered `composerConvHeaders:<id>:<000000>` rows of `chunkSize` headers (3.26).
   * Default: legacy, or whatever `CP_TEST_HEADER_LAYOUT` says (lets the whole suite run against the newer layout).
   */
  conversation(id, bubbles, { status = 'completed', queueItems = [], layout = process.env.CP_TEST_HEADER_LAYOUT || 'legacy', chunkSize = Number(process.env.CP_TEST_CHUNK_SIZE) || 256 } = {}) {
    const headers = bubbles.map((b) => ({ bubbleId: b.id, type: b.type, createdAt: new Date(b.createdAt).toISOString() }));
    const data = { composerId: id, status, fullConversationHeadersOnly: headers, queueItems };
    if (layout === 'chunked') {
      data.fullConversationHeadersOnly = [];
      const chunkCount = Math.ceil(headers.length / chunkSize);
      data.headerLog = { chunkSize, chunkCount, count: headers.length, generation: 'test-generation' };
      for (let c = 0; c < chunkCount; c++) {
        this.db
          .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
          .run(`composerConvHeaders:${id}:${String(c).padStart(6, '0')}`, JSON.stringify(headers.slice(c * chunkSize, (c + 1) * chunkSize)));
      }
    }
    this.db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`composerData:${id}`, JSON.stringify(data));
    for (const b of bubbles) {
      const v = { type: b.type, createdAt: new Date(b.createdAt).toISOString(), text: b.text ?? '' };
      if (b.tool) {
        v.toolFormerData = {
          name: b.tool.name,
          status: b.tool.status,
          toolCallId: b.tool.toolCallId,
          params: typeof b.tool.params === 'string' ? b.tool.params : b.tool.params ? JSON.stringify(b.tool.params) : undefined,
          toolCallBinary: b.tool.binary,
          userDecision: b.tool.userDecision,
          additionalData: b.tool.additionalData,
        };
      }
      this.db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`bubbleId:${id}:${b.id}`, JSON.stringify(v));
    }
    return this;
  }
}

export const QUESTION_PARAMS = {
  title: 'Come procedo?',
  questions: [
    { id: 'q1', prompt: 'Quale approccio preferisci?', options: [{ id: 'a', label: 'Veloce' }, { id: 'b', label: 'Accurato' }], allowMultiple: false },
  ],
};

/**
 * Standard conversation ending with a question.
 * Real lifecycle (FINDINGS 9.1): `status:'loading'` in the first seconds; then `status:'completed'` with
 * `additionalData:{status:'pending'}` while waiting for an answer; `{status:'submitted'}` after answer.
 * `composerStatus`: persisted composer state (`aborted` during run, `completed` when run finishes).
 */
export function askingConversation(fx, id, { toolCallId = 'tc-1', at = 1_700_000_090_000, status = 'loading', additionalData, composerStatus } = {}) {
  fx.conversation(
    id,
    [
      { id: 'b1', type: 1, createdAt: at - 5000, text: 'Fai una cosa' },
      { id: 'b2', type: 2, createdAt: at, tool: { name: 'ask_question', status, toolCallId, params: QUESTION_PARAMS, additionalData } },
    ],
    composerStatus ? { status: composerStatus } : undefined,
  );
}

/**
 * Conversation ending with a command awaiting approval (FINDINGS 11): the tool bubble carries
 * `additionalData.reviewData` with `status: 'Requested'` until the user decides, then `'Done'`.
 * `trailing`: bubbles added after (Cursor looks for approval in the last TWO bubbles).
 */
export function approvingConversation(fx, id, { toolCallId = 'tc-ap', at = 1_700_000_090_000, reviewStatus = 'Requested', toolStatus = 'loading', composerStatus, trailing = [], command = 'echo prova' } = {}) {
  fx.conversation(
    id,
    [
      { id: 'b1', type: 1, createdAt: at - 5000, text: 'Fai una cosa' },
      {
        id: 'b2',
        type: 2,
        createdAt: at,
        tool: {
          name: 'run_terminal_command_v2',
          status: toolStatus,
          toolCallId,
          params: { command },
          additionalData: { reviewData: { status: reviewStatus, approvalType: 'user' } },
        },
      },
      ...trailing,
    ],
    composerStatus ? { status: composerStatus } : undefined,
  );
}

/** Test configuration: temporary paths, minimal intervals, no waits. */
export function testConfig(fx, overrides = {}) {
  const base = loadConfig({
    CP_CURSOR_DB: fx.file,
    CP_WORKSPACE_STORAGE: fx.wsDir,
    CP_DATA_DIR: path.join(fx.dir, 'data'),
    CP_PWA_DIR: path.join(fx.dir, 'pwa'),
    CP_DONE_SETTLE_MS: '0',
  });
  // `cursorAppDirs` points nowhere: tests must not depend on the Cursor installed on the machine running them.
  return Object.freeze({ ...base, doneSettleMs: 0, minRunMs: 20_000, fullScanMs: 0, startupGraceMs: 300_000, cursorAppDirs: [path.join(fx.dir, 'no-cursor-app')], ...overrides });
}

export { nullLogger };
