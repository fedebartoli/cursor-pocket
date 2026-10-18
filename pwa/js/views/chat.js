// Chat detail: state, pending request (question to answer from the phone), "Ignora"/"Ripristina",
// last agent message, and composer to write to the chat.
//
// The screen uses persistent REGIONS (top, panel, message, composer): each updates on its own. The question form and
// composer are DOM nodes that are never recreated while the question is the same, so a live refresh does not lose
// selections, typed text, or focus.
import { describeActionError, describeAnswerResult, describeMessageResult, shouldRefreshAfter } from '../action-errors.js';
import { activityPanel } from '../activity.js';
import { api } from '../api.js';
import { t } from '../i18n/index.js';
import { STATE, STATE_PILL, appbar, attentionKindLabel, banner, emptyState, iconButton, skeleton } from '../components.js';
import { createComposer } from '../composer.js';
import { commit, forgetCommit, h, replace } from '../dom.js';
import { timeAgo } from '../format.js';
import { icon } from '../icons.js';
import { getLive, refresh } from '../live.js';
import { renderMarkdown } from '../markdown.js';
import { createQuestionForm } from '../question-form.js';

// After this long, a question still open after a successful submit becomes submittable again (the daemon rejects duplicate
// submits for 60 s; beyond that, retrying makes sense).
const RESEND_AFTER_MS = 70_000;
const REFRESH_AFTER_ACTION_MS = [1500, 4000, 9000];
// While the screen is open and visible, detail (activity and last message) is reloaded on a short interval: Cursor
// writes agent steps incrementally and the state signal often arrives later.
const DETAIL_POLL_MS = 4000;
// While the agent is working or we await its reaction to a send, reload more often.
const DETAIL_POLL_FAST_MS = 1000;
// After an answer or message, for this long (or until new activity appears) show "waiting".
const WAITING_MS = 90_000;
// Approve/reject requires two taps: the first arms the button, the second (within this window) sends.
const APPROVAL_ARM_MS = 5000;
// How long a live question without text counts as "preparing" (then show the generic message).
const PREPARING_MAX_MS = 120_000;

function findCard(payload, id) {
  for (const ws of payload?.state?.workspaces ?? []) {
    for (const c of ws.chats) if (c.id === id) return c;
  }
  return null;
}

const signatureOf = (c) => (c ? `${c.state}|${c.attention?.key ?? ''}|${c.lastUpdatedAt}|${c.running}` : 'none');

function staleAttentionLabel(kind, ignored) {
  const status = ignored ? t('chat.statusIgnored') : t('chat.statusStale');
  return t('chat.attentionHeading', { label: attentionKindLabel(kind), status });
}

function explanation(a) {
  switch (a.kind) {
    case 'approval':
      return t('chat.explanationApprovazione');
    case 'plan':
      return t('chat.explanationPiano');
    case 'leftover':
      return t('chat.explanationResiduo');
    default:
      return t('chat.explanationDefault');
  }
}

/** Why actions are unavailable (state published by the daemon) and what to do. */
function unavailableReason(actions, offline) {
  if (offline) return { text: t('chat.daemonOffline') };
  switch (actions) {
    case 'disabled':
      return { text: t('chat.phoneActionsDisabled') };
    case 'no_window':
      return { text: t('chat.agentsWindowClosed') };
    case 'ui_changed':
      return { text: t('settings.actionsPaused') };
    default:
      return { text: t('chat.debugPortRequired'), link: { href: '#/impostazioni', label: t('chat.howToEnable') } };
  }
}

// Numbered READ-ONLY list when phone actions are unavailable: no circles or boxes that look like tappable controls.
// Cursor always adds a final "Altro" free-text option; show it here too.
function optionRows(options) {
  const row = (n, text, cls) => h(`li.option${cls}`, null, h('span.num', { 'aria-hidden': 'true' }, String(n)), h('span', null, text));
  return [...options.map((o, i) => row(i + 1, o.label, '')), row(options.length + 1, t('chat.optionOther'), '.other')];
}

function questionBlocks(q) {
  const out = [];
  if (q.title) out.push(h('p.panel-note', null, h('strong', null, q.title)));
  for (const item of q.questions ?? []) {
    out.push(
      h(
        'div',
        { class: 'question' },
        h('p.question-prompt', null, item.prompt),
        item.options?.length
          ? h('ul.options', { 'aria-label': item.allowMultiple ? t('chat.optionsAriaMultiple') : t('chat.optionsAriaReadonly') }, optionRows(item.options))
          : null,
      ),
    );
  }
  return out;
}

export function mountChat(root, id) {
  const enc = encodeURIComponent(id);
  let detail = null;
  let detailFailed = false;
  let signature = '';
  let busy = false; // an action (answer, skip, ignore) is in progress
  let notice = null; // top banner (e.g. result of Ignora)
  let formNotice = null; // notice inside the question form: { text, error }
  let expanded = false;
  let loadSeq = 0;
  let alive = true;
  let form = null;
  let armed = null; // 'approve' | 'reject': first tap done, second tap confirms
  let armTimer = null;
  let renaming = false; // rename field open
  let manageBusy = false;
  let manageNote = null; // { text, error }
  let archiveArmed = false;
  let archiveTimer = null;
  let pinned = null; // is the chat pinned at top of Cursor sidebar? (null = not read yet)
  let pinTried = false;
  let sentKey = null; // question (or approval) just answered
  let sentAt = 0;
  let actedAt = 0; // last answer or message sent from this screen (phone clock)
  let actedBase = null; // latest activity bubble known at send time; wait for a newer one
  const timers = new Set();

  // Regions use `display: contents`, so they do not affect layout.
  const topHost = h('div.region');
  const panelHost = h('div.region');
  const activityHost = h('div.region');
  const messageHost = h('div.region');
  const linkHost = h('div.region');
  const manageHost = h('div.region');
  const composer = createComposer({ chatId: id, onSend: sendMessage, onStop: stopAgent });
  // Spacer pushes the composer to the bottom when content is short (and guarantees minimum breathing room).
  replace(root, h('div', { class: 'screen chat-screen' }, topHost, panelHost, activityHost, messageHost, linkHost, manageHost, h('div', { class: 'chat-spacer', 'aria-hidden': 'true' }), composer.el));

  let loading = false;
  async function load() {
    const seq = ++loadSeq;
    loading = true;
    try {
      const d = await api.get(`/api/chats/${enc}`);
      if (seq !== loadSeq) return;
      detail = d;
      detailFailed = false;
    } catch {
      if (seq !== loadSeq) return;
      detailFailed = true;
    } finally {
      if (seq === loadSeq) loading = false;
    }
    render();
  }

  function markActed(now) {
    actedAt = now;
    actedBase = detail?.activity?.[0]?.id ?? null;
  }

  let preparing = false; // live question exists but Cursor has not written its text yet
  let fast = false; // agent working or awaiting reaction: poll more often
  let pollTimer = null;
  function schedulePoll() {
    pollTimer = setTimeout(() => {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        if (!loading) load();
        // State (live question, running chat) does not depend only on the live stream; if that lags, recover here.
        refresh().catch(() => {});
      }
      schedulePoll();
    }, fast ? DETAIL_POLL_FAST_MS : DETAIL_POLL_MS);
  }
  schedulePoll();
  const onVisible = () => {
    if (alive && document.visibilityState === 'visible') {
      load();
      refresh().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  /** After an action on the Mac state changes: reload on short intervals without waiting for the daemon cycle. */
  function refreshSoon() {
    for (const ms of REFRESH_AFTER_ACTION_MS) {
      const t = setTimeout(() => {
        timers.delete(t);
        if (alive) refresh().catch(() => {});
      }, ms);
      timers.add(t);
    }
  }

  // --- actions ------------------------------------------------------------------------------------------------

  async function ignoreAction(method, card, failure) {
    busy = true;
    notice = null;
    render();
    try {
      await api[method](`/api/chats/${enc}/ignore`, { key: card.attention.key });
    } catch (err) {
      notice = err.code === 'stale' ? t('chat.requestChanged') : `${failure}: ${err.message}`;
    }
    await refresh().catch(() => {});
    busy = false;
    render();
  }

  /** Submit an answer or "Salta" for the current question. */
  async function questionAction(kind, body, okText) {
    const key = findCard(getLive().payload, id)?.attention?.key;
    if (!key || busy) return;
    busy = true;
    formNotice = null;
    render();
    try {
      const res = await api.post(`/api/chats/${enc}/${kind}`, { key, ...body });
      sentKey = key;
      sentAt = Date.now();
      markActed(sentAt);
      formNotice = { text: okText(res), error: res?.warning === 'differs' };
      // Question form hides as soon as the daemon sees the answer; outcome stays visible in the composer.
      composer.flash(formNotice.text, formNotice.error);
      refreshSoon();
      load();
    } catch (err) {
      formNotice = { text: describeActionError(err), error: true };
      if (shouldRefreshAfter(err)) {
        composer.flash(formNotice.text, true);
        await refresh().catch(() => {});
      }
    }
    busy = false;
    render();
  }

  /** First tap: arm the button for a few seconds. Second tap on the same: send. */
  function approvalTap(decision) {
    if (busy) return;
    if (armed !== decision) {
      armed = decision;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = null;
        if (alive) render();
      }, APPROVAL_ARM_MS);
      render();
      return;
    }
    clearTimeout(armTimer);
    armed = null;
    decideApproval(decision);
  }

  async function decideApproval(decision) {
    const key = findCard(getLive().payload, id)?.attention?.key;
    if (!key) return;
    busy = true;
    formNotice = null;
    render();
    try {
      const res = await api.post(`/api/chats/${enc}/approval`, { key, decision });
      sentKey = key;
      sentAt = Date.now();
      markActed(sentAt);
      formNotice = {
        text:
          res?.verified === false
            ? t('chat.approvalSentUnverified')
            : decision === 'approve'
              ? t('chat.approvalApproved')
              : t('chat.approvalRejected'),
        error: false,
      };
      refreshSoon();
      load();
    } catch (err) {
      formNotice = { text: describeActionError(err), error: true };
      if (shouldRefreshAfter(err)) await refresh().catch(() => {});
    }
    busy = false;
    render();
  }

  const submitAnswer = (answers) => questionAction('answer', { answers }, describeAnswerResult);
  const skipQuestion = () => questionAction('skip', {}, () => t('chat.questionSkipped'));

  async function stopAgent() {
    try {
      const res = await api.post(`/api/chats/${enc}/stop`, {});
      markActed(Date.now());
      refreshSoon();
      load();
      return res?.verified === false ? t('chat.stopSentUnverified') : t('chat.stopAgentStopped');
    } catch (err) {
      if (shouldRefreshAfter(err)) refresh().catch(() => {});
      throw new Error(describeActionError(err));
    }
  }

  async function renameChat(name) {
    manageBusy = true;
    manageNote = null;
    renderManage();
    try {
      const res = await api.post(`/api/chats/${enc}/rename`, { name });
      renaming = false;
      manageNote = { text: res?.verified === false ? t('chat.renameSentUnverified') : t('chat.renameSuccess'), error: false };
      await refresh().catch(() => {});
    } catch (err) {
      manageNote = { text: describeActionError(err), error: true };
    }
    manageBusy = false;
    renderManage(true);
    render();
  }

  // Pinned state is read from Cursor once per screen; on failure the button is simply omitted.
  function loadPin() {
    if (pinTried) return;
    pinTried = true;
    api
      .get(`/api/chats/${enc}/pin`)
      .then((r) => {
        if (typeof r?.pinned === 'boolean') pinned = r.pinned;
      })
      .catch(() => {})
      .finally(() => {
        if (alive) renderManage();
      });
  }

  async function togglePin() {
    const next = !pinned;
    manageBusy = true;
    manageNote = null;
    renderManage();
    try {
      const res = await api.post(`/api/chats/${enc}/pin`, { pinned: next });
      pinned = res?.pinned === next ? next : pinned;
      manageNote = { text: pinned ? t('chat.pinnedNotice') : t('chat.unpinnedNotice'), error: false };
    } catch (err) {
      manageNote = { text: describeActionError(err), error: true };
      if (shouldRefreshAfter(err)) refresh().catch(() => {});
    }
    manageBusy = false;
    renderManage();
  }

  async function archiveChat() {
    manageBusy = true;
    archiveArmed = false;
    clearTimeout(archiveTimer);
    manageNote = null;
    renderManage();
    try {
      await api.post(`/api/chats/${enc}/archive`, {});
      await refresh().catch(() => {});
      location.hash = '#/chat';
      return;
    } catch (err) {
      manageNote = { text: describeActionError(err), error: true };
      if (shouldRefreshAfter(err)) refresh().catch(() => {});
    }
    manageBusy = false;
    renderManage();
  }

  function archiveTap() {
    if (!archiveArmed) {
      archiveArmed = true;
      clearTimeout(archiveTimer);
      archiveTimer = setTimeout(() => {
        archiveArmed = false;
        renderManage();
      }, APPROVAL_ARM_MS);
      renderManage();
      return;
    }
    archiveChat();
  }

  function renderManage(force = false) {
    const card = findCard(getLive().payload, id);
    const lv = getLive();
    if (!card || lv.offline || lv.payload?.status?.actions !== 'ok') {
      commit(manageHost, null);
      return;
    }
    const running = card.state === STATE.RUNNING;
    loadPin();
    const nodes = [];
    if (manageNote) nodes.push(h('p', { class: `hint${manageNote.error ? ' error-text' : ''}`, role: 'status' }, manageNote.text));
    if (renaming) {
      const input = h('input', { type: 'text', id: 'rename-input', maxlength: '100', value: card.name || '', 'aria-label': t('chat.renameInputAria'), autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done' });
      const save = () => {
        const v = input.value.trim();
        if (!v) return;
        renameChat(v);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
      });
      nodes.push(
        h(
          'div',
          { class: 'rename-form' },
          input,
          h('button', { class: 'btn small primary', type: 'button', disabled: manageBusy, onClick: save }, icon('check', { size: 18 }), t('chat.save')),
          h('button', { class: 'btn small', type: 'button', disabled: manageBusy, onClick: () => { renaming = false; renderManage(true); } }, t('chat.cancel')),
        ),
      );
    } else {
      nodes.push(
        h(
          'div',
          { class: 'panel-actions' },
          h('button', { class: 'btn', type: 'button', disabled: manageBusy, onClick: () => { renaming = true; manageNote = null; renderManage(true); setTimeout(() => { const i = document.getElementById('rename-input'); i?.focus(); i?.select(); }, 0); } }, icon('pencil', { size: 18 }), t('chat.rename')),
          pinned === null ? null : h('button', { class: 'btn', type: 'button', disabled: manageBusy, onClick: togglePin }, icon(pinned ? 'pinOff' : 'pin', { size: 18 }), pinned ? t('chat.unpin') : t('chat.pin')),
          h('button', { class: `btn${archiveArmed ? ' armed' : ''}`, type: 'button', disabled: manageBusy || running, onClick: archiveTap }, icon('archive', { size: 18 }), archiveArmed ? t('chat.confirm') : t('chat.archive')),
        ),
      );
      if (running) nodes.push(h('p.hint', null, t('chat.archiveStopFirst')));
      else if (archiveArmed) nodes.push(h('p.hint', null, t('chat.archiveConfirmHint')));
    }
    const changed = commit(manageHost, h('section', { class: 'panel manage' }, nodes));
    if (force && changed && renaming) document.getElementById('rename-input')?.focus();
  }

  async function sendMessage(text, images = [], opts = {}) {
    try {
      const body = images.length ? { text, images } : { text };
      if (opts?.force) body.force = true;
      const res = await api.post(`/api/chats/${enc}/message`, body);
      markActed(Date.now());
      refreshSoon();
      load();
      return describeMessageResult(res);
    } catch (err) {
      if (shouldRefreshAfter(err)) refresh().catch(() => {});
      throw Object.assign(new Error(describeActionError(err)), { code: err?.code });
    }
  }

  // --- regions ------------------------------------------------------------------------------------------------

  function attentionPanel(card, actionsStatus, offline, preparingNow) {
    const a = card.attention;
    const live = card.state === STATE.ATTENTION;
    const ignored = card.state === STATE.PENDING && a.reason === 'ignored';
    const heading = live ? attentionKindLabel(a.kind) : staleAttentionLabel(a.kind, ignored);
    const kindIcon = { question: 'question', approval: 'approval', plan: 'plan' }[a.kind] ?? 'alert';
    const q = detail?.chat?.attention?.key === a.key ? detail.question : null;

    const actionsOk = actionsStatus === 'ok' && !offline;
    const ap = detail?.approval?.key === a.key ? detail.approval : null;
    const children = [h('div', { class: `panel-title${live ? ' danger' : ''}` }, preparingNow ? icon('spinner', { size: 20, className: 'spin' }) : icon(kindIcon, { size: 20 }), h('span.grow', null, preparingNow ? t('chat.preparingQuestion') : heading), h('span.hint', null, timeAgo(a.since)))];
    if (preparingNow) {
      // title already says enough: no extra copy
    } else if (q) {
      children.push(...questionBlocks(q));
      if (live) {
        const why = unavailableReason(actionsStatus, offline);
        children.push(h('p.panel-note', null, why.text, ' ', why.link ? h('a', { class: 'link', href: why.link.href }, why.link.label) : null));
      }
    } else if (ap?.supported && ap.command) {
      if (ap.description) children.push(h('p.panel-detail', null, ap.description));
      children.push(h('pre.cmd', { tabindex: '0', 'aria-label': t('chat.commandAria') }, ap.command));
      if (ap.truncated) children.push(h('p.panel-note', null, t('chat.commandTruncated')));
      if (live && !actionsOk) children.push(h('p.panel-note', null, unavailableReason(actionsStatus, offline).text));
    } else {
      if (a.approvalAction) children.push(h('p.panel-detail', null, t(`attention.approvalDetail.${a.approvalAction}`)));
      children.push(h('p.panel-note', null, explanation(a)));
    }

    const actions = [];
    const decidable = live && actionsOk && ap?.supported && ap.command && !preparingNow;
    if (decidable) {
      const waitingDecision = sentKey === a.key && Date.now() - sentAt < RESEND_AFTER_MS;
      const dis = busy || waitingDecision;
      const noApprove = ap.truncated === true;
      const btn = (decision, label, iconName, cls) =>
        h('button', { class: `btn block${armed === decision ? ' armed' : ''}${cls}`, type: 'button', disabled: dis || (decision === 'approve' && noApprove), onClick: () => approvalTap(decision) }, icon(iconName, { size: 18 }), armed === decision ? t('chat.confirm') : label);
      actions.push(h('div.decision', null, btn('approve', t('chat.run'), 'check', ' primary'), btn('reject', t('chat.reject'), 'close', '')));
      if (formNotice) actions.push(h('p', { class: `hint${formNotice.error ? ' error-text' : ''}`, role: 'status' }, formNotice.text));
      else if (armed) actions.push(h('p.hint', null, t('chat.tapAgainConfirm')));
    }
    if (live) {
      actions.push(h('button', { class: 'btn block', type: 'button', disabled: busy, onClick: () => ignoreAction('post', card, t('chat.ignoreFailed')) }, icon('eyeOff', { size: 18 }), t('chat.ignore')));
    } else if (ignored) {
      actions.push(h('button', { class: 'btn block', type: 'button', disabled: busy, onClick: () => ignoreAction('del', card, t('chat.restoreFailed')) }, icon('restore', { size: 18 }), t('chat.restore')));
    }
    if (actions.length) children.push(h('div.panel-actions', null, actions));

    return h('section', { class: `panel${live ? ' attention' : ''}` }, children);
  }

  async function toggleFavorite(card) {
    try {
      await api.post(`/api/chats/${enc}/prefs`, { favorite: !card.favorite });
    } catch (err) {
      notice = t('chat.favoriteUpdateFailed', { message: err.message });
    }
    await refresh().catch(() => {});
    render();
  }

  async function toggleMute(card) {
    try {
      await api.post(`/api/chats/${enc}/prefs`, { muted: !card.muted });
    } catch (err) {
      notice = t('chat.muteUpdateFailed', { message: err.message });
    }
    await refresh().catch(() => {});
    render();
  }

  function renderTop(lv, card) {
    const actions = [iconButton({ label: t('chat.refresh'), name: 'refresh', onClick: () => refresh().catch(() => {}) })];
    if (card) actions.unshift(iconButton({ label: card.muted ? t('chat.unmuteChat') : t('chat.muteChat'), name: card.muted ? 'bellOff' : 'bell', onClick: () => toggleMute(card) }));
    if (card) actions.unshift(iconButton({ label: card.favorite ? t('chat.removeFavorite') : t('chat.addFavorite'), name: card.favorite ? 'heartOff' : 'heart', onClick: () => toggleFavorite(card) }));
    if (!card) {
      return commit(
        topHost,
        appbar({ title: t('chat.titleDefault'), backHref: '#/', actions }),
        lv.loaded ? emptyState({ iconName: 'info', title: t('chat.notFoundTitle'), text: t('chat.notFoundText') }) : skeleton(2),
      );
    }
    const pill = STATE_PILL[card.state] ?? STATE_PILL[STATE.IDLE];
    const out = [appbar({ title: card.workspaceName || t('common.noFolder'), backHref: '#/', actions })];
    if (lv.offline) out.push(banner({ text: t('chat.daemonOfflineBanner'), detail: t('chat.offlineDataStale') }));
    if (notice) out.push(banner({ text: notice }));
    out.push(
      h(
        'section.chat-head',
        null,
        h('h2.chat-name', null, card.name || t('common.untitled')),
        h('div.chat-meta', null, h('span', { class: `pill ${pill.cls}` }, pill.text), h('span', null, t('chat.updatedAgo', { time: timeAgo(card.lastUpdatedAt) }))),
      ),
    );
    return commit(topHost, out);
  }

  function renderPanel(lv, card, actionsOk, mode) {
    const a = card?.attention;
    // A working chat is not waiting on you: Cursor's flag may be stale (see stateOf in the daemon).
    // After an answer Cursor keeps the flag on for a while: if the agent is clearly working, do not show "residuo".
    const show = Boolean(card && a && card.state !== STATE.RUNNING && !(a.kind === 'leftover' && mode !== 'idle'));
    preparing = false;
    // You can answer an ignored or old question ("In sospeso") while Cursor still keeps it open (`live`): required by
    // "answer even after hours or days". If no longer open the daemon returns 409.
    const interactive =
      show &&
      actionsOk &&
      a.kind === 'question' &&
      a.live === true &&
      (card.state === STATE.ATTENTION || card.state === STATE.PENDING) &&
      detail?.chat?.attention?.key === a.key &&
      detail.question?.questions?.length > 0;

    if (interactive) {
      let rebuilt = false;
      if (!form || form.key !== a.key) {
        form?.destroy();
        form = createQuestionForm({
          key: a.key,
          question: detail.question,
          onSubmit: submitAnswer,
          onSkip: skipQuestion,
          onIgnore: () => {
            const c = findCard(getLive().payload, id);
            if (!c?.attention) return;
            if (c.attention.reason === 'ignored') ignoreAction('del', c, t('chat.restoreFailed'));
            else ignoreAction('post', c, t('chat.ignoreFailed'));
          },
        });
        panelHost.replaceChildren(form.el);
        forgetCommit(panelHost);
        rebuilt = true;
      }
      if (sentKey === a.key && Date.now() - sentAt >= RESEND_AFTER_MS) {
        // Question still open long after submit: Cursor did not record it. User can retry.
        sentKey = null;
        formNotice = { text: t('chat.answerNotRecorded'), error: true };
      }
      const stale = card.state === STATE.PENDING;
      const ignoredNow = a.reason === 'ignored';
      form.update({
        heading: stale ? staleAttentionLabel(a.kind, ignoredNow) : attentionKindLabel(a.kind),
        since: a.since,
        ignored: ignoredNow,
        stale,
      });
      form.setBusy(busy);
      form.setSent(sentKey === a.key);
      form.setNotice(formNotice);
      return rebuilt;
    }

    if (form) {
      form.destroy();
      form = null;
      forgetCommit(panelHost);
    }
    if (sentKey && a?.key !== sentKey) formNotice = null; // question resolved: notice no longer needed
    if (show && a.kind === 'question' && a.live === true && card.state === STATE.ATTENTION && !(detail?.chat?.attention?.key === a.key && detail.question)) {
      // Cursor writes question text only at end of turn (10–30 s after creating it): say so instead of generic "open Cursor on Mac".
      const fresh = Date.now() - a.since < PREPARING_MAX_MS;
      preparing = fresh && !detailFailed;
    }
    return commit(panelHost, show ? attentionPanel(card, lv.payload?.status?.actions, lv.offline, preparing) : null);
  }

  /** What the agent is doing from steps written by Cursor: 'working' | 'waiting' | 'idle'. */
  function activityMode(card) {
    if (!card) return 'idle';
    const newest = detail?.activity?.[0];
    if (card.state === STATE.RUNNING || newest?.state === 'running') return 'working';
    // "Waiting": just answered/sent and the latest step is still the one known at send time.
    if (actedAt > 0 && Date.now() - actedAt < WAITING_MS && newest?.id === actedBase) return 'waiting';
    return 'idle';
  }

  function renderActivity(card, mode) {
    if (!card) {
      fast = false;
      return commit(activityHost, null);
    }
    // With a pending question or approval the panel above is already the focus of the screen.
    const needsYou = card.state === STATE.ATTENTION && mode !== 'waiting';
    fast = mode !== 'idle' || preparing;
    return commit(activityHost, needsYou ? null : activityPanel(detail?.activity ?? [], mode));
  }

  function renderMessage(card) {
    const m = detail?.lastMessage;
    if (!card) return commit(messageHost, null);
    if (!m?.text) {
      return commit(messageHost, detailFailed ? h('div.panel.muted', null, h('p.panel-note', null, t('chat.loadDetailsFailed'))) : null);
    }
    const long = m.text.length > 600 || m.text.split('\n').length > 10;
    return commit(
      messageHost,
      h(
        'section.panel',
        null,
        h('div.panel-title', null, h('span.grow', null, t('chat.lastAgentMessage')), h('span.hint', null, timeAgo(m.createdAt))),
        h('div', { class: `message${long && !expanded ? ' clamped' : ''}` }, renderMarkdown(m.text)),
        long
          ? h(
              'button',
              {
                class: 'link-btn',
                type: 'button',
                onClick: () => {
                  expanded = !expanded;
                  render();
                },
              },
              expanded ? t('chat.showLess') : t('chat.showAll'),
            )
          : null,
      ),
    );
  }

  function renderComposer(lv, card) {
    if (!card) {
      composer.update({ mode: 'hidden' });
      return;
    }
    const actionsStatus = lv.payload?.status?.actions;
    if (lv.offline || actionsStatus !== 'ok') {
      const why = unavailableReason(actionsStatus, lv.offline);
      composer.update({ mode: 'unavailable', hint: why.text, hintLink: why.link });
    } else if (
      (card.attention?.kind === 'question' && card.state === STATE.ATTENTION) ||
      (card.attention?.kind === 'approval' && card.attention.live)
    ) {
      // With pending question or approval the panel is above and the daemon would reject a message anyway.
      composer.update({ mode: 'blocked' });
    } else {
      composer.update({ mode: 'ready', running: card.state === STATE.RUNNING });
    }
  }

  function render() {
    if (!alive) return; // late call after navigating away
    const y = window.scrollY;
    const lv = getLive();
    const card = findCard(lv.payload, id);
    const actionsOk = lv.payload?.status?.actions === 'ok' && !lv.offline;
    const mode = activityMode(card);
    const changed = [renderTop(lv, card), renderPanel(lv, card, actionsOk, mode), renderActivity(card, mode), renderMessage(card)].some(Boolean);
    commit(linkHost, card ? h('a', { class: 'row help-link', href: `#/chat/${enc}/storia` }, icon('messages', { size: 20 }), h('div.row-main', null, h('div.row-title', null, t('chat.fullConversation'))), icon('chevronRight', { size: 18 })) : null);
    renderManage();
    renderComposer(lv, card);
    if (changed) window.scrollTo(0, y);
  }

  function update() {
    const card = findCard(getLive().payload, id);
    const next = signatureOf(card);
    if (card && next !== signature) {
      signature = next;
      load(); // reload question and last message only when the chat actually changed
    }
    render();
  }

  update();
  return {
    update,
    destroy() {
      alive = false;
      loadSeq += 1; // discard in-flight responses
      clearTimeout(pollTimer);
      clearTimeout(armTimer);
      clearTimeout(archiveTimer);
      document.removeEventListener('visibilitychange', onVisible);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      form?.destroy();
      composer.destroy();
    },
  };
}
