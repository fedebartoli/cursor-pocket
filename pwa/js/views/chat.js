// Dettaglio di una chat: stato, richiesta in attesa (domanda a cui rispondere dal telefono), "Ignora"/"Ripristina",
// ultimo messaggio dell'agente e compositore per scrivere alla chat.
//
// La schermata e' fatta di REGIONI persistenti (alta, pannello, messaggio, compositore): ognuna si aggiorna per conto
// suo. Il questionario e il compositore sono nodi DOM che non vengono mai ricreati finche' la domanda e' la stessa,
// cosi' un aggiornamento live non fa perdere selezioni, testo scritto o focus.
import { describeActionError, describeAnswerResult, describeMessageResult, shouldRefreshAfter } from '../action-errors.js';
import { activityPanel } from '../activity.js';
import { api } from '../api.js';
import { STATE, STATE_PILL, appbar, banner, emptyState, iconButton, skeleton } from '../components.js';
import { createComposer } from '../composer.js';
import { commit, forgetCommit, h, replace } from '../dom.js';
import { timeAgo } from '../format.js';
import { icon } from '../icons.js';
import { getLive, refresh } from '../live.js';
import { renderMarkdown } from '../markdown.js';
import { createQuestionForm } from '../question-form.js';

// Dopo questo tempo una domanda ancora aperta, dopo un invio riuscito, torna risolvibile (il daemon rifiuta i doppi
// invii per 60 s: oltre, ritentare ha senso).
const RESEND_AFTER_MS = 70_000;
const REFRESH_AFTER_ACTION_MS = [1500, 4000, 9000];
// Con la schermata aperta e visibile si rilegge il dettaglio (attivita' e ultimo messaggio) a intervalli brevi: Cursor
// scrive i passi dell'agente man mano e il segnale di stato arriva spesso piu' tardi.
const DETAIL_POLL_MS = 4000;
// Mentre l'agente lavora o si attende la sua reazione a un invio si rilegge piu' spesso.
const DETAIL_POLL_FAST_MS = 1000;
// Dopo una risposta o un messaggio, per questo tempo (o finche' non compare attivita' nuova) si mostra "in attesa".
const WAITING_MS = 90_000;
// Approvare/rifiutare chiede due tocchi: il primo arma il pulsante, il secondo (entro questo tempo) invia.
const APPROVAL_ARM_MS = 5000;
// Per quanto tempo una domanda viva senza testo si considera "in preparazione" (poi si mostra il messaggio generico).
const PREPARING_MAX_MS = 120_000;

function findCard(payload, id) {
  for (const ws of payload?.state?.workspaces ?? []) {
    for (const c of ws.chats) if (c.id === id) return c;
  }
  return null;
}

const signatureOf = (c) => (c ? `${c.state}|${c.attention?.key ?? ''}|${c.lastUpdatedAt}|${c.running}` : 'none');

function explanation(a) {
  switch (a.kind) {
    case 'approvazione':
      return 'Da qui si decidono solo i comandi di terminale: approva o rifiuta sul Mac.';
    case 'piano':
      return 'Piano in attesa: aprilo in Cursor sul Mac.';
    case 'residuo':
      return 'Possibile residuo: non risulta una richiesta aperta.';
    default:
      return 'Apri Cursor sul Mac per rispondere.';
  }
}

/** Perche' le azioni non sono disponibili (stato pubblicato dal daemon) e cosa fare. */
function unavailableReason(actions, offline) {
  if (offline) return { text: 'Daemon non raggiungibile.' };
  switch (actions) {
    case 'disabled':
      return { text: 'Le azioni dal telefono sono disattivate nella configurazione del daemon.' };
    case 'no_window':
      return { text: 'La finestra Agents di Cursor non \u00e8 aperta sul Mac.' };
    default:
      return { text: 'Per rispondere e scrivere da qui serve la porta di debug di Cursor.', link: { href: '#/impostazioni', label: 'Come attivarla' } };
  }
}

// Elenco numerato di SOLA LETTURA, usato quando le azioni dal telefono non sono disponibili: niente cerchi o caselle che
// sembrano controlli da premere. Cursor aggiunge sempre una voce finale "Altro" con risposta libera: si mostra anche qui.
function optionRows(options) {
  const row = (n, text, cls) => h(`li.option${cls}`, null, h('span.num', { 'aria-hidden': 'true' }, String(n)), h('span', null, text));
  return [...options.map((o, i) => row(i + 1, o.label, '')), row(options.length + 1, 'Altro: risposta libera', '.other')];
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
          ? h('ul.options', { 'aria-label': item.allowMultiple ? 'Opzioni, scelta multipla, sola lettura' : 'Opzioni, sola lettura' }, optionRows(item.options))
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
  let busy = false; // un'azione (risposta, salta, ignora) e' in corso
  let notice = null; // avviso in alto (es. esito di Ignora)
  let formNotice = null; // avviso dentro il questionario: { text, error }
  let expanded = false;
  let loadSeq = 0;
  let alive = true;
  let form = null;
  let armed = null; // 'approve' | 'reject': primo tocco dato, serve il secondo per confermare
  let armTimer = null;
  let renaming = false; // campo per rinominare aperto
  let manageBusy = false;
  let manageNote = null; // { text, error }
  let archiveArmed = false;
  let archiveTimer = null;
  let pinned = null; // la chat e' fissata in cima alla sidebar di Cursor? (null = non ancora letto)
  let pinTried = false;
  let sentKey = null; // domanda (o approvazione) a cui si e' appena risposto
  let sentAt = 0;
  let actedAt = 0; // ultima risposta o messaggio inviati da questa schermata (orologio del telefono)
  let actedBase = null; // ultimo passo (bubble) noto al momento dell'invio: si attende uno piu' recente
  const timers = new Set();

  // Regioni: `display: contents`, quindi non influiscono sul layout.
  const topHost = h('div.region');
  const panelHost = h('div.region');
  const activityHost = h('div.region');
  const messageHost = h('div.region');
  const linkHost = h('div.region');
  const manageHost = h('div.region');
  const composer = createComposer({ chatId: id, onSend: sendMessage, onStop: stopAgent });
  // Il distanziatore spinge il compositore in fondo quando il contenuto e' corto (e garantisce un minimo di respiro).
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

  let preparing = false; // c'e' una domanda viva ma Cursor non ne ha ancora scritto il testo
  let fast = false; // l'agente lavora o si attende la sua reazione: polling piu' frequente
  let pollTimer = null;
  function schedulePoll() {
    pollTimer = setTimeout(() => {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        if (!loading) load();
        // Lo stato (domanda viva, chat in corso) non dipende solo dal flusso live: se questo ritarda, qui si recupera.
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

  /** Dopo un'azione sul Mac lo stato cambia: si riscarica a intervalli brevi, senza aspettare il ciclo del daemon. */
  function refreshSoon() {
    for (const ms of REFRESH_AFTER_ACTION_MS) {
      const t = setTimeout(() => {
        timers.delete(t);
        if (alive) refresh().catch(() => {});
      }, ms);
      timers.add(t);
    }
  }

  // --- azioni -------------------------------------------------------------------------------------------------

  async function ignoreAction(method, card, failure) {
    busy = true;
    notice = null;
    render();
    try {
      await api[method](`/api/chats/${enc}/ignore`, { key: card.attention.key });
    } catch (err) {
      notice = err.code === 'stale' ? 'La richiesta \u00e8 cambiata nel frattempo: la vista \u00e8 stata aggiornata.' : `${failure}: ${err.message}`;
    }
    await refresh().catch(() => {});
    busy = false;
    render();
  }

  /** Invio di una risposta o di "Salta" per la domanda corrente. */
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
      // Il questionario sparisce appena il daemon vede la risposta: l'esito resta visibile nel compositore.
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

  /** Primo tocco: arma il pulsante per qualche secondo. Secondo tocco sullo stesso: invia. */
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
        text: res?.verified === false ? 'Decisione inviata. Non riesco ancora a confermare che Cursor l\u2019abbia registrata.' : decision === 'approve' ? 'Comando approvato.' : 'Comando rifiutato.',
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
  const skipQuestion = () => questionAction('skip', {}, () => 'Domanda saltata.');

  async function stopAgent() {
    try {
      const res = await api.post(`/api/chats/${enc}/stop`, {});
      markActed(Date.now());
      refreshSoon();
      load();
      return res?.verified === false ? 'Richiesta inviata. Non riesco ancora a confermare che Cursor si sia fermato.' : 'Agente fermato.';
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
      manageNote = { text: res?.verified === false ? 'Richiesta inviata. Non riesco ancora a confermare che Cursor abbia cambiato il nome.' : 'Nome cambiato.', error: false };
      await refresh().catch(() => {});
    } catch (err) {
      manageNote = { text: describeActionError(err), error: true };
    }
    manageBusy = false;
    renderManage(true);
    render();
  }

  // Lo stato "fissata" si legge da Cursor una sola volta per schermata; se non si riesce, il pulsante semplicemente non c'e'.
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
      manageNote = { text: pinned ? 'Chat fissata in cima alla sidebar di Cursor.' : 'Chat tolta dai fissati.', error: false };
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
      const input = h('input', { type: 'text', id: 'rename-input', maxlength: '100', value: card.name || '', 'aria-label': 'Nuovo nome della chat', autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done' });
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
          h('button', { class: 'btn small primary', type: 'button', disabled: manageBusy, onClick: save }, icon('check', { size: 18 }), 'Salva'),
          h('button', { class: 'btn small', type: 'button', disabled: manageBusy, onClick: () => { renaming = false; renderManage(true); } }, 'Annulla'),
        ),
      );
    } else {
      nodes.push(
        h(
          'div',
          { class: 'panel-actions' },
          h('button', { class: 'btn', type: 'button', disabled: manageBusy, onClick: () => { renaming = true; manageNote = null; renderManage(true); setTimeout(() => { const i = document.getElementById('rename-input'); i?.focus(); i?.select(); }, 0); } }, icon('pencil', { size: 18 }), 'Rinomina'),
          pinned === null ? null : h('button', { class: 'btn', type: 'button', disabled: manageBusy, onClick: togglePin }, icon(pinned ? 'pinOff' : 'pin', { size: 18 }), pinned ? 'Togli' : 'Fissa'),
          h('button', { class: `btn${archiveArmed ? ' armed' : ''}`, type: 'button', disabled: manageBusy || running, onClick: archiveTap }, icon('archive', { size: 18 }), archiveArmed ? 'Conferma' : 'Archivia'),
        ),
      );
      if (running) nodes.push(h('p.hint', null, 'Per archiviare, ferma prima l\u2019agente.'));
      else if (archiveArmed) nodes.push(h('p.hint', null, 'Tocca ancora per archiviare. Si ripristina da Impostazioni.'));
    }
    const changed = commit(manageHost, h('section', { class: 'panel manage' }, nodes));
    if (force && changed && renaming) document.getElementById('rename-input')?.focus();
  }

  async function sendMessage(text, images = []) {
    try {
      const res = await api.post(`/api/chats/${enc}/message`, images.length ? { text, images } : { text });
      markActed(Date.now());
      refreshSoon();
      load();
      return describeMessageResult(res);
    } catch (err) {
      if (shouldRefreshAfter(err)) refresh().catch(() => {});
      throw new Error(describeActionError(err));
    }
  }

  // --- regioni ------------------------------------------------------------------------------------------------

  function attentionPanel(card, actionsStatus, offline, preparingNow) {
    const a = card.attention;
    const live = card.state === STATE.ATTENTION;
    const ignored = card.state === STATE.PENDING && a.reason === 'ignorata';
    const heading = live ? a.label : `${a.label} (${ignored ? 'ignorata' : 'non risolta da tempo'})`;
    const kindIcon = { domanda: 'question', approvazione: 'approval', piano: 'plan' }[a.kind] ?? 'alert';
    const q = detail?.chat?.attention?.key === a.key ? detail.question : null;

    const actionsOk = actionsStatus === 'ok' && !offline;
    const ap = detail?.approval?.key === a.key ? detail.approval : null;
    const children = [h('div', { class: `panel-title${live ? ' danger' : ''}` }, preparingNow ? icon('spinner', { size: 20, className: 'spin' }) : icon(kindIcon, { size: 20 }), h('span.grow', null, preparingNow ? 'L\u2019agente sta preparando la domanda' : heading), h('span.hint', null, timeAgo(a.since)))];
    if (preparingNow) {
      // il titolo dice gia' tutto: nessun testo in piu'
    } else if (q) {
      children.push(...questionBlocks(q));
      if (live) {
        const why = unavailableReason(actionsStatus, offline);
        children.push(h('p.panel-note', null, why.text, ' ', why.link ? h('a', { class: 'link', href: why.link.href }, why.link.label) : null));
      }
    } else if (ap?.supported && ap.command) {
      if (ap.description) children.push(h('p.panel-detail', null, ap.description));
      children.push(h('pre.cmd', { tabindex: '0', 'aria-label': 'Comando da eseguire' }, ap.command));
      if (ap.truncated) children.push(h('p.panel-note', null, 'Comando troppo lungo per essere mostrato per intero: per eseguirlo usa Cursor sul Mac. Da qui puoi solo rifiutarlo.'));
      if (live && !actionsOk) children.push(h('p.panel-note', null, unavailableReason(actionsStatus, offline).text));
    } else {
      if (a.detail) children.push(h('p.panel-detail', null, a.detail));
      children.push(h('p.panel-note', null, explanation(a)));
    }

    const actions = [];
    const decidable = live && actionsOk && ap?.supported && ap.command && !preparingNow;
    if (decidable) {
      const waitingDecision = sentKey === a.key && Date.now() - sentAt < RESEND_AFTER_MS;
      const dis = busy || waitingDecision;
      const noApprove = ap.truncated === true;
      const btn = (decision, label, iconName, cls) =>
        h('button', { class: `btn block${armed === decision ? ' armed' : ''}${cls}`, type: 'button', disabled: dis || (decision === 'approve' && noApprove), onClick: () => approvalTap(decision) }, icon(iconName, { size: 18 }), armed === decision ? 'Conferma' : label);
      actions.push(h('div.decision', null, btn('approve', 'Esegui', 'check', ' primary'), btn('reject', 'Rifiuta', 'close', '')));
      if (formNotice) actions.push(h('p', { class: `hint${formNotice.error ? ' error-text' : ''}`, role: 'status' }, formNotice.text));
      else if (armed) actions.push(h('p.hint', null, 'Tocca ancora per confermare.'));
    }
    if (live) {
      actions.push(h('button', { class: 'btn block', type: 'button', disabled: busy, onClick: () => ignoreAction('post', card, 'Impossibile ignorare') }, icon('eyeOff', { size: 18 }), 'Ignora'));
    } else if (ignored) {
      actions.push(h('button', { class: 'btn block', type: 'button', disabled: busy, onClick: () => ignoreAction('del', card, 'Impossibile ripristinare') }, icon('restore', { size: 18 }), 'Ripristina'));
    }
    if (actions.length) children.push(h('div.panel-actions', null, actions));

    return h('section', { class: `panel${live ? ' attention' : ''}` }, children);
  }

  async function toggleFavorite(card) {
    try {
      await api.post(`/api/chats/${enc}/prefs`, { favorite: !card.favorite });
    } catch (err) {
      notice = `Impossibile aggiornare le preferite: ${err.message}`;
    }
    await refresh().catch(() => {});
    render();
  }

  async function toggleMute(card) {
    try {
      await api.post(`/api/chats/${enc}/prefs`, { muted: !card.muted });
    } catch (err) {
      notice = `Impossibile aggiornare le notifiche: ${err.message}`;
    }
    await refresh().catch(() => {});
    render();
  }

  function renderTop(lv, card) {
    const actions = [iconButton({ label: 'Aggiorna', name: 'refresh', onClick: () => refresh().catch(() => {}) })];
    if (card) actions.unshift(iconButton({ label: card.muted ? 'Riattiva le notifiche di questa chat' : 'Silenzia le notifiche di questa chat', name: card.muted ? 'bellOff' : 'bell', onClick: () => toggleMute(card) }));
    if (card) actions.unshift(iconButton({ label: card.favorite ? 'Togli dalle preferite' : 'Aggiungi alle preferite', name: card.favorite ? 'heartOff' : 'heart', onClick: () => toggleFavorite(card) }));
    if (!card) {
      return commit(
        topHost,
        appbar({ title: 'Chat', backHref: '#/', actions }),
        lv.loaded ? emptyState({ iconName: 'info', title: 'Chat non trovata', text: 'Potrebbe essere stata archiviata o eliminata in Cursor.' }) : skeleton(2),
      );
    }
    const pill = STATE_PILL[card.state] ?? STATE_PILL[STATE.IDLE];
    const out = [appbar({ title: card.workspaceName || 'Chat', backHref: '#/', actions })];
    if (lv.offline) out.push(banner({ text: 'Daemon non raggiungibile', detail: 'Questi dati potrebbero non essere aggiornati.' }));
    if (notice) out.push(banner({ text: notice }));
    out.push(
      h(
        'section.chat-head',
        null,
        h('h2.chat-name', null, card.name || 'Chat senza titolo'),
        h('div.chat-meta', null, h('span', { class: `pill ${pill.cls}` }, pill.text), h('span', null, `Aggiornata ${timeAgo(card.lastUpdatedAt)}`)),
      ),
    );
    return commit(topHost, out);
  }

  function renderPanel(lv, card, actionsOk, mode) {
    const a = card?.attention;
    // Una chat che sta lavorando non e' in attesa di te: il flag di Cursor puo' essere un residuo (vedi stateOf nel daemon).
    // Dopo una risposta Cursor lascia acceso il flag per un po': se l'agente sta chiaramente lavorando, il "residuo" non va mostrato.
    const show = Boolean(card && a && card.state !== STATE.RUNNING && !(a.kind === 'residuo' && mode !== 'idle'));
    preparing = false;
    // Si puo' rispondere anche a una domanda ignorata o vecchia (stato "In sospeso"), purche' Cursor la tenga ancora aperta
    // (`live`): lo chiede la regola "rispondere anche dopo ore o giorni". Se non e' piu' aperta il daemon risponde 409.
    const interactive =
      show &&
      actionsOk &&
      a.kind === 'domanda' &&
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
            if (c.attention.reason === 'ignorata') ignoreAction('del', c, 'Impossibile ripristinare');
            else ignoreAction('post', c, 'Impossibile ignorare');
          },
        });
        panelHost.replaceChildren(form.el);
        forgetCommit(panelHost);
        rebuilt = true;
      }
      if (sentKey === a.key && Date.now() - sentAt >= RESEND_AFTER_MS) {
        // La domanda e' ancora aperta molto dopo l'invio: Cursor non l'ha registrata. Si puo' riprovare.
        sentKey = null;
        formNotice = { text: 'La risposta non risulta ancora registrata da Cursor: controlla sul Mac o riprova.', error: true };
      }
      const stale = card.state === STATE.PENDING;
      const ignoredNow = a.reason === 'ignorata';
      form.update({
        heading: stale ? `${a.label} (${ignoredNow ? 'ignorata' : 'non risolta da tempo'})` : a.label,
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
    if (sentKey && a?.key !== sentKey) formNotice = null; // la domanda e' risolta: l'avviso non serve piu'
    if (show && a.kind === 'domanda' && a.live === true && card.state === STATE.ATTENTION && !(detail?.chat?.attention?.key === a.key && detail.question)) {
      // Cursor scrive il testo della domanda solo a fine turno (10-30 s dopo averla creata): si dice cosi', invece di
      // un generico "apri Cursor sul Mac".
      const fresh = Date.now() - a.since < PREPARING_MAX_MS;
      preparing = fresh && !detailFailed;
    }
    return commit(panelHost, show ? attentionPanel(card, lv.payload?.status?.actions, lv.offline, preparing) : null);
  }

  /** Cosa sta facendo l'agente secondo i passi scritti da Cursor: 'working' | 'waiting' | 'idle'. */
  function activityMode(card) {
    if (!card) return 'idle';
    const newest = detail?.activity?.[0];
    if (card.state === STATE.RUNNING || newest?.state === 'running') return 'working';
    // "In attesa": si e' appena risposto/scritto e l'ultimo passo e' ancora quello noto all'invio.
    if (actedAt > 0 && Date.now() - actedAt < WAITING_MS && newest?.id === actedBase) return 'waiting';
    return 'idle';
  }

  function renderActivity(card, mode) {
    if (!card) {
      fast = false;
      return commit(activityHost, null);
    }
    // Con una domanda o un'approvazione in attesa il pannello sopra e' gia' il centro della schermata.
    const needsYou = card.state === STATE.ATTENTION && mode !== 'waiting';
    fast = mode !== 'idle' || preparing;
    return commit(activityHost, needsYou ? null : activityPanel(detail?.activity ?? [], mode));
  }

  function renderMessage(card) {
    const m = detail?.lastMessage;
    if (!card) return commit(messageHost, null);
    if (!m?.text) {
      return commit(messageHost, detailFailed ? h('div.panel.muted', null, h('p.panel-note', null, 'Impossibile caricare i dettagli della chat.')) : null);
    }
    const long = m.text.length > 600 || m.text.split('\n').length > 10;
    return commit(
      messageHost,
      h(
        'section.panel',
        null,
        h('div.panel-title', null, h('span.grow', null, 'Ultimo messaggio dell\u2019agente'), h('span.hint', null, timeAgo(m.createdAt))),
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
              expanded ? 'Mostra meno' : 'Mostra tutto',
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
      (card.attention?.kind === 'domanda' && card.state === STATE.ATTENTION) ||
      (card.attention?.kind === 'approvazione' && card.attention.live)
    ) {
      // Con una domanda o un'approvazione in attesa il pannello e' li' sopra e il daemon rifiuterebbe comunque il messaggio.
      composer.update({ mode: 'blocked' });
    } else {
      composer.update({ mode: 'ready', running: card.state === STATE.RUNNING });
    }
  }

  function render() {
    if (!alive) return; // chiamata tardiva dopo un cambio di schermata
    const y = window.scrollY;
    const lv = getLive();
    const card = findCard(lv.payload, id);
    const actionsOk = lv.payload?.status?.actions === 'ok' && !lv.offline;
    const mode = activityMode(card);
    const changed = [renderTop(lv, card), renderPanel(lv, card, actionsOk, mode), renderActivity(card, mode), renderMessage(card)].some(Boolean);
    commit(linkHost, card ? h('a', { class: 'row help-link', href: `#/chat/${enc}/storia` }, icon('messages', { size: 20 }), h('div.row-main', null, h('div.row-title', null, 'Conversazione intera')), icon('chevronRight', { size: 18 })) : null);
    renderManage();
    renderComposer(lv, card);
    if (changed) window.scrollTo(0, y);
  }

  function update() {
    const card = findCard(getLive().payload, id);
    const next = signatureOf(card);
    if (card && next !== signature) {
      signature = next;
      load(); // ricarica domanda e ultimo messaggio solo quando la chat e' davvero cambiata
    }
    render();
  }

  update();
  return {
    update,
    destroy() {
      alive = false;
      loadSeq += 1; // scarta le risposte in volo
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
