// Nuova chat locale su un progetto: si sceglie il progetto, si scrive il primo messaggio (con immagini facoltative) e Cursor
// la avvia sul Mac ("This Mac"). Il daemon controlla progetto e ambiente prima di inviare.
import { describeActionError } from '../action-errors.js';
import { api } from '../api.js';
import { createAttachments } from '../attachments.js';
import { appbar, banner, emptyState } from '../components.js';
import { commit, h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { getLive, refresh } from '../live.js';
import { MESSAGE_MAX } from '../composer.js';

let lastSection = null; // solo in memoria: il progetto scelto l'ultima volta
const FIND_CHAT_MS = 9000;

export function mountNewChat(root) {
  let alive = true;
  let busy = false;
  let note = null; // { text, error }
  let draft = '';
  let sectionId = lastSection;
  let shown = null; // cosa c'e' in formHost: 'form' | 'noactions' | 'noprojects'
  const host = h('div.region');
  const formHost = h('div.region');
  replace(root, h('div', { class: 'screen' }, host, formHost));

  const area = h('textarea', { class: 'composer-input newchat-input', rows: 5, maxlength: MESSAGE_MAX, placeholder: 'Che cosa deve fare l\u2019agente?', 'aria-label': 'Primo messaggio', autocapitalize: 'sentences' });
  const files = createAttachments({ onChange: () => syncSend(), onError: (t) => setNote(t, true), onNote: (t) => setNote(t, false) });
  files.button.classList.add('wide');
  files.button.append('Allega immagini');
  const startBtn = h('button', { class: 'btn primary block', type: 'submit' }, icon('send', { size: 18 }), 'Avvia chat');
  // Elenco a scelta singola (non un <select>: WebKit ne inietta lo stile e la CSP rigorosa dell'app lo segnala).
  const picker = h('div', { class: 'project-list', role: 'radiogroup', 'aria-label': 'Progetto', id: 'newchat-project' });
  const noteEl = h('p', { class: 'hint', role: 'status', hidden: true });
  const form = h(
    'form',
    { class: 'panel newchat', novalidate: true },
    h('div', { class: 'newchat-label' }, 'Progetto'),
    picker,
    h('label', { class: 'newchat-label', for: 'newchat-text' }, 'Primo messaggio'),
    area,
    files.strip,
    h('div', { class: 'newchat-tools' }, files.button, h('span', { class: 'hint grow' }, 'Parte in locale, su This Mac.')),
    noteEl,
    startBtn,
    files.input,
  );
  area.id = 'newchat-text';
  area.addEventListener('input', () => {
    draft = area.value;
    syncSend();
  });

  function setNote(text, error) {
    note = text ? { text, error } : null;
    noteEl.hidden = !note;
    noteEl.textContent = note?.text ?? '';
    noteEl.classList.toggle('error-text', Boolean(note?.error));
  }

  function syncSend() {
    const locked = busy;
    area.disabled = locked;
    for (const b of picker.children) b.disabled = locked;
    files.setLocked(locked);
    startBtn.disabled = locked || files.uploading() || !sectionId || (area.value.trim().length === 0 && files.readyIds().length === 0);
  }

  function drawPicker(workspaces) {
    picker.replaceChildren(
      ...workspaces.map((w) =>
        h(
          'button',
          {
            class: 'project-item',
            type: 'button',
            role: 'radio',
            'aria-checked': String(w.id === sectionId),
            disabled: busy,
            onClick: () => {
              sectionId = w.id;
              lastSection = w.id;
              for (const el of picker.children) el.setAttribute('aria-checked', String(el.dataset.id === w.id));
              syncSend();
            },
          },
          icon('folder', { size: 18 }),
          h('span', { class: 'project-name' }, w.name),
          icon('check', { size: 18 }),
        ),
      ),
    );
    [...picker.children].forEach((el, i) => (el.dataset.id = workspaces[i].id));
  }

  function fillProjects(workspaces) {
    const sig = workspaces.map((w) => `${w.id}:${w.name}`).join('|');
    if (picker.dataset.sig === sig) return;
    picker.dataset.sig = sig;
    if (!workspaces.some((w) => w.id === sectionId)) sectionId = workspaces[0]?.id ?? null;
    drawPicker(workspaces);
  }

  async function waitForChat(id) {
    const t0 = Date.now();
    while (alive && Date.now() - t0 < FIND_CHAT_MS) {
      await refresh().catch(() => {});
      if ((getLive().payload?.state?.workspaces ?? []).some((w) => w.chats.some((c) => c.id === id))) return true;
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = area.value.trim();
    const images = files.readyIds();
    if (busy || files.uploading() || !sectionId || (!text && !images.length)) return;
    busy = true;
    setNote('Avvio la chat in Cursor\u2026', false);
    syncSend();
    try {
      const res = await api.post('/api/chats', images.length ? { sectionId, text, images } : { sectionId, text });
      files.clearLocal();
      draft = '';
      area.value = '';
      lastSection = sectionId;
      setNote('Chat avviata.', false);
      await waitForChat(res.chatId);
      if (alive) location.hash = `#/chat/${encodeURIComponent(res.chatId)}`;
      return;
    } catch (err) {
      setNote(describeActionError(err), true);
    }
    busy = false;
    syncSend();
  });

  area.value = draft;

  function render() {
    if (!alive) return;
    const lv = getLive();
    const workspaces = lv.payload?.state?.workspaces ?? [];
    const actionsOk = lv.payload?.status?.actions === 'ok' && !lv.offline;
    const top = [appbar({ title: 'Nuova chat', backHref: '#/chat' })];
    if (lv.offline) top.push(banner({ text: 'Daemon non raggiungibile' }));
    commit(host, top);
    const show = (kind, node) => {
      if (shown === kind) return;
      shown = kind;
      formHost.replaceChildren(node);
    };
    if (!actionsOk) {
      show('noactions', emptyState({ iconName: 'plug', title: 'Azioni non disponibili', text: 'Per avviare una chat da qui servono la porta di debug di Cursor e la finestra Agents aperta. Vedi Impostazioni.' }));
      return;
    }
    if (!workspaces.length) {
      show('noprojects', emptyState({ iconName: 'folder', title: 'Nessun progetto', text: 'Servono chat locali esistenti: da qui si avvia una chat su un progetto che ne ha gia\u2019 una.' }));
      return;
    }
    fillProjects(workspaces);
    show('form', form);
    syncSend();
  }

  render();
  return {
    update: render,
    destroy() {
      alive = false;
      files.destroy();
    },
  };
}
