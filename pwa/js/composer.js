// Compositore dei messaggi (Fase 2): campo di testo e invio a una chat, fissato in fondo alla schermata.
//
// Resta SEMPRE lo stesso nodo DOM mentre la schermata si aggiorna (altrimenti si perderebbero testo e focus);
// `update()` cambia solo disponibilita' e avvisi. Le bozze restano in memoria per chat: mai su disco.
import { api } from './api.js';
import { h } from './dom.js';
import { MAX_IMAGES, prepareImage } from './images.js';
import { icon } from './icons.js';

export const MESSAGE_MAX = 8000; // come LIMITS.messageChars del daemon
const MAX_HEIGHT = 140;
const STATUS_MS = 9000;
const STOP_ARM_MS = 4000;

const drafts = new Map(); // chatId -> testo

/**
 * @param {object} p
 * @param {string} p.chatId
 * @param {(text: string, images: string[]) => Promise<string>} p.onSend  invia (images = id delle immagini gia' caricate); risolve con il testo di esito, rifiuta con Error(messaggio)
 * @param {() => Promise<string>} [p.onStop]  ferma l'agente (solo mentre lavora e il campo e' vuoto); stessa convenzione di onSend
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
    placeholder: 'Scrivi a Cursor',
    'aria-label': 'Messaggio per Cursor',
    autocapitalize: 'sentences',
    enterkeyhint: 'enter',
  });
  const sendBtn = h('button', { class: 'send', type: 'submit', 'aria-label': 'Invia messaggio' }, icon('arrowUp', { size: 22 }));
  const sendIcon = sendBtn.firstChild;
  const stopIcon = icon('stop', { size: 18 });
  // Allegati: ogni immagine si ridimensiona e si carica subito sul daemon (resta li' al massimo 30 minuti o fino all'invio).
  const items = []; // { key, id, url, state: 'uploading' | 'ready' }
  let seq = 0;
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const attachBtn = h('button', { class: 'attach', type: 'button', 'aria-label': 'Allega immagini' }, icon('image', { size: 22 }));
  const strip = h('div', { class: 'attach-strip', hidden: true });
  const form = h('form', { class: 'composer', novalidate: true }, attachBtn, area, sendBtn);
  const el = h('div', { class: 'dock' }, hintEl, statusEl, strip, form, fileInput);
  const ready = () => items.filter((i) => i.state === 'ready');
  const uploading = () => items.some((i) => i.state === 'uploading');

  function drawStrip() {
    strip.hidden = items.length === 0;
    strip.replaceChildren(
      ...items.map((it) =>
        h(
          'div',
          { class: `attach-item${it.state === 'uploading' ? ' loading' : ''}` },
          h('img', { src: it.url, alt: '' }),
          it.state === 'uploading' ? h('span', { class: 'attach-wait', 'aria-label': 'Caricamento' }, icon('spinner', { size: 18, className: 'spin' })) : null,
          h('button', { class: 'attach-remove', type: 'button', 'aria-label': 'Rimuovi immagine', onClick: () => removeItem(it) }, icon('close', { size: 14 })),
        ),
      ),
    );
    attachBtn.disabled = busy || mode !== 'ready' || items.length >= MAX_IMAGES;
  }

  function removeItem(it, { remote = true } = {}) {
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
    URL.revokeObjectURL(it.url);
    if (remote && it.id) api.del(`/api/uploads/${it.id}`).catch(() => {});
    drawStrip();
    sync();
  }

  async function addFiles(files) {
    for (const file of [...files].slice(0, MAX_IMAGES - items.length)) {
      const it = { key: (seq += 1), id: null, url: URL.createObjectURL(file), state: 'uploading' };
      items.push(it);
      drawStrip();
      sync();
      try {
        const blob = await prepareImage(file);
        if (!items.includes(it)) continue; // tolta nel frattempo
        URL.revokeObjectURL(it.url);
        it.url = URL.createObjectURL(blob);
        const r = await api.upload(blob);
        if (!items.includes(it)) {
          api.del(`/api/uploads/${r.id}`).catch(() => {});
          continue;
        }
        it.id = r.id;
        it.state = 'ready';
        drawStrip();
        sync();
      } catch (err) {
        removeItem(it, { remote: false });
        showStatus(err?.message || 'Immagine non caricata.', true);
      }
    }
    if (files.length > MAX_IMAGES - items.length && items.length >= MAX_IMAGES) showStatus(`Al massimo ${MAX_IMAGES} immagini per messaggio.`);
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) addFiles(files);
  });

  // L'altezza segue il testo (fino a un massimo). CSSOM: consentito dalla CSP, a differenza dell'attributo style.
  function fit() {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
  }

  // Come in Cursor: mentre l'agente lavora e il campo e' vuoto, il pulsante di invio diventa "Ferma".
  const stopping = () => running && mode === 'ready' && onStop && area.value.trim().length === 0 && items.length === 0;

  function disarm() {
    armed = false;
    clearTimeout(armTimer);
  }

  function sync() {
    const locked = busy || mode !== 'ready';
    area.disabled = locked;
    attachBtn.disabled = locked || items.length >= MAX_IMAGES;
    const stop = stopping();
    if (!stop) disarm();
    sendBtn.classList.toggle('stop', Boolean(stop));
    sendBtn.classList.toggle('armed', Boolean(stop && armed));
    sendBtn.setAttribute('aria-label', stop ? (armed ? 'Tocca ancora per fermare l\u2019agente' : 'Ferma l\u2019agente') : 'Invia messaggio');
    sendBtn.replaceChildren(stop ? stopIcon : sendIcon);
    sendBtn.disabled = stop ? busy : locked || uploading() || (area.value.trim().length === 0 && ready().length === 0);
  }

  function showStatus(text, error = false) {
    clearTimeout(statusTimer);
    statusEl.hidden = !text;
    statusEl.textContent = text ?? '';
    statusEl.classList.toggle('error-text', error);
    if (text) {
      statusTimer = setTimeout(() => {
        statusEl.hidden = true;
        statusEl.textContent = '';
      }, STATUS_MS);
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
      showStatus('Tocca ancora per fermare l\u2019agente.');
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
      showStatus(err?.message || 'Non sono riuscito a fermare l\u2019agente.', true);
    }
    busy = false;
    sync();
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (stopping()) return doStop();
    const text = area.value.trim();
    const ids = ready().map((i) => i.id);
    if ((!text && !ids.length) || uploading() || busy || mode !== 'ready') return;
    busy = true;
    showStatus(null);
    sync();
    try {
      const msg = await onSend(text, ids);
      area.value = '';
      drafts.delete(chatId);
      for (const it of [...items]) removeItem(it, { remote: false }); // il daemon li ha gia' cancellati dopo l'invio
      fit();
      area.blur(); // chiude la tastiera: lo stato della chat dev'essere visibile
      showStatus(msg);
    } catch (err) {
      showStatus(err?.message || 'Invio non riuscito.', true);
    }
    busy = false;
    sync();
  });

  sync();
  // La bozza ripristinata puo' essere lunga: l'altezza si calcola quando il nodo e' in pagina.
  queueMicrotask(fit);

  return {
    el,
    /** Mostra per qualche secondo un esito deciso altrove (es. risposta a una domanda: il questionario nel frattempo sparisce). */
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
      // Con una domanda in attesa il compositore sparisce (la domanda e' li' sopra); senza azioni resta solo la riga
      // di spiegazione: un campo disattivato permanente occuperebbe spazio senza servire.
      el.hidden = next === 'blocked' || next === 'hidden';
      el.setAttribute('data-mode', next);
      const note = hint || '';
      hintEl.hidden = !note;
      hintEl.replaceChildren();
      if (note) {
        hintEl.append(note);
        if (hintLink) hintEl.append(' ', h('a', { class: 'link', href: hintLink.href }, hintLink.label));
      }
      area.placeholder = next === 'ready' ? 'Scrivi a Cursor' : next === 'blocked' ? 'Rispondi prima alla domanda' : 'Scrittura non disponibile';
      sync();
    },
    destroy() {
      clearTimeout(statusTimer);
      clearTimeout(armTimer);
      for (const it of [...items]) removeItem(it);
    },
  };
}
