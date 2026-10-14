// Interactive questionnaire (Phase 2): answer an `ask_question` prompt from the phone.
//
// DOM is built ONCE per question (identified by `key`, the toolCallId) then updated in place:
// no redraws that would lose selection, focus, or typed text when a live update arrives.
import { AnswerState, FREEFORM_MAX, optionBadge } from './answers.js';
import { h } from './dom.js';
import { timeAgo } from './format.js';
import { t } from './i18n/index.js';
import { icon } from './icons.js';

const SKIP_ARM_MS = 4000;

/**
 * @param {object} p
 * @param {string} p.key         question toolCallId
 * @param {object} p.question    { title, questions: [{ id, prompt, options: [{id, label}], allowMultiple }] }
 * @param {() => void} p.onSubmit  (answers) => void|Promise, with `answers` ready for POST /answer
 * @param {() => void} p.onSkip
 * @param {() => void} p.onIgnore
 */
export function createQuestionForm({ key, question, onSubmit, onSkip, onIgnore }) {
  const state = new AnswerState(question);
  let busy = false;
  let sent = false;
  let armedSkip = false;
  let armTimer = 0;
  const choices = []; // { btn, qid, optId }
  const others = []; // { btn, box, text, qid }

  const headingEl = h('span.grow', null, t('questionForm.heading'));
  const sinceEl = h('span.hint');
  const noticeEl = h('p', { class: 'panel-note', role: 'status', hidden: true });
  const gapEl = h('p', { class: 'hint form-gap', hidden: true });

  function questionBlock(q, qi) {
    const multi = Boolean(q.allowMultiple);
    const role = multi ? 'checkbox' : 'radio';
    const promptId = `qf-prompt-${qi}`;

    const options = (q.options ?? []).map((opt, oi) => {
      const btn = h(
        'button',
        { class: 'choice', type: 'button', role, 'aria-checked': 'false', onClick: () => pick(q.id, opt.id) },
        h('span.badge', { 'aria-hidden': 'true' }, optionBadge(oi)),
        h('span.choice-label', null, opt.label),
        h('span.tick', { 'aria-hidden': 'true' }, icon('check', { size: 18 })),
      );
      choices.push({ btn, qid: q.id, optId: opt.id });
      return btn;
    });

    const text = h('textarea', {
      class: 'field-input',
      rows: 3,
      maxlength: FREEFORM_MAX,
      placeholder: t('questionForm.freeformPlaceholder'),
      'aria-label': t('questionForm.freeformLabel'),
      autocapitalize: 'sentences',
    });
    text.addEventListener('input', () => {
      state.setText(q.id, text.value);
      sync();
    });
    const box = h('div', { class: 'other-box', hidden: true }, text);
    const otherBtn = h(
      'button',
      { class: 'choice other', type: 'button', role, 'aria-checked': 'false', onClick: () => pickOther(q.id) },
      h('span.badge', { 'aria-hidden': 'true' }, icon('pencil', { size: 16 })),
      h('span.choice-label', null, t('questionForm.other')),
      h('span.tick', { 'aria-hidden': 'true' }, icon('check', { size: 18 })),
    );
    others.push({ btn: otherBtn, box, text, qid: q.id });

    return h(
      'div.question',
      null,
      h('p', { class: 'question-prompt', id: promptId }, q.prompt),
      multi ? h('p.hint', null, t('questionForm.multiHint')) : null,
      h('div', { class: 'choices', role: multi ? 'group' : 'radiogroup', 'aria-labelledby': promptId }, options, otherBtn),
      box,
    );
  }

  const submitBtn = h('button', { class: 'btn primary block', type: 'button', onClick: submit });
  const skipBtn = h('button', { class: 'btn', type: 'button', onClick: skip });
  let ignoredState = false;
  const ignoreBtn = h('button', { class: 'btn', type: 'button', onClick: () => !busy && onIgnore?.() });

  const el = h(
    'section',
    { class: 'panel attention' },
    h('div', { class: 'panel-title danger' }, icon('question', { size: 20 }), headingEl, sinceEl),
    question.title ? h('p.panel-note', null, h('strong', null, question.title)) : null,
    question.questions.map(questionBlock),
    gapEl,
    noticeEl,
    h('div', { class: 'panel-actions' }, submitBtn, h('div.split', null, skipBtn, ignoreBtn)),
  );

  // Button content is rebuilt only when it actually changes: children must not disappear during a tap.
  const btnSig = new WeakMap();
  function setBtn(btn, iconName, label, spin = false) {
    const sig = `${iconName}|${label}|${spin}`;
    if (btnSig.get(btn) === sig) return;
    btnSig.set(btn, sig);
    btn.replaceChildren(icon(iconName, { size: 18, className: spin ? 'spin' : '' }), document.createTextNode(label));
  }

  function sync() {
    const locked = busy || sent;
    for (const c of choices) {
      c.btn.setAttribute('aria-checked', String(state.isSelected(c.qid, c.optId)));
      c.btn.disabled = locked;
    }
    for (const o of others) {
      const on = state.isOther(o.qid);
      o.btn.setAttribute('aria-checked', String(on));
      o.btn.disabled = locked;
      o.box.hidden = !on;
      o.text.disabled = locked;
    }
    const missing = state.missing();
    submitBtn.disabled = locked || missing > 0;
    if (sent) setBtn(submitBtn, 'check', t('questionForm.sent'));
    else if (busy) setBtn(submitBtn, 'spinner', t('questionForm.sending'), true);
    else setBtn(submitBtn, 'send', t('questionForm.submit'));
    gapEl.hidden = locked || missing === 0;
    gapEl.textContent = missing === 1 ? t('questionForm.missingOne') : t('questionForm.missingMany', { count: missing });
    skipBtn.disabled = locked;
    ignoreBtn.disabled = locked;
    if (ignoredState) setBtn(ignoreBtn, 'restore', t('questionForm.restore'));
    else setBtn(ignoreBtn, 'eyeOff', t('questionForm.ignore'));
    setBtn(skipBtn, 'skip', armedSkip ? t('questionForm.tapAgainToSkip') : t('questionForm.skip'));
  }

  function pick(qid, optionId) {
    if (busy || sent) return;
    if (state.toggle(qid, optionId)) sync();
  }

  function pickOther(qid) {
    if (busy || sent) return;
    const on = state.toggleOther(qid);
    sync();
    // Tap is a user gesture: focus opens the keyboard immediately on iOS.
    if (on) others.find((o) => o.qid === qid)?.text.focus();
  }

  function submit() {
    if (busy || sent || !state.isComplete()) return;
    onSubmit?.(state.payload());
  }

  function skip() {
    if (busy || sent) return;
    if (!armedSkip) {
      armedSkip = true;
      armTimer = setTimeout(() => {
        armedSkip = false;
        sync();
      }, SKIP_ARM_MS);
      sync();
      return;
    }
    clearTimeout(armTimer);
    armedSkip = false;
    sync();
    onSkip?.();
  }

  sync();

  return {
    el,
    key,
    /** Title and time (update with the chat, without touching choices). */
    update({ heading, since, ignored = false, stale = false }) {
      if (heading && headingEl.textContent !== heading) headingEl.textContent = heading;
      // Ignored question: the same button puts it back among those needing attention.
      ignoredState = Boolean(ignored);
      el.classList.toggle('muted-attention', Boolean(stale));
      sync();
      const ago = since ? timeAgo(since) : '';
      if (sinceEl.textContent !== ago) sinceEl.textContent = ago;
    },
    setBusy(v) {
      if (busy === Boolean(v)) return;
      busy = Boolean(v);
      sync();
    },
    setSent(v) {
      if (sent === Boolean(v)) return;
      sent = Boolean(v);
      sync();
    },
    /** `{ text, error }` or null. */
    setNotice(n) {
      noticeEl.hidden = !n;
      noticeEl.textContent = n?.text ?? '';
      noticeEl.classList.toggle('error-text', Boolean(n?.error));
    },
    destroy() {
      clearTimeout(armTimer);
    },
  };
}
