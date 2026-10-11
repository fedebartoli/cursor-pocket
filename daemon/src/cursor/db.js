// Accesso in SOLA LETTURA al database di Cursor (state.vscdb, ~17 GB, WAL).
//
// Regole (vedi AGENTS.md):
//  - si apre sempre con readOnly + PRAGMA query_only: scrivere e' impossibile;
//  - non si scansiona mai tutto il database: solo chiavi esatte (composerData:<id>, bubbleId:<id>:<bubble>);
//  - le query sono corte (niente transazioni lunghe) per non bloccare il checkpoint del WAL di Cursor.
//
// Questo e' uno dei moduli che dipendono da dettagli interni di Cursor: se Cursor cambia formato, si aggiorna qui.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { safeJsonParse, toMs } from '../util.js';
import { decodeQuestionBinary } from './questions.js';

const SIDEBAR_KEY = 'cursor/glassSidebarSettings';
// Progetti che l'utente ha RIMOSSO dalla sidebar dell'Agents Window: le loro chat non compaiono piu' li' (FINDINGS 8.2).
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
      // Chat candidate: non archiviate, non sottoagenti, con attivita' (lastUpdatedAt > 0).
      headers: db.prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, recency, value
           FROM composerHeaders
          WHERE COALESCE(isArchived, 0) = 0 AND COALESCE(isSubagent, 0) = 0 AND COALESCE(lastUpdatedAt, 0) > 0`,
      ),
      // Solo la "coda" del composerData: evita di fare il parsing di megabyte in JavaScript.
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
      // Esito di una domanda (`additionalData`: stato, selezioni, testi liberi): serve a verificare le risposte date.
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
      // Riga breve di un bubble per "Attivita' recente": tipo, ora, tool (nome e stato) e le prime righe di testo.
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
      item: db.prepare('SELECT value FROM ItemTable WHERE key = ?'),
    };
  }

  close() {
    if (this.#db) {
      try {
        this.#db.close();
      } catch {
        // gia' chiuso
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

  /** Header delle chat candidate (JSON gia' interpretato). Le righe non leggibili vengono saltate. */
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

  /** Stato sintetico del composerData di una chat (null se non esiste). */
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
      // Il penultimo bubble: Cursor cerca l'approvazione in sospeso tra gli ULTIMI DUE (FINDINGS 11).
      prevBubble: head(prev),
    };
  }

  /** Riassunto di un bubble: tipo, ora e (se e' una tool call) nome/stato. Nessun contenuto. */
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
            // Richiesta di approvazione dell'utente (`reviewData`): `status` None | Requested | Done (FINDINGS 11).
            review: r.reviewStatus ? { status: r.reviewStatus, approvalType: r.reviewType ?? null } : null,
          }
        : null,
    };
  }

  /** Parametri (stringa JSON) di una tool call: serve solo per leggere la domanda di `ask_question`. */
  toolParams(composerId, bubbleId) {
    const r = this.#need().toolParams.get(`bubbleId:${composerId}:${bubbleId}`);
    if (!r) return null;
    if (r.params) return r.params;
    // Domanda appena creata: `params` e' ancora vuoto ma `toolCallBinary` contiene gia' il testo (vedi questions.js).
    return decodeQuestionBinary(r.binary);
  }

  /**
   * Cosa chiede di eseguire un tool in attesa di approvazione: SOLO per i comandi di terminale ({command, description}).
   * Il testo e' quello che l'utente vedrebbe nella carta di Cursor: va mostrato al telefono per decidere con cognizione,
   * ma non entra mai nei log ne' nelle notifiche.
   */
  approvalDetails(composerId, bubbleId, { maxCommand = 2000, maxDescription = 300 } = {}) {
    const r = this.#need().toolParams.get(`bubbleId:${composerId}:${bubbleId}`);
    const p = typeof r?.params === 'string' ? safeJsonParse(r.params, null) : null;
    if (!p || typeof p !== 'object') return {};
    const clip = (v, n) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n - 1)}\u2026` : v) : '');
    return {
      command: clip(p.command, maxCommand),
      description: clip(p.commandDescription, maxDescription),
      // Un comando troncato non si approva da qui: si deciderebbe senza averlo letto tutto.
      truncated: typeof p.command === 'string' && p.command.length > maxCommand,
    };
  }

  /**
   * Esito registrato da Cursor per la domanda di un bubble: `{status, selections, freeform}` (null se il bubble manca).
   * `selections` = {questionId: [optionId | "__freeform_other__"]}, `freeform` = {questionId: testo} (FINDINGS sez. 2).
   */
  questionResult(composerId, bubbleId) {
    const r = this.#need().answerData.get(`bubbleId:${composerId}:${bubbleId}`);
    if (!r) return null;
    return { status: r.status ?? null, selections: safeJsonParse(r.selections, null), freeform: safeJsonParse(r.freeform, null) };
  }

  /** Ultimo messaggio dell'assistente con testo, cercando negli ultimi `lookback` bubble. */
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
   * Gli ultimi `limit` bubble in ordine cronologico (il piu' vecchio per primo): tipo (1 utente, 2 assistente), ora,
   * tool (nome e stato) e un'anteprima del testo. Serve alla sezione "Attivita' recente" della PWA.
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

  /** Impostazioni della sidebar dell'Agents Window (ordine dei gruppi, raggruppamento). */
  sidebarSettings() {
    const r = this.#need().item.get(SIDEBAR_KEY);
    return r ? safeJsonParse(r.value, null) : null;
  }

  /**
   * Id dei workspace dei progetti RIMOSSI dalla sidebar (`workspaceIdentifier.id` di ogni voce di
   * `cursor/glass.removedProjects`). Una chiave assente o illeggibile vale "nessun progetto rimosso".
   * Lo stesso id compare nella colonna `workspaceId` e in `header.workspaceIdentifier.id` delle chat.
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
