// Watcher: periodically reads Cursor's database (read-only), builds a snapshot of visible chats,
// and detects TRANSITIONS worth notifying.
//
// Emitted events:
//   'snapshot' ({chats, settings, at})  on every successful scan
//   'status'   ({ok, lastScanAt, lastError, chats}) when health state changes
//   'event'    ({type: 'attention'|'done', dedupeKey, chat, attention?, at}) to notify
//
// Rules (see docs/FINDINGS.md section 8 and docs/ARCHITECTURE.md):
//  - no notifications from initial state: on startup, questions older than `startupGraceMs` are marked
//    as already notified silently, so they never fire late;
//  - "chat done" = chat was running (`unfinishedRunAt` in header, which can lag tens of seconds; composer
//    `completed` state anticipates it), then not running for `doneSettleMs`,
//    with no pending requests (and no open question: a run ending with a question is not done) and
//    no queued messages, and the run lasted at least `minRunMs`;
//  - tool approval (FINDINGS 11) notifies only if still pending after `approvalDelayMs`, rechecked
//    every second: approving within seconds on the Mac avoids a useless notification;
//  - dedupe by (composerId, toolCallId) for questions and approvals and (composerId, lastUpdatedAt) for done chats.
import { EventEmitter } from 'node:events';
import { buildChat, classifyAttention, headerSignature, isPendingQuestion, isPendingReview, isRunning, isVisibleLocalChat } from './cursor/model.js';
import { normalizeQuestionParams } from './cursor/questions.js';
import { errorFields } from './log.js';
import { activityOf, toolActivity, toolStateOf } from './state/present.js';
import { SHELL_TOOLS } from './cursor/model.js';

const SETTINGS_TTL_MS = 10_000;
const BOOST_POLL_MS = 250; // watcher tick and chat re-read after an action from the phone
const ERROR_LOG_EVERY_MS = 60_000;

export class Watcher extends EventEmitter {
  #db;
  #resolver;
  #store;
  #cfg;
  #log;
  #now;
  #boost = new Map(); // composerId -> until (ms) to re-read chat every second
  #timer = null;
  #running = false;
  #initial = true;
  #cache = new Map(); // id -> { sig, at, tail, bubble, question, att }
  #mem = new Map(); // id -> { running, runStartedAt, settleSince }
  #announced = new Set();
  #settings = null;
  #settingsAt = 0;
  #removed = new Set(); // workspaces of projects removed from Cursor sidebar
  #last = null;
  #status = { ok: false, lastScanAt: null, lastError: null, chats: 0 };
  #lastErrorLogAt = 0;

  constructor({ db, resolver, store, config, logger, now = Date.now }) {
    super();
    this.#db = db;
    this.#resolver = resolver;
    this.#store = store;
    this.#cfg = config;
    this.#log = logger;
    this.#now = now;
  }

  get status() {
    return this.#status;
  }

  get last() {
    return this.#last;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    const loop = () => {
      if (!this.#running) return;
      try {
        this.tick();
      } catch (err) {
        this.#log.error('tick_failed', errorFields(err));
      }
      // For 2 minutes after an action from the phone, poll 4 times per second (a tick without deep re-reads costs
      // ~1 ms, measured on 11 chats): agent reaction reaches the phone without waiting for the next second.
      this.#timer = setTimeout(loop, this.#boosted() ? Math.min(BOOST_POLL_MS, this.#cfg.pollMs) : this.#cfg.pollMs);
    };
    loop();
  }

  stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#db.close();
  }

  #boosted() {
    const now = this.#now();
    for (const until of this.#boost.values()) if (until > now) return true;
    return false;
  }

  /** Re-read this chat every 250 ms for a while: called after an answer or message sent from the phone. */
  boost(id, ms = 120_000) {
    this.#boost.set(id, Math.max(this.#boost.get(id) ?? 0, this.#now() + ms));
    for (const [k, until] of this.#boost) if (until <= this.#now()) this.#boost.delete(k);
  }

  /** Re-emits the current snapshot (e.g. after changing ignored chats). */
  recompute() {
    if (this.#last) this.emit('snapshot', this.#last);
  }

  #setStatus(next) {
    const changed = next.ok !== this.#status.ok || next.lastError !== this.#status.lastError || next.chats !== this.#status.chats;
    this.#status = next;
    if (changed) this.emit('status', next);
  }

  #onError(err, now) {
    // Never the error message (may contain paths or content fragments): name and code only.
    const detail = String(err?.errstr || err?.code || err?.name || 'error');
    if (now - this.#lastErrorLogAt >= ERROR_LOG_EVERY_MS) {
      this.#lastErrorLogAt = now;
      this.#log.warn('db_unreadable', errorFields(err));
    }
    this.#db.close(); // reopened on next tick
    this.#setStatus({ ok: false, lastScanAt: this.#status.lastScanAt, lastError: detail.slice(0, 80), chats: this.#status.chats });
  }

  /** Sidebar settings and removed projects: two small keys, re-read every `SETTINGS_TTL_MS`. */
  #readSettings(now) {
    if (this.#settings !== null && now - this.#settingsAt < SETTINGS_TTL_MS) return this.#settings;
    try {
      this.#settings = this.#db.sidebarSettings() ?? {};
    } catch {
      this.#settings = this.#settings ?? {};
    }
    try {
      this.#removed = this.#db.removedWorkspaceIds();
    } catch {
      // read failed: keep last known list
    }
    this.#settingsAt = now;
    return this.#settings;
  }

  /** Reads a chat's "tail" and last bubble and classifies required attention. */
  #scan(entry, sig, now) {
    let tail = null;
    let bubble = null;
    let prevBubble = null;
    let failed = false;
    try {
      tail = this.#db.composerTail(entry.id);
      bubble = tail?.lastBubble ? this.#db.bubbleSummary(entry.id, tail.lastBubble.id) : null;
      // Cursor looks for pending approval among the LAST TWO bubbles: read previous only if last is not enough.
      if (tail?.prevBubble && !isPendingReview(bubble?.tool) && !isPendingQuestion(bubble?.tool)) {
        prevBubble = this.#db.bubbleSummary(entry.id, tail.prevBubble.id);
      }
    } catch {
      failed = true;
    }
    const running = isRunning(entry.header, now, this.#cfg.staleRunMs) && tail?.status !== 'completed';
    const att = classifyAttention({ entry, tail, bubble, prevBubble, running, now });
    let question = null;
    if (att?.kind === 'question' && att.bubbleId) {
      try {
        question = normalizeQuestionParams(this.#db.toolParams(entry.id, att.bubbleId));
      } catch {
        failed = true;
      }
    }
    // If read failed, retry next tick (null signature).
    return { sig: failed ? null : sig, at: now, tail, bubble, question, att };
  }

  #processChat(entry, now) {
    const cfg = this.#cfg;
    const h = entry.header || {};
    const ws = this.#resolver.resolve(entry);
    const headerRunning = isRunning(h, now, cfg.staleRunMs);

    let m = this.#mem.get(entry.id);

    // Deep re-read of EVERY visible chat: costs 0.5-3 ms per chat (11 ms total for 9 chats, FINDINGS 9.7) and
    // header alone is not enough, because Cursor writes it late (from +5 s to +60 s after a question). With unchanged
    // header we still re-read every `fullScanMs`: a new question appears in the bubble without header changing
    // for tens of seconds (FINDINGS 9.1).
    let scan = this.#cache.get(entry.id) ?? null;
    const sig = headerSignature(entry);
    // A newly appeared approval not yet notified is re-read every second: before notifying, verify
    // it is still pending (not already approved on the Mac).
    // Same for a chat just answered or written from the phone (`boost`): next question or
    // run end shows up after ~0.25 s instead of after `fullScanMs`.
    const boosted = (this.#boost.get(entry.id) ?? 0) > now;
    const hot = scan?.att?.kind === 'approval' && !this.#announced.has(`a:${entry.id}:${scan.att.key}`);
    const refresh = scan !== null && now - scan.at >= (boosted ? Math.min(cfg.fullScanMs, BOOST_POLL_MS) : hot ? Math.min(cfg.fullScanMs, 1000) : cfg.fullScanMs);
    if (!scan || scan.sig !== sig || refresh) {
      scan = this.#scan(entry, sig, now);
      this.#cache.set(entry.id, scan);
    }

    // Header is only a hint: can lag tens of seconds or miss a short run entirely.
    // Composer status becomes `completed` the instant the run ends (FINDINGS 9.1): that is the confirmation.
    const running = headerRunning && scan?.tail?.status !== 'completed';

    if (!m) {
      m = { running: false, runStartedAt: null, settleSince: null, approvalKey: null, approvalSeenAt: null, approvalFirstAt: null };
      if (running) {
        m.running = true;
        // Run already in progress at daemon startup: unknown start, treat as "long enough".
        m.runStartedAt = this.#initial ? now - cfg.minRunMs : now;
      }
      this.#mem.set(entry.id, m);
    } else if (running && !m.running) {
      m.running = true;
      m.runStartedAt = now;
      m.settleSince = null;
    } else if (!running && m.running) {
      m.running = false;
      m.settleSince = now;
    }

    let attention = scan?.att ?? null;
    if (attention && scan.question) attention = { ...attention, question: scan.question };

    const chat = buildChat({ entry, ws, attention, now, staleRunMs: cfg.staleRunMs, running });
    const events = [];
    const summary = { id: chat.id, name: chat.name, workspaceName: chat.workspaceName, sectionId: chat.sectionId };

    // 1) New live request: a question (`ask_question`) or approval (`reviewData` Requested), never a running tool
    // (FINDINGS 9.1, 11). Approval must stay pending for `approvalDelayMs` before notify.
    let ready = true;
    if (attention?.kind === 'approval') {
      if (m.approvalKey !== attention.key) {
        m.approvalKey = attention.key;
        m.approvalFirstAt = now;
        // Request already present at daemon startup does not "mature" from zero: initial-state rule applies.
        m.approvalSeenAt = this.#initial ? now - cfg.approvalDelayMs : now;
        // Observation (numbers and booleans only, never content): proves live that the database contains
        // `reviewData: Requested` DURING wait (FINDINGS 11.4) and measures wait duration.
        this.#log.info('approval_seen', {
          ageSec: Math.round((now - attention.since) / 1000),
          running,
          flag: h.hasBlockingPendingActions === true,
          initial: this.#initial,
        });
      }
      ready = now - m.approvalSeenAt >= cfg.approvalDelayMs;
    } else if (m.approvalKey !== null) {
      this.#log.info('approval_gone', { waitedSec: Math.round((now - m.approvalFirstAt) / 1000), notified: this.#announced.has(`a:${chat.id}:${m.approvalKey}`) });
      m.approvalKey = null;
      m.approvalSeenAt = null;
      m.approvalFirstAt = null;
    }
    if (attention?.live && ready) {
      const dedupeKey = `a:${chat.id}:${attention.key}`;
      if (!this.#announced.has(dedupeKey)) {
        this.#announced.add(dedupeKey);
        const recent = now - attention.since <= cfg.startupGraceMs;
        if (this.#initial && !recent) {
          this.#store.markNotified(dedupeKey, now); // old: visible in app, no late push
        } else {
          events.push({
            type: 'attention',
            dedupeKey,
            chat: summary,
            attention: {
              kind: attention.kind,
              toolName: attention.toolName,
              title: attention.question?.title ?? '',
              prompt: attention.question?.questions?.[0]?.prompt ?? '',
            },
            at: now,
            since: attention.since,
          });
        }
      }
    }

    // 2) Chat done.
    if (m.settleSince !== null && now - m.settleSince >= cfg.doneSettleMs) {
      const runMs = m.settleSince - (m.runStartedAt ?? m.settleSince);
      m.settleSince = null;
      // A run that ends because the agent asked a question is NOT done: waiting for user. Header flag
      // may arrive late, so also check the last bubble directly.
      const waiting = attention?.live === true || isPendingQuestion(scan?.bubble?.tool);
      const queued = (scan?.tail?.queueLength ?? 0) > 0;
      if (!waiting && !queued && runMs >= cfg.minRunMs) {
        events.push({ type: 'done', dedupeKey: `d:${chat.id}:${entry.lastUpdatedAt}`, chat: summary, at: now });
      }
    }

    return { chat, events };
  }

  tick() {
    const now = this.#now();
    let entries;
    try {
      if (!this.#db.isOpen) this.#db.open();
      entries = this.#db.listHeaders();
    } catch (err) {
      this.#onError(err, now);
      return;
    }

    // Before filter: removed-project list must be fresh (re-read every SETTINGS_TTL_MS).
    const settings = this.#readSettings(now);
    const visibility = { includeClassic: this.#cfg.includeClassicChats, removedWorkspaceIds: this.#removed };

    const chats = [];
    const events = [];
    const present = new Set();
    for (const entry of entries) {
      if (!isVisibleLocalChat(entry, visibility)) continue;
      present.add(entry.id);
      try {
        const r = this.#processChat(entry, now);
        chats.push(r.chat);
        events.push(...r.events);
      } catch (err) {
        this.#onError(err, now);
        return;
      }
    }
    for (const id of [...this.#mem.keys()]) {
      if (!present.has(id)) {
        this.#mem.delete(id);
        this.#cache.delete(id);
      }
    }

    this.#initial = false;
    this.#last = { chats, settings, at: now };
    this.#setStatus({ ok: true, lastScanAt: now, lastError: null, chats: chats.length });
    this.emit('snapshot', this.#last);
    for (const ev of events) this.emit('event', ev);
  }

  /** Archived chats (local, not subagents, non-removed projects): for "Restore". Sidebar data only, no content. */
  archived({ limit = 40 } = {}) {
    if (!this.#db.isOpen) return [];
    const visibility = { includeClassic: this.#cfg.includeClassicChats, removedWorkspaceIds: this.#removed };
    const out = [];
    for (const entry of this.#db.archivedHeaders(limit)) {
      const asLive = { ...entry, header: { ...entry.header, isArchived: false } };
      if (!isVisibleLocalChat(asLive, visibility)) continue;
      const ws = this.#resolver.resolve(entry);
      out.push({
        id: entry.id,
        name: (typeof entry.header.name === 'string' && entry.header.name.trim()) || '',
        workspaceName: ws.name,
        sectionId: ws.sectionId,
        lastUpdatedAt: entry.lastUpdatedAt,
      });
    }
    return out;
  }

  /**
   * One page of conversation for the PWA (read-only). User and assistant messages with text; tools as
   * simple rows (action type and state, never commands or paths); bubbles with neither text nor tool are skipped.
   * @returns {{ items: object[], from: number, total: number, hasMore: boolean } | null}
   */
  history(id, { before = null, limit = 30 } = {}) {
    if (!this.#last?.chats.some((c) => c.id === id) || !this.#db.isOpen) return null;
    const page = this.#db.conversationPage(id, { before, limit });
    if (!page) return null;
    const now = this.#now();
    const items = [];
    for (const b of page.items) {
      if (b.tool) {
        const { action, category } = toolActivity(b.tool.name);
        items.push({ id: b.id, index: b.index, at: b.at, role: 'tool', action, category, state: toolStateOf(b.tool.status, b.at, now) });
      } else if (b.text) {
        items.push({ id: b.id, index: b.index, at: b.at, role: b.type === 1 ? 'user' : 'assistant', text: b.text, truncated: b.truncated });
      }
    }
    return { items, from: page.from, total: page.total, hasMore: page.from > 0 };
  }

  /** On-demand chat details: last assistant message and question (if any). */
  detail(id) {
    const chat = this.#last?.chats.find((c) => c.id === id);
    if (!chat) return null;
    let lastMessage = null;
    let activity = [];
    let approval = null;
    let question = chat.attention?.question ?? null;
    try {
      if (this.#db.isOpen) {
        lastMessage = this.#db.lastAssistantMessage(id, { maxChars: 4000 });
        activity = activityOf(this.#db.recentActivity(id, { limit: 10 }), this.#now());
        const att = chat.attention;
        if (att?.kind === 'approval' && att.live && att.bubbleId) {
          const shell = SHELL_TOOLS.has(att.toolName);
          approval = { key: att.key, action: toolActivity(att.toolName).action, supported: shell, ...(shell ? this.#db.approvalDetails(id, att.bubbleId) : {}) };
        }
        const a = chat.attention;
        if (!question && a?.toolName === 'ask_question' && a.bubbleId) {
          question = normalizeQuestionParams(this.#db.toolParams(id, a.bubbleId));
        }
      }
    } catch {
      // detail unavailable: PWA shows snapshot data only
    }
    return { lastMessage, question, activity, approval };
  }
}
