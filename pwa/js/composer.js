// Message composer (Phase 2): text field and send to a chat, fixed at the bottom of the screen.
//
// ALWAYS the same DOM node while the screen updates (otherwise text and focus would be lost);
// `update()` only changes availability and notices. Drafts stay in memory per chat: never on disk.
import { createAttachments } from './attachments.js';
import { h } from './dom.js';
import { t } from './i18n/index.js';
import { icon } from './icons.js';

export const MESSAGE_MAX = 8000; // same as daemon LIMITS.messageChars
const MAX_HEIGHT = 140;
const STATUS_MS = 9000;
const ACTION_STATUS_MS = 20000; // a status with a button stays long enough to be tapped
const STOP_ARM_MS = 4000;

const drafts = new Map(); // chatId -> text

/**
 * @param {object} p
 * @param {string} p.chatId
 * @param {(text: string, images: string[]) => Promise<string>} p.onSend  send (images = ids of uploaded images; `opts.force` = send even if the same text was just sent); resolves with outcome text, rejects with Error(message)
 * @param {() => Promise<string>} [p.onStop]  stop the agent (only while working and the field is empty); same convention as onSend
 */
export function createComposer({ chatId, onSend, onStop }) {
  let mode = 'ready'; // 'ready' | 'blocked' | 'unavailable' | 'hidden'
  let busy = false;
  let statusTimer = 0;
  let lastSig = '';
  let running = false;
  let armed = false;
  let armTimer = 0;

  const hintEl = h('p', { class: 'dock-hint', hidden: true });
  const statusEl = h('p', { class: 'dock-status', role: 'status', hidden: true });
  const area = h('textarea', {
    class: 'composer-input',
    rows: 1,
    maxlength: MESSAGE_MAX,
    placeholder: t('composer.placeholderReady'),
    'aria-label': t('composer.messageLabel'),
    autocapitalize: 'sentences',
    enterkeyhint: 'enter',
  });
  const sendBtn = h('button', { class: 'send', type: 'submit', 'aria-label': t('composer.sendMessage') }, icon('arrowUp', { size: 22 }));
  // Tapping the button must not take focus from the field (iOS would close the keyboard and move the button before the click).
  sendBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
  const sendIcon = sendBtn.firstChild;
  const stopIcon = icon('stop', { size: 18 });
  const files = createAttachments({ onChange: () => sync(), onError: (t) => showStatus(t, true), onNote: (t) => showStatus(t) });
  const form = h('form', { class: 'composer', novalidate: true }, files.button, area, sendBtn);
  const el = h('div', { class: 'dock' }, hintEl, statusEl, files.strip, form, files.input);

  // Height follows text (up to a max). CSSOM: allowed by CSP, unlike the style attribute.
  function fit() {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
  }

  // Like Cursor: while the agent works and the field is empty, the send button becomes "Stop".
  const stopping = () => running && mode === 'ready' && onStop && area.value.trim().length === 0 && files.count() === 0;

  function disarm() {
    armed = false;
    clearTimeout(armTimer);
  }

  function sync() {
    const locked = busy || mode !== 'ready';
    // While sending, read-only (not disabled): disabling a focused field makes iOS drop the keyboard and the layout jumps.
    area.disabled = mode !== 'ready';
    area.readOnly = busy;
    files.setLocked(locked);
    const stop = stopping();
    if (!stop) disarm();
    sendBtn.classList.toggle('stop', Boolean(stop));
    sendBtn.classList.toggle('armed', Boolean(stop && armed));
    sendBtn.setAttribute('aria-label', stop ? (armed ? t('composer.tapAgainToStop') : t('composer.stopAgent')) : t('composer.sendMessage'));
    sendBtn.replaceChildren(stop ? stopIcon : sendIcon);
    sendBtn.disabled = stop ? busy : locked || files.uploading() || (area.value.trim().length === 0 && files.readyIds().length === 0);
  }

  // `action`: optional {label, run}; shown as a text button after the message (for example "Send anyway").
  function showStatus(text, error = false, action = null) {
    clearTimeout(statusTimer);
    statusEl.hidden = !text;
    statusEl.textContent = text ?? '';
    statusEl.classList.toggle('error-text', error);
    if (text && action) {
      statusEl.append(' ', h('button', { class: 'link', type: 'button', onClick: action.run }, action.label));
    }
    if (text) {
      statusTimer = setTimeout(() => {
        statusEl.hidden = true;
        statusEl.textContent = '';
      }, action ? ACTION_STATUS_MS : STATUS_MS);
    }
  }

  area.value = drafts.get(chatId) ?? '';
  area.addEventListener('input', () => {
    if (area.value) drafts.set(chatId, area.value);
    else drafts.delete(chatId);
    fit();
    sync();
  });

  async function doStop() {
    if (!armed) {
      armed = true;
      showStatus(t('composer.tapAgainToStopHint'));
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = false;
        showStatus(null);
        sync();
      }, STOP_ARM_MS);
      sync();
      return;
    }
    disarm();
    busy = true;
    showStatus(null);
    sync();
    try {
      showStatus(await onStop());
    } catch (err) {
      showStatus(err?.message || t('composer.stopFailed'), true);
    }
    busy = false;
    sync();
  }

  async function submit(force = false) {
    if (stopping()) return doStop();
    const text = area.value.trim();
    const ids = files.readyIds();
    if ((!text && !ids.length) || files.uploading() || busy || mode !== 'ready') return;
    busy = true;
    showStatus(null);
    sync();
    try {
      const msg = await onSend(text, ids, force ? { force: true } : undefined);
      area.value = '';
      drafts.delete(chatId);
      files.clearLocal(); // daemon already deleted them after send
      fit();
      area.blur(); // dismiss keyboard: chat state should be visible
      showStatus(msg);
    } catch (err) {
      // The same text was sent a moment ago and Cursor has not registered it yet (or it is not sure): the user may really
      // want it twice ("yes", "continue"), so offer to send it anyway instead of making them wait it out.
      const again = err?.code === 'already_sent' ? { label: t('composer.sendAnyway'), run: () => submit(true) } : null;
      showStatus(err?.message || t('composer.sendFailed'), true, again);
    }
    busy = false;
    sync();
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });

  sync();
  // Restored draft may be long: height is computed once the node is in the page.
  queueMicrotask(fit);

  return {
    el,
    /** Show for a few seconds an outcome decided elsewhere (e.g. answer to a question: the form disappears in the meantime). */
    flash(text, error = false) {
      showStatus(text, error);
    },
    /**
     * @param {{ mode: 'ready'|'blocked'|'unavailable'|'hidden', hint?: string, hintLink?: {href: string, label: string}, running?: boolean }} s
     */
    update({ mode: next, hint, hintLink, running: r = false }) {
      const sig = `${next}|${hint ?? ''}|${hintLink?.href ?? ''}|${r}`;
      if (sig === lastSig) return;
      lastSig = sig;
      mode = next;
      running = Boolean(r);
      // With a pending question the composer hides (the question is above); without actions only the
      // explanation line remains: a permanent disabled field would waste space for nothing.
      el.hidden = next === 'blocked' || next === 'hidden';
      el.setAttribute('data-mode', next);
      const note = hint || '';
      hintEl.hidden = !note;
      hintEl.replaceChildren();
      if (note) {
        hintEl.append(note);
        if (hintLink) hintEl.append(' ', h('a', { class: 'link', href: hintLink.href }, hintLink.label));
      }
      area.placeholder = next === 'ready' ? t('composer.placeholderReady') : next === 'blocked' ? t('composer.placeholderBlocked') : t('composer.placeholderUnavailable');
      sync();
    },
    destroy() {
      clearTimeout(statusTimer);
      clearTimeout(armTimer);
      files.destroy();
    },
  };
}
