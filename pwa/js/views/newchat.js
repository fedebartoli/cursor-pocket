// New local chat on a project: pick project, write first message (optional images), Cursor starts it on the Mac ("This Mac").
// The daemon validates project and environment before sending.
import { describeActionError } from '../action-errors.js';
import { api } from '../api.js';
import { createAttachments } from '../attachments.js';
import { appbar, banner, emptyState } from '../components.js';
import { commit, h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { getLive, refresh } from '../live.js';
import { MESSAGE_MAX } from '../composer.js';
import { t } from '../i18n/index.js';

let lastSection = null; // in-memory only: last chosen project
const FIND_CHAT_MS = 9000;

export function mountNewChat(root) {
  let alive = true;
  let busy = false;
  let note = null; // { text, error }
  let draft = '';
  let sectionId = lastSection;
  let shown = null; // what formHost shows: 'form' | 'noactions' | 'noprojects'
  let opts = null; // choices read from Cursor for the project: { branch: { current, options }, model: { current, options } }
  let optsFor = null; // project these options belong to
  let optsLoading = false;
  const pick = { branch: null, model: null }; // null = as in Cursor
  const host = h('div.region');
  const formHost = h('div.region');
  replace(root, h('div', { class: 'screen' }, host, formHost));

  const area = h('textarea', { class: 'composer-input newchat-input', rows: 5, maxlength: MESSAGE_MAX, placeholder: t('newchat.messagePlaceholder'), 'aria-label': t('newchat.messageAria'), autocapitalize: 'sentences' });
  const files = createAttachments({ onChange: () => syncSend(), onError: (msg) => setNote(msg, true), onNote: (msg) => setNote(msg, false) });
  files.button.classList.add('wide');
  files.button.append(t('newchat.attachImages'));
  const startBtn = h('button', { class: 'btn primary block', type: 'submit' }, icon('send', { size: 18 }), t('newchat.startChat'));
  // Single-choice list (not a <select>: WebKit injects styling and the app's strict CSP flags it).
  const picker = h('div', { class: 'project-list', role: 'radiogroup', 'aria-label': t('newchat.projectAria'), id: 'newchat-project' });
  const noteEl = h('p', { class: 'hint', role: 'status', hidden: true });
  const optsHost = h('div', { class: 'newchat-opts' });
  const form = h(
    'form',
    { class: 'panel newchat', novalidate: true },
    h('div', { class: 'newchat-label' }, t('newchat.projectLabel')),
    picker,
    optsHost,
    h('label', { class: 'newchat-label', for: 'newchat-text' }, t('newchat.firstMessageLabel')),
    area,
    files.strip,
    h('div', { class: 'newchat-tools' }, files.button, h('span', { class: 'hint grow' }, t('newchat.localHint'))),
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
    for (const b of optsHost.querySelectorAll('button')) b.disabled = locked || optsLoading;
    startBtn.disabled = locked || files.uploading() || !sectionId || (area.value.trim().length === 0 && files.readyIds().length === 0);
  }


  // Branch and model: read from Cursor on demand (opens and closes menus on the Mac). If unset, Cursor's current values apply.
  function choiceGroup(label, key, current, options, iconName) {
    const rows = [{ value: null, text: t('newchat.asInCursor', { current: current ?? '?' }) }, ...options.filter((o) => o !== current).map((o) => ({ value: o, text: o })), ...(options.includes(current) ? [{ value: current, text: t('newchat.optionCurrent', { current }) }] : [])];
    return h(
      'div',
      { class: 'choice' },
      h('div', { class: 'newchat-label' }, label),
      h(
        'div',
        { class: 'project-list', role: 'radiogroup', 'aria-label': label },
        rows.map((r) =>
          h(
            'button',
            {
              class: 'project-item',
              type: 'button',
              role: 'radio',
              'aria-checked': String(pick[key] === r.value),
              disabled: busy,
              onClick: () => {
                pick[key] = r.value;
                drawOpts();
              },
            },
            icon(iconName, { size: 18 }),
            h('span', { class: 'project-name' }, r.text),
            icon('check', { size: 18 }),
          ),
        ),
      ),
    );
  }

  function drawOpts() {
    if (!opts) {
      optsHost.replaceChildren(
        h(
          'button',
          { class: 'btn', type: 'button', disabled: busy || optsLoading || !sectionId, onClick: loadOpts },
          icon(optsLoading ? 'refresh' : 'cpu', { size: 18, className: optsLoading ? 'spin' : '' }),
          optsLoading ? t('newchat.readingFromCursor') : t('newchat.chooseBranchModel'),
        ),
      );
      return;
    }
    optsHost.replaceChildren(
      choiceGroup(t('newchat.branch'), 'branch', opts.branch.current, opts.branch.options, 'branch'),
      choiceGroup(t('newchat.model'), 'model', opts.model.current, opts.model.options, 'cpu'),
      h('p', { class: 'hint' }, t('newchat.rememberChoiceHint')),
    );
  }

  async function loadOpts() {
    if (optsLoading || !sectionId) return;
    optsLoading = true;
    setNote(null);
    drawOpts();
    const forSection = sectionId;
    try {
      const res = await api.get(`/api/projects/${encodeURIComponent(forSection)}/newchat-options`);
      if (!alive || forSection !== sectionId) return;
      opts = { branch: res.branch, model: res.model };
      optsFor = forSection;
      pick.branch = null;
      pick.model = null;
    } catch (err) {
      setNote(describeActionError(err), true);
    } finally {
      optsLoading = false;
      if (alive) drawOpts();
    }
  }

  function resetOpts() {
    opts = null;
    optsFor = null;
    pick.branch = null;
    pick.model = null;
    drawOpts();
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
              if (sectionId !== w.id) resetOpts();
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
    if (!workspaces.some((w) => w.id === sectionId)) {
      sectionId = workspaces[0]?.id ?? null;
      resetOpts();
    }
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
    setNote(t('newchat.startingInCursor'), false);
    syncSend();
    try {
      const body = { sectionId, text };
      if (images.length) body.images = images;
      if (opts && optsFor === sectionId) {
        if (pick.branch) body.branch = pick.branch;
        if (pick.model) body.model = pick.model;
      }
      const res = await api.post('/api/chats', body);
      files.clearLocal();
      draft = '';
      area.value = '';
      lastSection = sectionId;
      setNote(t('newchat.started'), false);
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
  drawOpts();

  function render() {
    if (!alive) return;
    const lv = getLive();
    const workspaces = lv.payload?.state?.workspaces ?? [];
    const actionsOk = lv.payload?.status?.actions === 'ok' && !lv.offline;
    const top = [appbar({ title: t('newchat.title'), backHref: '#/chat' })];
    if (lv.offline) top.push(banner({ text: t('newchat.offlineTitle') }));
    commit(host, top);
    const show = (kind, node) => {
      if (shown === kind) return;
      shown = kind;
      formHost.replaceChildren(node);
    };
    if (!actionsOk) {
      show('noactions', emptyState({ iconName: 'plug', title: t('newchat.noActionsTitle'), text: t('newchat.noActionsText') }));
      return;
    }
    if (!workspaces.length) {
      show('noprojects', emptyState({ iconName: 'folder', title: t('newchat.noProjectsTitle'), text: t('newchat.noProjectsText') }));
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
