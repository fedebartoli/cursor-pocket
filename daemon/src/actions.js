// Azioni dalla PWA verso Cursor (Fase 2): rispondere a una domanda, saltarla, scrivere un messaggio.
//
// Principi (vedi docs/ARCHITECTURE.md, sezione "Azioni"):
//  - si agisce solo su cio' che il daemon vede ORA: la risposta cita la chiave (toolCallId) della domanda che
//    l'utente ha visto; se nel frattempo e' cambiata o e' stata risolta sul Mac, nessuna azione (409 `stale`);
//  - un'azione alla volta (coda): manipolano la stessa finestra di Cursor;
//  - il database di Cursor (sola lettura) e' la fonte di verita': dopo l'azione si rilegge per confermarla;
//  - nessun contenuto di chat nei log: solo tipo di azione, esito e codici.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SHELL_TOOLS } from './cursor/model.js';
import { FREEFORM_ID } from './cursor/questions.js';
import { errorFields } from './log.js';
import { sleep as realSleep } from './util.js';

export class ActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
  }
}

export const LIMITS = Object.freeze({ messageChars: 8000, freeformChars: 4000, nameChars: 100 });

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Testo "pulito": solo `\n` come a capo, niente caratteri di controllo. */
export function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

/**
 * Controlla le risposte dell'utente contro la domanda vera (letta dal database) e le allinea alle domande.
 * @returns {{questionId: string, optionIds: string[], freeform: string}[]}
 */
export function validateAnswers(question, raw) {
  const bad = (msg) => new ActionError(400, 'bad_answer', msg);
  if (!question?.questions?.length) throw bad('Domanda non valida');
  if (!Array.isArray(raw)) throw bad('Risposte mancanti');
  const out = [];
  for (const q of question.questions) {
    const a = raw.find((x) => x && typeof x === 'object' && x.questionId === q.id);
    if (!a) throw bad('Manca la risposta a una domanda');
    const ids = a.optionIds === undefined ? [] : a.optionIds;
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw bad('Opzioni non valide');
    if (new Set(ids).size !== ids.length) throw bad('Opzioni duplicate');
    const freeform = cleanText(a.freeform).trim();
    if (freeform.length > LIMITS.freeformChars) throw bad('Risposta libera troppo lunga');
    const wantsFree = ids.includes(FREEFORM_ID) || freeform.length > 0;
    const regular = ids.filter((i) => i !== FREEFORM_ID);
    if (regular.some((i) => !q.options.some((o) => o.id === i))) throw bad('Opzione sconosciuta');
    if (ids.includes(FREEFORM_ID) && !freeform) throw bad('Scrivi il testo della risposta libera');
    const total = regular.length + (wantsFree ? 1 : 0);
    if (total === 0) throw bad('Scegli almeno una risposta');
    if (!q.allowMultiple && total > 1) throw bad('Questa domanda accetta una sola risposta');
    out.push({ questionId: q.id, optionIds: wantsFree ? [...regular, FREEFORM_ID] : regular, freeform: wantsFree ? freeform : '' });
  }
  if (raw.length > question.questions.length) throw bad('Troppe risposte');
  return out;
}

/** Corrisponde all'esito registrato da Cursor? (insiemi di opzioni e testo libero, per ogni domanda) */
export function answersMatch(result, expected) {
  if (!result?.selections) return false;
  const nrm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return expected.every((e) => {
    const got = result.selections[e.questionId];
    if (!Array.isArray(got)) return false;
    if (got.length !== e.optionIds.length || !e.optionIds.every((i) => got.includes(i))) return false;
    return e.freeform ? nrm(result.freeform?.[e.questionId]) === nrm(e.freeform) : true;
  });
}

/** Errori dell'interfaccia di Cursor -> risposta HTTP comprensibile. Il codice interno non e' mai un contenuto. */
const UI_ERRORS = {
  unavailable: [503, 'actions_unavailable', 'Cursor non e\' raggiungibile con la porta di debug: avvialo come spiegato nelle Impostazioni.'],
  closed: [503, 'actions_unavailable', 'La connessione con Cursor si e\' interrotta. Riprova.'],
  no_window: [503, 'actions_unavailable', 'La finestra Agents di Cursor non e\' aperta.'],
  timeout: [504, 'timeout', 'Cursor non ha risposto in tempo. Controlla sul Mac.'],
  row_not_found: [409, 'chat_not_in_sidebar', 'La chat non e\' visibile nella sidebar di Cursor: aprila sul Mac.'],
  no_tray: [409, 'no_question', 'La domanda non risulta piu\' aperta in Cursor.'],
  tray_closed: [409, 'no_question', 'La domanda e\' stata chiusa in Cursor prima di completarla.'],
  mismatch: [409, 'mismatch', 'La domanda aperta in Cursor non corrisponde a quella che vedi qui: controlla sul Mac.'],
  draft_not_empty: [409, 'draft_not_empty', 'Sul Mac questa chat ha gia\' una bozza nel campo di scrittura: inviala o svuotala prima.'],
  no_approval: [409, 'no_approval', 'La richiesta non risulta piu\' in attesa in Cursor (forse l\'hai gia\' decisa sul Mac).'],
  question_pending: [409, 'question_pending', 'La chat ha una domanda in attesa: rispondi prima a quella.'],
  no_menu_item: [409, 'ui_changed', 'Cursor non mostra la voce di menu attesa: controlla sul Mac.'],
  no_rename_field: [409, 'ui_changed', 'Cursor non ha aperto il campo del nome: controlla sul Mac.'],
  bad_name: [400, 'bad_name', 'Nome non valido.'],
  not_running: [409, 'not_running', 'L\'agente non sta lavorando in Cursor (forse ha gia\' finito).'],
};

function mapUiError(err) {
  if (err instanceof ActionError) return err;
  const code = String(err?.code ?? '');
  const m = UI_ERRORS[code];
  if (m) return new ActionError(m[0], m[1], m[2]);
  return new ActionError(502, 'ui_failed', `Cursor non ha eseguito l'azione (${code || 'errore'}). Controlla sul Mac.`);
}

export class Actions extends EventEmitter {
  #chain = Promise.resolve();
  #inFlight = new Set();
  #recent = new Map(); // `kind:chat:key` -> istante, per non inviare due volte la stessa risposta
  #state = { available: false, reason: 'off' };
  #timer = null;

  /**
   * @param {{ ui: object, db: object, watcher: object, config: object, logger: object, now?: Function, sleep?: Function }} deps
   */
  constructor({ ui, db, watcher, config, logger, now = Date.now, sleep = realSleep }) {
    super();
    this.ui = ui;
    this.db = db;
    this.watcher = watcher;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    if (!config.actionsEnabled) this.#state = { available: false, reason: 'disabled' };
  }

  /** `{available, reason}`; reason: ok | off (porta di debug chiusa) | no_window | disabled. */
  get status() {
    return this.#state;
  }

  #setState(next) {
    if (next.reason === this.#state.reason) return;
    this.#state = next;
    this.emit('change', next);
  }

  /** Controlla se la porta di debug e la finestra Agents rispondono (solo HTTP, leggero). */
  async refresh() {
    if (!this.config.actionsEnabled) return this.#state;
    let reason = 'off';
    try {
      const p = await this.ui.probe();
      if (p.up) reason = (await this.ui.hasWindow()) ? 'ok' : 'no_window';
    } catch {
      reason = 'off';
    }
    this.#setState({ available: reason === 'ok', reason });
    return this.#state;
  }

  start() {
    if (!this.config.actionsEnabled || this.#timer) return;
    this.refresh().catch(() => {});
    this.#timer = setInterval(() => this.refresh().catch(() => {}), this.config.cdpPollMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ------------------------------------------------------------------------------------------------------------
  // infrastruttura: una sola azione alla volta, con scadenza
  // ------------------------------------------------------------------------------------------------------------

  #run(kind, fn) {
    const start = this.now();
    const prev = this.#chain;
    let release;
    this.#chain = new Promise((resolve) => {
      release = resolve;
    });
    const task = (async () => {
      await prev;
      let work;
      try {
        work = Promise.resolve(fn());
      } catch (err) {
        work = Promise.reject(err);
      }
      // La coda si libera solo quando l'azione sotto ha finito DAVVERO (ha scadenze interne): mai due azioni insieme,
      // anche se il chiamante ha gia' ricevuto l'errore di scadenza.
      work.then(release, release);
      let timer;
      const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ActionError(504, 'timeout', 'Cursor non ha risposto in tempo. Controlla sul Mac.')), this.config.actionTimeoutMs);
      });
      try {
        return await Promise.race([work, limit]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return task.then(
      (res) => {
        this.logger.info('action_ok', { kind, ms: this.now() - start, verified: res.verified === true });
        return res;
      },
      (err) => {
        const mapped = mapUiError(err);
        this.logger.warn('action_failed', { kind, errcode: mapped.code, ...(err instanceof ActionError ? {} : errorFields(err)) });
        throw mapped;
      },
    );
  }

  #chat(id) {
    const chat = this.watcher.last?.chats.find((c) => c.id === id);
    if (!chat) throw new ActionError(404, 'not_found', 'Chat non trovata');
    return chat;
  }

  #requireReady() {
    if (!this.config.actionsEnabled) throw new ActionError(503, 'actions_disabled', 'Le azioni sono disattivate nella configurazione del daemon.');
    if (!this.#state.available) throw new ActionError(503, 'actions_unavailable', 'Cursor non e\' raggiungibile con la porta di debug: avvialo come spiegato nelle Impostazioni.');
  }

  /** La stessa richiesta (stessa chat e stessa domanda) non parte due volte, ne' in contemporanea ne' subito dopo. */
  #dedupe(kind, chatId, key, ttlMs = 60_000) {
    const id = `${kind}:${chatId}:${key}`;
    const t = this.#recent.get(id);
    if (this.#inFlight.has(id) || (t !== undefined && this.now() - t < ttlMs)) {
      throw new ActionError(409, 'already_sent', 'Questa richiesta e\' gia\' stata inviata.');
    }
    this.#inFlight.add(id);
    return {
      done: (ok) => {
        this.#inFlight.delete(id);
        if (ok) this.#recent.set(id, this.now());
        for (const [k, v] of this.#recent) if (this.now() - v > 120_000) this.#recent.delete(k);
      },
    };
  }

  /** Domanda "viva" e azionabile di una chat, con la chiave che l'utente ha visto. */
  #liveQuestion(chatId, key) {
    const chat = this.#chat(chatId);
    const a = chat.attention;
    if (!a || a.kind !== 'domanda' || !a.live || a.key !== key) {
      throw new ActionError(409, 'stale', 'La domanda e\' cambiata o e\' gia\' stata risolta: aggiorna e riprova.');
    }
    const question = this.watcher.detail(chatId)?.question;
    if (!question?.questions?.length) throw new ActionError(409, 'no_question', 'Non riesco a leggere la domanda: rispondi dal Mac.');
    return { chat, a, question };
  }

  /** Rilegge il database ogni 400 ms (conta i giri, non l'orologio: stesso risultato e testabile). */
  async #waitFor(fn, timeoutMs) {
    for (let i = 0; ; i++) {
      const v = fn();
      if (v) return v;
      if (i * 400 >= timeoutMs) return null;
      await this.sleep(400);
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // azioni pubbliche
  // ------------------------------------------------------------------------------------------------------------

  /** Risponde alla domanda `key` della chat. `answers`: [{questionId, optionIds?, freeform?}]. */
  async answer(chatId, { key, answers } = {}) {
    if (typeof key !== 'string' || !key) throw new ActionError(400, 'bad_key', 'Chiave non valida');
    this.#requireReady();
    const { a, question } = this.#liveQuestion(chatId, key);
    const expected = validateAnswers(question, answers);
    const slot = this.#dedupe('answer', chatId, key);
    let ok = false;
    try {
      const res = await this.#run('answer', async () => {
        await this.ui.answer({ composerId: chatId, question, answers: expected.map((e) => ({ optionIds: e.optionIds, freeform: e.freeform })) });
        // Conferma dal database: il bubble della domanda passa a `submitted` con le scelte fatte.
        const r = await this.#waitFor(() => {
          const x = this.db.questionResult(chatId, a.bubbleId);
          return x?.status === 'submitted' ? x : null;
        }, 12_000);
        if (!r) return { ok: true, verified: false };
        return answersMatch(r, expected) ? { ok: true, verified: true } : { ok: true, verified: false, warning: 'differs' };
      });
      ok = true;
      this.watcher.boost?.(chatId); // dopo l'azione la chat si rilegge ogni secondo: la reazione dell'agente si vede subito
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Salta la domanda (come il pulsante Skip di Cursor). */
  async skip(chatId, { key } = {}) {
    if (typeof key !== 'string' || !key) throw new ActionError(400, 'bad_key', 'Chiave non valida');
    this.#requireReady();
    const { a, question } = this.#liveQuestion(chatId, key);
    const slot = this.#dedupe('skip', chatId, key);
    let ok = false;
    try {
      const res = await this.#run('skip', async () => {
        await this.ui.skip({ composerId: chatId, question });
        const r = await this.#waitFor(() => {
          const x = this.db.questionResult(chatId, a.bubbleId);
          return x && x.status !== 'pending' ? x : null;
        }, 12_000);
        return { ok: true, verified: Boolean(r) };
      });
      ok = true;
      this.watcher.boost?.(chatId); // dopo l'azione la chat si rilegge ogni secondo: la reazione dell'agente si vede subito
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /**
   * Approva o rifiuta il comando di terminale in attesa (pulsanti "Run" / "Skip" di Cursor). Solo se la richiesta e' ancora
   * quella che l'utente ha visto (`key` = toolCallId) e solo per i comandi di terminale; nei log finiscono la decisione e
   * l'esito, mai il comando.
   */
  async approval(chatId, { key, decision } = {}) {
    if (typeof key !== 'string' || !key) throw new ActionError(400, 'bad_key', 'Chiave non valida');
    if (decision !== 'approve' && decision !== 'reject') throw new ActionError(400, 'bad_decision', 'Decisione non valida');
    if (!this.config.approvalsEnabled) throw new ActionError(503, 'approvals_disabled', 'Approvare dal telefono e\' disattivato nella configurazione del daemon (CP_APPROVALS).');
    this.#requireReady();
    const chat = this.#chat(chatId);
    const a = chat.attention;
    if (!a || a.kind !== 'approvazione' || !a.live || a.key !== key || !a.bubbleId) {
      throw new ActionError(409, 'stale', 'La richiesta e\' cambiata o e\' gia\' stata decisa: aggiorna e riprova.');
    }
    if (!SHELL_TOOLS.has(a.toolName)) {
      throw new ActionError(409, 'unsupported', 'Da qui si possono decidere solo i comandi di terminale: decidi questa richiesta sul Mac.');
    }
    if (decision === 'approve' && this.db.approvalDetails(chatId, a.bubbleId).truncated) {
      throw new ActionError(409, 'command_too_long', 'Il comando e\' troppo lungo per essere letto per intero qui: per eseguirlo usa Cursor sul Mac (puoi comunque rifiutarlo).');
    }
    const slot = this.#dedupe('approval', chatId, key);
    let ok = false;
    try {
      const res = await this.#run('approval', async () => {
        const clicked = await this.ui.approval({ composerId: chatId, bubbleId: a.bubbleId, decision });
        // Conferma: o il bubble cambia (`reviewData.status` non e' piu' `Requested`, il tool non e' piu' `loading`), oppure
        // l'agente prosegue e Cursor non tiene piu' quella richiesta tra gli ultimi bubble (osservato dal vivo dopo "Skip":
        // il vecchio bubble resta `Requested` e ne compaiono di nuovi).
        const r = clicked?.settled === true ? { settled: true } : await this.#waitFor(() => {
          const b = this.db.bubbleSummary(chatId, a.bubbleId);
          if (b?.tool && (b.tool.review?.status !== 'Requested' || b.tool.status !== 'loading')) return b;
          const now = this.watcher.last?.chats.find((c) => c.id === chatId)?.attention;
          return !now || now.key !== key || now.kind !== 'approvazione' ? { moved: true } : null;
        }, 10_000);
        // La carta di Cursor perde i pulsanti appena la decisione e' accettata (`settled`): segnale piu' rapido del database.
        return { ok: true, verified: Boolean(r), decision };
      });
      ok = true;
      this.logger.info('approval_decision', { decision, verified: res.verified === true });
      this.watcher.boost?.(chatId);
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /**
   * Ferma l'agente di una chat che sta lavorando (pulsante "Stop generation" di Cursor). Non cancella nulla: l'agente
   * smette di generare e la conversazione resta. Con una domanda o un'approvazione aperte non serve: si risponde a quelle.
   */
  async stopAgent(chatId) {
    this.#requireReady();
    const chat = this.#chat(chatId);
    if (!chat.running) throw new ActionError(409, 'not_running', 'L\'agente non sta lavorando: forse ha gia\' finito.');
    if (chat.attention?.live && (chat.attention.kind === 'domanda' || chat.attention.kind === 'approvazione')) {
      throw new ActionError(409, 'attention_pending', 'La chat aspetta una tua decisione: rispondi, approva o rifiuta invece di fermarla.');
    }
    const slot = this.#dedupe('stop', chatId, 'stop', 6_000);
    let ok = false;
    try {
      const res = await this.#run('stop', async () => {
        const clicked = await this.ui.stop({ composerId: chatId });
        const r = clicked?.settled === true ? { settled: true } : await this.#waitFor(() => (this.watcher.last?.chats.find((c) => c.id === chatId)?.running === false ? { stopped: true } : null), 8_000);
        return { ok: true, verified: Boolean(r) };
      });
      ok = true;
      this.logger.info('stop_agent', { verified: res.verified === true });
      this.watcher.boost?.(chatId);
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Rinomina la chat nella sidebar di Cursor (come "Rename" dal menu della riga). Il nome si legge poi dal database per conferma. */
  async rename(chatId, { name } = {}) {
    if (typeof name !== 'string') throw new ActionError(400, 'bad_name', 'Scrivi un nome');
    const clean = cleanText(name).replace(/\s+/g, ' ').trim();
    if (!clean) throw new ActionError(400, 'bad_name', 'Scrivi un nome');
    if (clean.length > LIMITS.nameChars) throw new ActionError(400, 'bad_name', `Nome troppo lungo (massimo ${LIMITS.nameChars} caratteri)`);
    this.#requireReady();
    this.#chat(chatId);
    const slot = this.#dedupe('rename', chatId, crypto.createHash('sha1').update(clean).digest('hex').slice(0, 16), 4_000);
    let ok = false;
    try {
      const res = await this.#run('rename', async () => {
        await this.ui.rename({ composerId: chatId, name: clean });
        const r = await this.#waitFor(() => (this.db.chatFlags(chatId)?.name === clean ? true : null), 8_000);
        return { ok: true, verified: Boolean(r) };
      });
      ok = true;
      this.logger.info('rename_chat', { verified: res.verified === true });
      this.watcher.boost?.(chatId);
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Archivia una chat (non una che sta lavorando). */
  async archive(chatId) {
    this.#requireReady();
    const chat = this.#chat(chatId);
    if (chat.running) throw new ActionError(409, 'running', 'L\'agente sta ancora lavorando: fermalo prima di archiviare la chat.');
    const slot = this.#dedupe('archive', chatId, 'archive', 6_000);
    let ok = false;
    try {
      const res = await this.#run('archive', async () => {
        await this.ui.archive({ composerId: chatId });
        const r = await this.#waitFor(() => (this.db.chatFlags(chatId)?.archived === true ? true : null), 8_000);
        return { ok: true, verified: Boolean(r) };
      });
      ok = true;
      this.logger.info('archive_chat', { verified: res.verified === true });
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Ripristina una chat archiviata (solo se risulta tra quelle archiviate e visibili). */
  async restore(chatId) {
    this.#requireReady();
    if (!this.watcher.archived({ limit: 200 }).some((c) => c.id === chatId)) throw new ActionError(404, 'not_found', 'Chat archiviata non trovata');
    const slot = this.#dedupe('restore', chatId, 'restore', 6_000);
    let ok = false;
    try {
      const res = await this.#run('restore', async () => {
        await this.ui.unarchive({ composerId: chatId });
        const r = await this.#waitFor(() => (this.db.chatFlags(chatId)?.archived === false ? true : null), 8_000);
        return { ok: true, verified: Boolean(r) };
      });
      ok = true;
      this.logger.info('restore_chat', { verified: res.verified === true });
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Scrive un messaggio nella chat. Se l'agente sta lavorando decide Cursor (coda o invio immediato, impostazione sua). */
  async sendMessage(chatId, { text } = {}) {
    if (typeof text !== 'string') throw new ActionError(400, 'bad_text', 'Scrivi un messaggio');
    const clean = cleanText(text).trim();
    if (!clean) throw new ActionError(400, 'bad_text', 'Scrivi un messaggio');
    if (clean.length > LIMITS.messageChars) throw new ActionError(400, 'too_long', `Messaggio troppo lungo (massimo ${LIMITS.messageChars} caratteri)`);
    this.#requireReady();
    const chat = this.#chat(chatId);
    if (chat.attention?.kind === 'domanda' && chat.attention.live) {
      throw new ActionError(409, 'question_pending', 'La chat ha una domanda in attesa: rispondi prima a quella.');
    }
    // Con un'approvazione in attesa l'effetto di un nuovo messaggio dipende dalle impostazioni di Cursor (coda oppure
    // "ferma e invia", che annullerebbe il comando in attesa): non si rischia, prima si approva o si rifiuta dal Mac.
    if (chat.attention?.kind === 'approvazione' && chat.attention.live) {
      throw new ActionError(409, 'approval_pending', 'La chat aspetta una tua approvazione in Cursor: approvala o rifiutala dal Mac prima di scrivere.');
    }
    // Un doppio tocco sul pulsante non deve inviare due volte lo stesso testo.
    const slot = this.#dedupe('message', chatId, crypto.createHash('sha1').update(clean).digest('hex').slice(0, 16), 8_000);
    let ok = false;
    try {
      const res = await this.#run('message', async () => {
        const before = this.db.composerTail(chatId);
        await this.ui.sendMessage({ composerId: chatId, text: clean });
        const tail = await this.#waitFor(() => {
          const t = this.db.composerTail(chatId);
          if (!t || !before) return null;
          return t.bubbleCount > before.bubbleCount || t.queueLength > before.queueLength ? t : null;
        }, 12_000);
        return { ok: true, verified: Boolean(tail), queued: Boolean(tail && before && tail.queueLength > before.queueLength) };
      });
      ok = true;
      this.watcher.boost?.(chatId); // dopo l'azione la chat si rilegge ogni secondo: la reazione dell'agente si vede subito
      return res;
    } finally {
      slot.done(ok);
    }
  }
}
