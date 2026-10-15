// Actions from the PWA to Cursor (Phase 2): answer a question, skip it, send a message.
//
// Principles (see docs/ARCHITECTURE.md, "Azioni" section):
//  - act only on what the daemon sees NOW: the answer references the key (toolCallId) of the question the
//    user saw; if it changed or was resolved on the Mac in the meantime, no action (409 `stale`);
//  - one action at a time (queue): they manipulate the same Cursor window;
//  - Cursor's database (read-only) is the source of truth: after the action it is re-read to confirm;
//  - no chat content in logs: only action type, outcome, and codes.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SHELL_TOOLS } from './cursor/model.js';
import { FREEFORM_ID } from './cursor/questions.js';
import { errorFields } from './log.js';
import { UPLOAD_LIMITS } from './uploads.js';
import { sleep as realSleep } from './util.js';

export class ActionError extends Error {
  constructor(status, code, message, opts = {}) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
    if (opts.detail) this.detail = opts.detail;
    if (opts.params && Object.keys(opts.params).length) this.params = opts.params;
  }
}

export const LIMITS = Object.freeze({ messageChars: 8000, freeformChars: 4000, nameChars: 100 });

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** "Clean" text: only `\n` as line breaks, no control characters. */
export function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

/**
 * Validates user answers against the real question (read from the database) and aligns them to the questions.
 * @returns {{questionId: string, optionIds: string[], freeform: string}[]}
 */
export function validateAnswers(question, raw) {
  const bad = (detail, message, params) => {
    throw new ActionError(400, 'bad_answer', message, { detail, ...(params ? { params } : {}) });
  };
  if (!question?.questions?.length) throw bad('bad_answer_invalid_question', 'Invalid question.');
  if (!Array.isArray(raw)) throw bad('bad_answer_missing', 'Answers missing.');
  const out = [];
  for (const q of question.questions) {
    const a = raw.find((x) => x && typeof x === 'object' && x.questionId === q.id);
    if (!a) throw bad('bad_answer_missing_question', 'A question was not answered.');
    const ids = a.optionIds === undefined ? [] : a.optionIds;
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw bad('bad_answer_invalid_options', 'Invalid options.');
    if (new Set(ids).size !== ids.length) throw bad('bad_answer_duplicate_options', 'Duplicate options.');
    const freeform = cleanText(a.freeform).trim();
    if (freeform.length > LIMITS.freeformChars) throw bad('bad_answer_freeform_too_long', 'Free-form answer is too long.');
    const wantsFree = ids.includes(FREEFORM_ID) || freeform.length > 0;
    const regular = ids.filter((i) => i !== FREEFORM_ID);
    if (regular.some((i) => !q.options.some((o) => o.id === i))) throw bad('bad_answer_unknown_option', 'Unknown option.');
    if (ids.includes(FREEFORM_ID) && !freeform) throw bad('bad_answer_freeform_required', 'Enter the free-form answer text.');
    const total = regular.length + (wantsFree ? 1 : 0);
    if (total === 0) throw bad('bad_answer_no_selection', 'Select at least one answer.');
    if (!q.allowMultiple && total > 1) throw bad('bad_answer_single_only', 'This question accepts only one answer.');
    out.push({ questionId: q.id, optionIds: wantsFree ? [...regular, FREEFORM_ID] : regular, freeform: wantsFree ? freeform : '' });
  }
  if (raw.length > question.questions.length) throw bad('bad_answer_too_many', 'Too many answers.');
  return out;
}

/** Does this match the outcome recorded by Cursor? (option sets and freeform text, per question) */
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

/** Cursor UI errors -> understandable HTTP response. The internal code is never content. */
const UI_ERRORS = {
  unavailable: [503, 'actions_unavailable', 'Cursor is not reachable on the debug port: start it as explained in Settings.'],
  closed: [503, 'actions_unavailable', 'The connection to Cursor was lost. Try again.'],
  no_window: [503, 'actions_unavailable', 'The Cursor Agents window is not open.'],
  timeout: [504, 'timeout', 'Cursor did not respond in time. The action may still have succeeded: check on your Mac before retrying.'],
  no_branch_menu: [409, 'ui_changed', 'Cursor is not showing the branch menu: check on your Mac.'],
  no_model_menu: [409, 'ui_changed', 'Cursor is not showing the model menu: check on your Mac.'],
  branch_not_found: [409, 'branch_not_found', 'That branch is no longer in Cursor\u2019s list: refresh your choices.'],
  model_not_found: [409, 'model_not_found', 'That model is no longer in Cursor\u2019s list: refresh your choices.'],
  branch_failed: [409, 'branch_failed', 'Cursor did not change the branch: check on your Mac.'],
  model_failed: [409, 'model_failed', 'Cursor did not change the model: check on your Mac.'],
  pin_failed: [409, 'pin_failed', 'Cursor did not change the pin state: check on your Mac.'],
  bad_pin: [400, 'bad_pin', 'Invalid value.'],
  chat_not_open: [409, 'ui_changed', 'Cursor did not open this chat: nothing was typed. Try again.'],
  row_not_found: [409, 'chat_not_in_sidebar', 'The chat is not visible in Cursor\u2019s sidebar: open it on your Mac.'],
  no_tray: [409, 'no_question', 'The question is no longer open in Cursor.'],
  tray_closed: [409, 'no_question', 'The question was closed in Cursor before it was completed.'],
  mismatch: [409, 'mismatch', 'The question open in Cursor does not match what you see here: check on your Mac.'],
  draft_not_empty: [409, 'draft_not_empty', 'This chat already has a draft in the composer on your Mac: send or clear it first.'],
  no_approval: [409, 'no_approval', 'The request is no longer pending in Cursor (you may have already decided on your Mac).'],
  question_pending: [409, 'question_pending', 'This chat has a pending question: answer it first.'],
  approval_pending: [409, 'approval_pending', 'This chat is waiting for your approval in Cursor: approve or reject on your Mac before writing.'],
  no_menu_item: [409, 'ui_changed', 'Cursor is not showing the expected menu item: check on your Mac.'],
  no_rename_field: [409, 'ui_changed', 'Cursor did not open the name field: check on your Mac.'],
  no_file_input: [409, 'ui_changed', 'Cursor is not showing the attachment field: check on your Mac.'],
  attach_failed: [409, 'attach_failed', 'Cursor did not accept the images: retry or attach them on your Mac.'],
  project_not_found: [409, 'project_not_found', 'Cursor is not showing this project in the sidebar (removed or renamed?): check on your Mac.'],
  project_ambiguous: [409, 'project_ambiguous', 'Cursor has several projects with this name: start the chat on your Mac.'],
  wrong_project: [409, 'ui_changed', 'Cursor opened the chat on another project: no message was sent.'],
  not_local: [409, 'not_local', 'The new chat in Cursor is not set to "This Mac": no message was sent. Change the environment on your Mac.'],
  no_new_chat: [409, 'ui_changed', 'Cursor did not open the new chat screen: check on your Mac.'],
  bad_name: [400, 'bad_name', 'Invalid name.'],
  bad_project: [400, 'bad_project', 'Choose a project.'],
  bad_decision: [400, 'bad_decision', 'Invalid decision.'],
  bad_answer: [400, 'bad_answer', 'Unknown option.'],
  not_running: [409, 'not_running', 'The agent is not working in Cursor (it may have already finished).'],
  primary_disabled: [409, 'ui_changed', 'The continue button is not available: check on your Mac.'],
  tray_still_open: [409, 'no_question', 'The questionnaire is still open in Cursor.'],
  focus_failed: [409, 'ui_changed', 'Could not focus the expected field: check on your Mac.'],
  type_failed: [409, 'ui_changed', 'Text was not entered in the field: check on your Mac.'],
  send_disabled: [409, 'ui_changed', 'The send button is not available: check on your Mac.'],
  send_failed: [409, 'ui_changed', 'The message does not appear to have been sent: check on your Mac.'],
  rename_failed: [409, 'ui_changed', 'The rename was not confirmed: check on your Mac.'],
  no_composer: [409, 'ui_changed', 'The composer field was not found: check on your Mac.'],
  click_failed: [502, 'ui_failed', 'Cursor did not run the action (click_failed). Check on your Mac.'],
  disabled: [502, 'ui_failed', 'Cursor did not run the action (disabled). Check on your Mac.'],
  not_found: [502, 'ui_failed', 'Cursor did not run the action (not_found). Check on your Mac.'],
};

function mapUiError(err) {
  if (err instanceof ActionError) return err;
  const code = String(err?.code ?? '');
  const m = UI_ERRORS[code];
  if (m) return new ActionError(m[0], m[1], m[2], { detail: code });
  return new ActionError(502, 'ui_failed', `Cursor did not run the action (${code || 'error'}). Check on your Mac.`, {
    detail: 'ui_failed',
    params: { code: code || 'error' },
  });
}

// After a timeout with the action still in progress, the same send stays blocked for this long past when the error was returned.
const ORPHAN_HOLD_MS = 30_000;

// Circuit breaker: `uiPauseFailures` "Cursor's interface changed" failures within this window (and no success in between) pause actions.
const UI_FAILURE_WINDOW_MS = 10 * 60_000;

export class Actions extends EventEmitter {
  #chain = Promise.resolve();
  #inFlight = new Set();
  #orphans = 0; // actions timed out for the caller but still running on Cursor
  #recent = new Map(); // `kind:chat:key` -> timestamp, to avoid sending the same answer twice
  #state = { available: false, reason: 'off' };
  #timer = null;
  // Circuit breaker for UI changes (see `#noteUiFailure`).
  #uiFailures = [];
  #paused = false;
  #pausedAt = 0;
  #halfOpen = false;

  /**
   * @param {{ ui: object, db: object, watcher: object, config: object, logger: object, now?: Function, sleep?: Function }} deps
   */
  constructor({ ui, db, watcher, config, logger, uploads = null, now = Date.now, sleep = realSleep }) {
    super();
    this.uploads = uploads;
    this.ui = ui;
    this.db = db;
    this.watcher = watcher;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    if (!config.actionsEnabled) this.#state = { available: false, reason: 'disabled' };
  }

  /** `{available, reason}`; reason: ok | off (debug port closed) | no_window | disabled | ui_changed (paused, see `#pause`). */
  get status() {
    return this.#state;
  }

  #setState(next) {
    if (next.reason === this.#state.reason) return;
    this.#state = next;
    this.emit('change', next);
  }

  /** Checks whether the debug port and Agents window respond (HTTP only, lightweight). */
  async refresh() {
    if (!this.config.actionsEnabled) return this.#state;
    let reason = 'off';
    try {
      const p = await this.ui.probe();
      if (p.up) reason = (await this.ui.hasWindow()) ? 'ok' : 'no_window';
    } catch {
      reason = 'off';
    }
    if (this.#paused) {
      if (reason === 'off') this.#resume('restart'); // Cursor closed or restarted (an update is applied that way): start fresh
      else if (reason === 'ok' && this.now() - this.#pausedAt >= (this.config.uiPauseMs ?? 300_000) && (await this.#pageHealthy())) this.#resume('page_check');
      else if (reason === 'ok') reason = 'ui_changed';
    }
    this.#setState({ available: reason === 'ok', reason });
    return this.#state;
  }

  /** Do the page elements the actions rely on look right again? (same check as `npm run doctor`) */
  async #pageHealthy() {
    if (typeof this.ui.selfTest !== 'function') return true;
    try {
      const t = await this.ui.selfTest();
      return t.rows > 0 && (!t.panel || (t.composer && t.send));
    } catch {
      return false;
    }
  }

  /**
   * Circuit breaker. Every action drives Cursor's real interface, so when Cursor changes it the same failure repeats on
   * every try. After `uiPauseFailures` of them in a row (any success clears the count) actions pause: the phone stays
   * read-only and says why, instead of clicking at things that are not there. After `uiPauseMs` the page check runs; once
   * it passes, ONE failure is enough to pause again (half-open), so a real change never causes a long series of attempts.
   */
  #noteUiFailure() {
    const limit = this.config.uiPauseFailures ?? 3;
    if (!limit || this.#paused) return;
    const t = this.now();
    this.#uiFailures = this.#uiFailures.filter((x) => t - x < UI_FAILURE_WINDOW_MS);
    this.#uiFailures.push(t);
    if (this.#halfOpen || this.#uiFailures.length >= limit) this.#pause();
  }

  #noteSuccess() {
    this.#uiFailures = [];
    this.#halfOpen = false;
  }

  #pause() {
    this.#paused = true;
    this.#pausedAt = this.now();
    this.#uiFailures = [];
    this.#halfOpen = false;
    this.logger.warn('actions_paused', { reason: 'ui_changed' });
    this.#setState({ available: false, reason: 'ui_changed' });
  }

  #resume(why) {
    this.#paused = false;
    this.#halfOpen = why === 'page_check';
    this.#uiFailures = [];
    this.logger.info('actions_resumed', { reason: why });
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
  // infrastructure: one action at a time, with timeout
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
      // The queue frees only when the underlying action has REALLY finished (it has internal timeouts): never two actions
      // at once, even if the caller already received the timeout error.
      work.then(release, release);
      let timer;
      const limit = new Promise((_, reject) => {
        timer = setTimeout(() => {
          // The caller gets the error, but the action continues: until it finishes, an identical resend would queue and
          // run AFTER (duplicate message). `#orphans` signals this to `#dedupe`.
          this.#orphans++;
          work.then(() => this.#orphans--, () => this.#orphans--);
          reject(
            new ActionError(504, 'timeout', 'Cursor did not respond in time. The action may still have succeeded: check on your Mac before retrying.'),
          );
        }, this.config.actionTimeoutMs);
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
        this.#noteSuccess();
        return res;
      },
      (err) => {
        const mapped = mapUiError(err);
        this.logger.warn('action_failed', { kind, errcode: mapped.code, ...(err instanceof ActionError ? {} : errorFields(err)) });
        if (mapped.code === 'ui_changed') this.#noteUiFailure();
        throw mapped;
      },
    );
  }

  #chat(id) {
    const chat = this.watcher.last?.chats.find((c) => c.id === id);
    if (!chat) throw new ActionError(404, 'not_found', 'Chat not found.', { detail: 'not_found_chat' });
    return chat;
  }

  #requireReady() {
    if (!this.config.actionsEnabled) throw new ActionError(503, 'actions_disabled', 'Actions are disabled in the daemon configuration.');
    if (this.#paused) {
      throw new ActionError(503, 'actions_paused', 'Actions are paused: Cursor\u2019s interface seems to have changed. Reading still works; check on your Mac.');
    }
    if (!this.#state.available) {
      throw new ActionError(503, 'actions_unavailable', 'Cursor is not reachable on the debug port: start it as explained in Settings.', {
        detail: 'unavailable',
      });
    }
  }

  /** The same request (same chat and same question) must not start twice, neither concurrently nor back-to-back. */
  #dedupe(kind, chatId, key, ttlMs = 60_000) {
    const id = `${kind}:${chatId}:${key}`;
    const t = this.#recent.get(id);
    if (this.#inFlight.has(id) || (t !== undefined && this.now() - t < ttlMs)) {
      throw new ActionError(409, 'already_sent', 'This request was already sent.');
    }
    this.#inFlight.add(id);
    return {
      done: (ok) => {
        this.#inFlight.delete(id);
        // With a timed-out action still running the outcome is unknown: block resend for a while longer.
        if (ok) this.#recent.set(id, this.now());
        else if (this.#orphans > 0) this.#recent.set(id, this.now() + ORPHAN_HOLD_MS);
        for (const [k, v] of this.#recent) if (this.now() - v > 120_000) this.#recent.delete(k);
      },
    };
  }

  /** Live, actionable question for a chat, with the key the user saw. */
  #liveQuestion(chatId, key) {
    const chat = this.#chat(chatId);
    const a = chat.attention;
    if (!a || a.kind !== 'question' || !a.live || a.key !== key) {
      throw new ActionError(409, 'stale', 'The question changed or was already resolved: refresh and try again.', { detail: 'stale_question' });
    }
    const question = this.watcher.detail(chatId)?.question;
    if (!question?.questions?.length) throw new ActionError(409, 'no_question', 'Cannot read the question: answer on your Mac.');
    return { chat, a, question };
  }

  /** Re-reads the database every 400 ms (counts iterations, not wall clock: same result and testable). */
  async #waitFor(fn, timeoutMs) {
    for (let i = 0; ; i++) {
      const v = fn();
      if (v) return v;
      if (i * 400 >= timeoutMs) return null;
      await this.sleep(400);
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // public actions
  // ------------------------------------------------------------------------------------------------------------

  /** Answers question `key` for the chat. `answers`: [{questionId, optionIds?, freeform?}]. */
  async answer(chatId, { key, answers } = {}) {
    if (typeof key !== 'string' || !key) throw new ActionError(400, 'bad_key', 'Invalid key.');
    this.#requireReady();
    const { a, question } = this.#liveQuestion(chatId, key);
    const expected = validateAnswers(question, answers);
    const slot = this.#dedupe('answer', chatId, key);
    let ok = false;
    try {
      const res = await this.#run('answer', async () => {
        await this.ui.answer({ composerId: chatId, question, answers: expected.map((e) => ({ optionIds: e.optionIds, freeform: e.freeform })) });
        // Confirm from database: the question bubble becomes `submitted` with the chosen answers.
        const r = await this.#waitFor(() => {
          const x = this.db.questionResult(chatId, a.bubbleId);
          return x?.status === 'submitted' ? x : null;
        }, 12_000);
        if (!r) return { ok: true, verified: false };
        return answersMatch(r, expected) ? { ok: true, verified: true } : { ok: true, verified: false, warning: 'differs' };
      });
      ok = true;
      this.watcher.boost?.(chatId); // after the action the chat is re-read every second: agent reaction shows up quickly
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Skips the question (like Cursor's Skip button). */
  async skip(chatId, { key } = {}) {
    if (typeof key !== 'string' || !key) throw new ActionError(400, 'bad_key', 'Invalid key.');
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
      this.watcher.boost?.(chatId); // after the action the chat is re-read every second: agent reaction shows up quickly
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /**
   * Approves or rejects a pending terminal command (Cursor "Run" / "Skip" buttons). Only if the request is still
   * the one the user saw (`key` = toolCallId) and only for terminal commands; logs contain decision and
   * outcome, never the command.
   */
  async approval(chatId, { key, decision } = {}) {
    if (typeof key !== 'string' || !key) throw new ActionError(400, 'bad_key', 'Invalid key.');
    if (decision !== 'approve' && decision !== 'reject') throw new ActionError(400, 'bad_decision', 'Invalid decision.');
    if (!this.config.approvalsEnabled) {
      throw new ActionError(503, 'approvals_disabled', 'Approving from the phone is disabled in the daemon configuration (CP_APPROVALS).');
    }
    this.#requireReady();
    const chat = this.#chat(chatId);
    const a = chat.attention;
    if (!a || a.kind !== 'approval' || !a.live || a.key !== key || !a.bubbleId) {
      throw new ActionError(409, 'stale', 'The request changed or was already decided: refresh and try again.', { detail: 'stale_approval' });
    }
    if (!SHELL_TOOLS.has(a.toolName)) {
      throw new ActionError(409, 'unsupported', 'Only terminal commands can be decided from here: decide this request on your Mac.');
    }
    if (decision === 'approve' && this.db.approvalDetails(chatId, a.bubbleId).truncated) {
      throw new ActionError(
        409,
        'command_too_long',
        'The command is too long to read in full here: run it in Cursor on your Mac (you can still reject it).',
      );
    }
    const slot = this.#dedupe('approval', chatId, key);
    let ok = false;
    try {
      const res = await this.#run('approval', async () => {
        const clicked = await this.ui.approval({ composerId: chatId, bubbleId: a.bubbleId, decision });
        // Confirm: either the bubble changes (`reviewData.status` no longer `Requested`, tool no longer `loading`), or
        // the agent moves on and Cursor no longer keeps that request among the latest bubbles (observed live after "Skip":
        // the old bubble stays `Requested` and new ones appear).
        const r = clicked?.settled === true ? { settled: true } : await this.#waitFor(() => {
          const b = this.db.bubbleSummary(chatId, a.bubbleId);
          if (b?.tool && (b.tool.review?.status !== 'Requested' || b.tool.status !== 'loading')) return b;
          const now = this.watcher.last?.chats.find((c) => c.id === chatId)?.attention;
          return !now || now.key !== key || now.kind !== 'approval' ? { moved: true } : null;
        }, 10_000);
        // Cursor's card loses its buttons as soon as the decision is accepted (`settled`): faster signal than the database.
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
   * Stops the agent for a chat that is working (Cursor "Stop generation" button). Does not delete anything: the agent
   * stops generating and the conversation remains. With an open question or approval, use those instead.
   */
  async stopAgent(chatId) {
    this.#requireReady();
    const chat = this.#chat(chatId);
    if (!chat.running) throw new ActionError(409, 'not_running', 'The agent is not working: it may have already finished.', { detail: 'not_running_stop' });
    if (chat.attention?.live && (chat.attention.kind === 'question' || chat.attention.kind === 'approval')) {
      throw new ActionError(409, 'attention_pending', 'This chat is waiting for your decision: answer, approve, or reject instead of stopping it.');
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

  /** Renames the chat in Cursor's sidebar (like "Rename" from the row menu). The name is then read from the database to confirm. */
  async rename(chatId, { name } = {}) {
    if (typeof name !== 'string') throw new ActionError(400, 'bad_name', 'Enter a name.', { detail: 'bad_name_required' });
    const clean = cleanText(name).replace(/\s+/g, ' ').trim();
    if (!clean) throw new ActionError(400, 'bad_name', 'Enter a name.', { detail: 'bad_name_required' });
    if (clean.length > LIMITS.nameChars) {
      throw new ActionError(400, 'bad_name', `Name is too long (maximum ${LIMITS.nameChars} characters).`, {
        detail: 'bad_name_too_long',
        params: { max: LIMITS.nameChars },
      });
    }
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

  /** Archives a chat (not one that is running). */
  async archive(chatId) {
    this.#requireReady();
    const chat = this.#chat(chatId);
    if (chat.running) throw new ActionError(409, 'running', 'The agent is still working: stop it before archiving the chat.');
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

  /** Is the chat pinned to the top of Cursor's sidebar? (read from the page, no change) */
  async pinState(chatId) {
    this.#requireReady();
    this.#chat(chatId);
    return this.#run('pinstate', async () => ({ ok: true, ...(await this.ui.pinState({ composerId: chatId })) }));
  }

  /** Pins or unpins a chat (like "Pin" in Cursor's sidebar menu). */
  async pin(chatId, { pinned } = {}) {
    if (typeof pinned !== 'boolean') throw new ActionError(400, 'bad_pin', 'Say whether to pin or unpin.', { detail: 'bad_pin_unspecified' });
    this.#requireReady();
    this.#chat(chatId);
    const slot = this.#dedupe('pin', chatId, String(pinned), 3_000);
    let ok = false;
    try {
      const res = await this.#run('pin', async () => ({ ok: true, verified: true, ...(await this.ui.setPinned({ composerId: chatId, pinned })) }));
      ok = true;
      this.logger.info('pin_chat', { pinned, changed: res.changed === true });
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Restores an archived chat (only if it appears among archived and visible ones). */
  async restore(chatId) {
    this.#requireReady();
    if (!this.watcher.archived({ limit: 200 }).some((c) => c.id === chatId)) {
      throw new ActionError(404, 'not_found', 'Archived chat not found.', { detail: 'not_found_archived' });
    }
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

  /** Starts a NEW chat (local, "This Mac") on a project with the first message. */
  /** Current and available branch and model for a project's new chat (read-only: Cursor opens menus and closes them). */
  async newChatOptions(sectionId) {
    if (typeof sectionId !== 'string' || !sectionId) throw new ActionError(400, 'bad_project', 'Choose a project.');
    this.#requireReady();
    const known = this.watcher.last?.chats.find((c) => c.sectionId === sectionId);
    if (!known?.workspaceName) throw new ActionError(404, 'not_found', 'Project not found.', { detail: 'not_found_project' });
    return this.#run('newchatopts', async () => ({ ok: true, ...(await this.ui.newChatOptions({ project: known.workspaceName })) }));
  }

  async newChat({ sectionId, text, images, branch, model } = {}) {
    for (const [k, v] of [['branch', branch], ['model', model]]) {
      if (v !== undefined && (typeof v !== 'string' || !v.trim() || v.length > 120 || /[\u0000-\u001f]/.test(v))) {
        throw new ActionError(400, `bad_${k}`, k === 'branch' ? 'Invalid branch.' : 'Invalid model.', { detail: k === 'branch' ? 'bad_branch' : 'bad_model' });
      }
    }
    const ids = images === undefined ? [] : images;
    if (!Array.isArray(ids) || ids.length > UPLOAD_LIMITS.perMessage || !ids.every((x) => typeof x === 'string')) {
      throw new ActionError(400, 'bad_images', `At most ${UPLOAD_LIMITS.perMessage} images can be attached.`, {
        params: { max: UPLOAD_LIMITS.perMessage },
      });
    }
    if (text !== undefined && typeof text !== 'string') throw new ActionError(400, 'bad_text', 'Write a message.', { detail: 'bad_text_empty' });
    const clean = cleanText(text ?? '').trim();
    if (!clean && !ids.length) throw new ActionError(400, 'bad_text', 'Write a message.', { detail: 'bad_text_empty' });
    if (clean.length > LIMITS.messageChars) {
      throw new ActionError(400, 'too_long', `Message is too long (maximum ${LIMITS.messageChars} characters).`, {
        params: { max: LIMITS.messageChars },
      });
    }
    if (typeof sectionId !== 'string' || !sectionId) throw new ActionError(400, 'bad_project', 'Choose a project.');
    this.#requireReady();
    const known = this.watcher.last?.chats.find((c) => c.sectionId === sectionId);
    if (!known?.workspaceName) throw new ActionError(404, 'not_found', 'Project not found.', { detail: 'not_found_project' });
    const files = ids.length ? this.uploads?.paths(ids) : [];
    if (!files) throw new ActionError(409, 'image_expired', 'An image is no longer available: attach it again.');
    const slot = this.#dedupe('newchat', sectionId, crypto.createHash('sha1').update(clean + '\u0000' + ids.join(',') + '\u0000' + (branch ?? '') + '\u0000' + (model ?? '')).digest('hex').slice(0, 16), 10_000);
    let ok = false;
    try {
      const res = await this.#run('newchat', async () => {
        const r = await this.ui.newChat({ project: known.workspaceName, text: clean, ...(files.length ? { files } : {}), ...(branch ? { branch: branch.trim() } : {}), ...(model ? { model: model.trim() } : {}) });
        const seen = await this.#waitFor(() => {
          const f = this.db.chatFlags(r.composerId);
          return f && !f.draft && !f.archived ? true : null; // the "draft" Cursor creates before send does not count
        }, 12_000);
        return { ok: true, chatId: r.composerId, verified: Boolean(seen) };
      });
      ok = true;
      if (ids.length) this.uploads?.remove(ids);
      this.logger.info('new_chat', { images: ids.length, verified: res.verified === true });
      this.watcher.boost?.(res.chatId);
      this.watcher.tick?.();
      return res;
    } finally {
      slot.done(ok);
    }
  }

  /** Writes a message in the chat. If the agent is working, Cursor decides (queue or immediate send, its setting). */
  async sendMessage(chatId, { text, images } = {}) {
    const ids = images === undefined ? [] : images;
    if (!Array.isArray(ids) || ids.length > UPLOAD_LIMITS.perMessage || !ids.every((x) => typeof x === 'string')) {
      throw new ActionError(400, 'bad_images', `At most ${UPLOAD_LIMITS.perMessage} images can be attached.`, {
        params: { max: UPLOAD_LIMITS.perMessage },
      });
    }
    if (text !== undefined && typeof text !== 'string') throw new ActionError(400, 'bad_text', 'Write a message.', { detail: 'bad_text_empty' });
    const clean = cleanText(text ?? '').trim();
    if (!clean && !ids.length) throw new ActionError(400, 'bad_text', 'Write a message.', { detail: 'bad_text_empty' });
    if (clean.length > LIMITS.messageChars) {
      throw new ActionError(400, 'too_long', `Message is too long (maximum ${LIMITS.messageChars} characters).`, {
        params: { max: LIMITS.messageChars },
      });
    }
    this.#requireReady();
    const chat = this.#chat(chatId);
    const files = ids.length ? this.uploads?.paths(ids) : [];
    if (!files) throw new ActionError(409, 'image_expired', 'An image is no longer available: attach it again.');
    if (chat.attention?.kind === 'question' && chat.attention.live) {
      throw new ActionError(409, 'question_pending', 'This chat has a pending question: answer it first.');
    }
    // With a pending approval, a new message's effect depends on Cursor settings (queue or
    // "stop and send", which would cancel the pending command): do not risk it; approve or reject on the Mac first.
    if (chat.attention?.kind === 'approval' && chat.attention.live) {
      throw new ActionError(
        409,
        'approval_pending',
        'This chat is waiting for your approval in Cursor: approve or reject on your Mac before writing.',
      );
    }
    // A double tap on the button must not send the same text twice.
    const slot = this.#dedupe('message', chatId, crypto.createHash('sha1').update(clean + '\u0000' + ids.join(',')).digest('hex').slice(0, 16), 8_000);
    let ok = false;
    try {
      const res = await this.#run('message', async () => {
        const before = this.db.composerTail(chatId);
        await this.ui.sendMessage({ composerId: chatId, text: clean, ...(files.length ? { files } : {}) });
        const tail = await this.#waitFor(() => {
          const t = this.db.composerTail(chatId);
          if (!t || !before) return null;
          return t.bubbleCount > before.bubbleCount || t.queueLength > before.queueLength ? t : null;
        }, 12_000);
        return { ok: true, verified: Boolean(tail), queued: Boolean(tail && before && tail.queueLength > before.queueLength) };
      });
      ok = true;
      if (ids.length) {
        this.uploads?.remove(ids);
        this.logger.info('message_images', { count: ids.length });
      }
      this.watcher.boost?.(chatId); // after the action the chat is re-read every second: agent reaction shows up quickly
      return res;
    } finally {
      slot.done(ok);
    }
  }
}
