// Watcher: legge periodicamente il database di Cursor (sola lettura), costruisce lo snapshot delle chat visibili
// e rileva le TRANSIZIONI che meritano una notifica.
//
// Eventi emessi:
//   'snapshot' ({chats, settings, at})  a ogni scansione riuscita
//   'status'   ({ok, lastScanAt, lastError, chats}) quando cambia lo stato di salute
//   'event'    ({type: 'attention'|'done', dedupeKey, chat, attention?, at}) da notificare
//
// Regole (vedi docs/FINDINGS.md sezione 8 e docs/ARCHITECTURE.md):
//  - nessuna notifica dallo stato iniziale: all'avvio le domande piu' vecchie di `startupGraceMs` si segnano
//    come gia' notificate in silenzio, cosi' non partono mai in ritardo;
//  - "chat finita" = la chat era in corso (marcatore `unfinishedRunAt` nell'header, che puo' restare indietro di
//    decine di secondi; lo stato `completed` del composer lo anticipa), poi non lo e' piu' per `doneSettleMs`,
//    senza richieste in attesa (e senza una domanda aperta: una run che finisce con una domanda non e' finita) e
//    senza messaggi in coda, e la run e' durata almeno `minRunMs`;
//  - un'approvazione di tool (FINDINGS 11) si notifica solo se e' ancora in attesa dopo `approvalDelayMs`, riletta
//    ogni secondo: chi approva in pochi secondi dal Mac non riceve una notifica inutile;
//  - dedupe per (composerId, toolCallId) per domande e approvazioni e (composerId, lastUpdatedAt) per le chat finite.
import { EventEmitter } from 'node:events';
import { buildChat, classifyAttention, headerSignature, isPendingQuestion, isPendingReview, isRunning, isVisibleLocalChat } from './cursor/model.js';
import { normalizeQuestionParams } from './cursor/questions.js';
import { errorFields } from './log.js';
import { activityOf, toolActivity, toolStateOf } from './state/present.js';
import { SHELL_TOOLS } from './cursor/model.js';

const SETTINGS_TTL_MS = 10_000;
const BOOST_POLL_MS = 250; // giro del watcher e rilettura della chat dopo un'azione dal telefono
const ERROR_LOG_EVERY_MS = 60_000;

export class Watcher extends EventEmitter {
  #db;
  #resolver;
  #store;
  #cfg;
  #log;
  #now;
  #boost = new Map(); // composerId -> fino a quando (ms) rileggere la chat ogni secondo
  #timer = null;
  #running = false;
  #initial = true;
  #cache = new Map(); // id -> { sig, at, tail, bubble, question, att }
  #mem = new Map(); // id -> { running, runStartedAt, settleSince }
  #announced = new Set();
  #settings = null;
  #settingsAt = 0;
  #removed = new Set(); // workspace dei progetti rimossi dalla sidebar di Cursor
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
      // Per i 2 minuti dopo un'azione dal telefono si guarda 4 volte al secondo (un giro senza riletture profonde costa
      // ~1 ms, misurato su 11 chat): la reazione dell'agente arriva al telefono senza aspettare il prossimo secondo.
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

  /** Rilegge questa chat ogni 250 ms per un po': si chiama dopo una risposta o un messaggio inviati dal telefono. */
  boost(id, ms = 120_000) {
    this.#boost.set(id, Math.max(this.#boost.get(id) ?? 0, this.#now() + ms));
    for (const [k, until] of this.#boost) if (until <= this.#now()) this.#boost.delete(k);
  }

  /** Riemette lo snapshot corrente (es. dopo aver cambiato le chat ignorate). */
  recompute() {
    if (this.#last) this.emit('snapshot', this.#last);
  }

  #setStatus(next) {
    const changed = next.ok !== this.#status.ok || next.lastError !== this.#status.lastError || next.chats !== this.#status.chats;
    this.#status = next;
    if (changed) this.emit('status', next);
  }

  #onError(err, now) {
    // Mai il messaggio dell'errore (puo' contenere percorsi o frammenti di contenuto): solo nome e codice.
    const detail = String(err?.errstr || err?.code || err?.name || 'errore');
    if (now - this.#lastErrorLogAt >= ERROR_LOG_EVERY_MS) {
      this.#lastErrorLogAt = now;
      this.#log.warn('db_unreadable', errorFields(err));
    }
    this.#db.close(); // verra' riaperto al prossimo giro
    this.#setStatus({ ok: false, lastScanAt: this.#status.lastScanAt, lastError: detail.slice(0, 80), chats: this.#status.chats });
  }

  /** Impostazioni della sidebar e progetti rimossi: due chiavi piccole, rilette ogni `SETTINGS_TTL_MS`. */
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
      // lettura fallita: si tiene l'ultimo elenco noto
    }
    this.#settingsAt = now;
    return this.#settings;
  }

  /** Legge "coda" e ultimo bubble di una chat e ne classifica l'attenzione richiesta. */
  #scan(entry, sig, now) {
    let tail = null;
    let bubble = null;
    let prevBubble = null;
    let failed = false;
    try {
      tail = this.#db.composerTail(entry.id);
      bubble = tail?.lastBubble ? this.#db.bubbleSummary(entry.id, tail.lastBubble.id) : null;
      // Cursor cerca l'approvazione in sospeso tra gli ULTIMI DUE bubble: il penultimo si legge solo se l'ultimo non basta.
      if (tail?.prevBubble && !isPendingReview(bubble?.tool) && !isPendingQuestion(bubble?.tool)) {
        prevBubble = this.#db.bubbleSummary(entry.id, tail.prevBubble.id);
      }
    } catch {
      failed = true;
    }
    const running = isRunning(entry.header, now, this.#cfg.staleRunMs) && tail?.status !== 'completed';
    const att = classifyAttention({ entry, tail, bubble, prevBubble, running, now });
    let question = null;
    if (att?.kind === 'domanda' && att.bubbleId) {
      try {
        question = normalizeQuestionParams(this.#db.toolParams(entry.id, att.bubbleId));
      } catch {
        failed = true;
      }
    }
    // Se la lettura e' fallita, riprova al prossimo giro (firma nulla).
    return { sig: failed ? null : sig, at: now, tail, bubble, question, att };
  }

  #processChat(entry, now) {
    const cfg = this.#cfg;
    const h = entry.header || {};
    const ws = this.#resolver.resolve(entry);
    const headerRunning = isRunning(h, now, cfg.staleRunMs);

    let m = this.#mem.get(entry.id);

    // Rilettura "profonda" di OGNI chat visibile: costa 0,5-3 ms a chat (11 ms in tutto per 9 chat, FINDINGS 9.7) e
    // l'header da solo non basta, perche' Cursor lo scrive in ritardo (da +5 s a +60 s dalla domanda). A header
    // invariato si rilegge comunque ogni `fullScanMs`: una domanda nuova compare nel bubble senza che l'header cambi
    // per decine di secondi (FINDINGS 9.1).
    let scan = this.#cache.get(entry.id) ?? null;
    const sig = headerSignature(entry);
    // Un'approvazione appena comparsa e non ancora notificata si rilegge ogni secondo: prima di disturbarti si controlla
    // che sia ancora in attesa (e non gia' approvata dal Mac).
    // Lo stesso vale per una chat a cui si e' appena risposto o scritto dal telefono (`boost`): la prossima domanda o
    // la fine della run si vedono dopo ~0,25 s invece che dopo `fullScanMs`.
    const boosted = (this.#boost.get(entry.id) ?? 0) > now;
    const hot = scan?.att?.kind === 'approvazione' && !this.#announced.has(`a:${entry.id}:${scan.att.key}`);
    const refresh = scan !== null && now - scan.at >= (boosted ? Math.min(cfg.fullScanMs, BOOST_POLL_MS) : hot ? Math.min(cfg.fullScanMs, 1000) : cfg.fullScanMs);
    if (!scan || scan.sig !== sig || refresh) {
      scan = this.#scan(entry, sig, now);
      this.#cache.set(entry.id, scan);
    }

    // L'header e' solo un indizio: puo' restare indietro di decine di secondi o non mostrare affatto una run breve.
    // Lo stato del composer passa a `completed` nell'istante in cui la run finisce (FINDINGS 9.1): e' la conferma.
    const running = headerRunning && scan?.tail?.status !== 'completed';

    if (!m) {
      m = { running: false, runStartedAt: null, settleSince: null, approvalKey: null, approvalSeenAt: null, approvalFirstAt: null };
      if (running) {
        m.running = true;
        // Run gia' in corso all'avvio del daemon: non ne conosciamo l'inizio, la consideriamo "lunga abbastanza".
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

    // 1) Nuova richiesta viva: una domanda (`ask_question`) o un'approvazione (`reviewData` Requested), mai un tool in
    // esecuzione (FINDINGS 9.1, 11). L'approvazione deve restare in attesa per `approvalDelayMs` prima di notificare.
    let ready = true;
    if (attention?.kind === 'approvazione') {
      if (m.approvalKey !== attention.key) {
        m.approvalKey = attention.key;
        m.approvalFirstAt = now;
        // Una richiesta gia' presente all'avvio del daemon non "matura" da capo: vale la regola dello stato iniziale.
        m.approvalSeenAt = this.#initial ? now - cfg.approvalDelayMs : now;
        // Osservazione (solo numeri e booleani, mai contenuti): serve a provare dal vivo che il database contiene davvero
        // `reviewData: Requested` DURANTE l'attesa (FINDINGS 11.4) e a misurare quanto durano le attese.
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
          this.#store.markNotified(dedupeKey, now); // vecchia: la vedi nell'app, ma niente push in ritardo
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

    // 2) Chat finita.
    if (m.settleSince !== null && now - m.settleSince >= cfg.doneSettleMs) {
      const runMs = m.settleSince - (m.runStartedAt ?? m.settleSince);
      m.settleSince = null;
      // Una run che finisce perche' l'agente ha posto una domanda NON e' finita: aspetta l'utente. Il flag nell'header
      // puo' arrivare dopo, quindi si guarda anche direttamente l'ultimo bubble.
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

    // Prima del filtro: l'elenco dei progetti rimossi deve essere aggiornato (rilettura ogni SETTINGS_TTL_MS).
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

  /** Chat archiviate (locali, non sottoagenti, di progetti non rimossi): per "Ripristina". Solo dati di sidebar, niente contenuti. */
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
        name: (typeof entry.header.name === 'string' && entry.header.name.trim()) || 'Senza titolo',
        workspaceName: ws.name,
        sectionId: ws.sectionId,
        lastUpdatedAt: entry.lastUpdatedAt,
      });
    }
    return out;
  }

  /**
   * Una pagina della conversazione per la PWA (sola lettura). Messaggi di utente e assistente con il testo; i tool come
   * semplici righe (tipo di azione e stato, mai comandi ne' percorsi); i bubble senza testo ne' tool si saltano.
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
        const { label, category } = toolActivity(b.tool.name);
        items.push({ id: b.id, index: b.index, at: b.at, role: 'tool', label, category, state: toolStateOf(b.tool.status, b.at, now) });
      } else if (b.text) {
        items.push({ id: b.id, index: b.index, at: b.at, role: b.type === 1 ? 'user' : 'assistant', text: b.text, truncated: b.truncated });
      }
    }
    return { items, from: page.from, total: page.total, hasMore: page.from > 0 };
  }

  /** Dettagli on-demand di una chat: ultimo messaggio dell'assistente e domanda (se c'e'). */
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
        if (att?.kind === 'approvazione' && att.live && att.bubbleId) {
          const shell = SHELL_TOOLS.has(att.toolName);
          approval = { key: att.key, type: toolActivity(att.toolName).label, supported: shell, ...(shell ? this.#db.approvalDetails(id, att.bubbleId) : {}) };
        }
        const a = chat.attention;
        if (!question && a?.toolName === 'ask_question' && a.bubbleId) {
          question = normalizeQuestionParams(this.#db.toolParams(id, a.bubbleId));
        }
      }
    } catch {
      // dettaglio non disponibile: la PWA mostra solo i dati dello snapshot
    }
    return { lastMessage, question, activity, approval };
  }
}
