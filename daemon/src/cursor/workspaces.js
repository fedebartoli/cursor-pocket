// Resolve chat -> workspace (folder) and Agents Window sidebar section id.
//
// Priority (verified in Phase 0, 35/35 visible chats covered):
//   1. agentLocation.environment.uri
//   2. workspaceIdentifier.uri
//   3. workspaceStorage/<workspaceId>/workspace.json (`folder` field, or `workspace` for multi-root)
//   4. agentLocation.environment.id == "empty-window" -> "home" (window without folder)
//
// Cursor internal detail: kept in `daemon/src/cursor/`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { basenameOf, parentNameOf, safeJsonParse } from '../util.js';
import { stringHash } from './hash.js';

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Extracts a local path from a serialized VS Code URI (object or `file://` string). */
export function uriToPath(uri) {
  if (!uri) return null;
  if (typeof uri === 'string') {
    if (!uri.startsWith('file://')) return null;
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  if (typeof uri === 'object') {
    if (uri.scheme && uri.scheme !== 'file') return null;
    if (typeof uri.path === 'string' && uri.path) return uri.path;
    if (typeof uri.external === 'string') return uriToPath(uri.external);
  }
  return null;
}

/** Section id in "group by workspace" mode: hash of the group key. */
export function sectionIdFor(key) {
  return `__environment_instance_${stringHash(key)}__`;
}

export const HOME_KEY = 'local:home';

export class WorkspaceResolver {
  #dir;
  #ttl;
  #now;
  #cache = new Map();

  constructor({ dir, ttlMs = 60_000, now = Date.now } = {}) {
    this.#dir = dir;
    this.#ttl = ttlMs;
    this.#now = now;
  }

  #fromStorage(workspaceId) {
    if (!this.#dir || !workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) return null;
    const hit = this.#cache.get(workspaceId);
    if (hit && this.#now() - hit.at < this.#ttl) return hit.value;
    let value = null;
    try {
      const raw = fs.readFileSync(path.join(this.#dir, workspaceId, 'workspace.json'), 'utf8');
      const j = safeJsonParse(raw, null);
      if (j && typeof j.folder === 'string') {
        const p = uriToPath(j.folder);
        if (p) value = { path: p, multiRoot: false };
      } else if (j && typeof j.workspace === 'string') {
        const p = uriToPath(j.workspace);
        if (p) value = { path: p, multiRoot: true };
      }
    } catch {
      // missing workspace.json: normal for chats without a folder
    }
    this.#cache.set(workspaceId, { at: this.#now(), value });
    return value;
  }

  /**
   * @param {{workspaceId?: string, header: object}} entry row returned by CursorDb.listHeaders()
   * @returns {{key: string, sectionId: string, path: string|null, name: string, parent: string, home: boolean}}
   */
  resolve(entry) {
    const header = entry.header || {};
    const env = header.agentLocation?.environment || {};
    let p = uriToPath(env.uri);
    let multiRoot = false;
    if (!p) p = uriToPath(header.workspaceIdentifier?.uri);
    if (!p) {
      const st = this.#fromStorage(entry.workspaceId);
      if (st) {
        p = st.path;
        multiRoot = st.multiRoot;
      }
    }
    if (!p) {
      return { key: HOME_KEY, sectionId: sectionIdFor(HOME_KEY), path: null, name: 'Senza cartella', parent: '', home: true };
    }
    const key = `local:path:${p}`;
    let name = basenameOf(p);
    if (multiRoot) name = name.replace(/\.code-workspace$/, '');
    return { key, sectionId: sectionIdFor(key), path: p, name: name || p, parent: parentNameOf(p), home: false };
  }
}
