// Conversazione intera di una chat, SOLO LETTURA, a pagine dal fondo: si parte dagli ultimi messaggi e si caricano i precedenti
// su richiesta. I tool compaiono come righe discrete (tipo di azione, mai comandi o percorsi).
import { api } from '../api.js';
import { CATEGORY_ICON } from '../activity.js';
import { appbar, banner, emptyState, skeleton } from '../components.js';
import { commit, h, replace } from '../dom.js';
import { timeAgo } from '../format.js';
import { icon } from '../icons.js';
import { getLive } from '../live.js';
import { renderMarkdown } from '../markdown.js';

const PAGE = 30;
const STATE_TEXT = { running: 'in corso', error: 'non riuscita', stopped: 'interrotta' };

function toolLine(item) {
  const mark = item.state === 'running' ? icon('spinner', { size: 14, className: 'spin' }) : item.state === 'error' ? icon('xCircle', { size: 14 }) : icon(CATEGORY_ICON[item.category] ?? 'wrench', { size: 14 });
  return h('div', { class: `hist-tool${item.state ? ` ${item.state}` : ''}` }, h('span.hist-tool-mark', { 'aria-hidden': 'true' }, mark), item.label, STATE_TEXT[item.state] ? ` \u00b7 ${STATE_TEXT[item.state]}` : '');
}

function message(item) {
  const body =
    item.role === 'assistant'
      ? h('div.message', null, renderMarkdown(item.text))
      : h('div.message', null, h('p', { class: 'md-p' }, item.text));
  return h(
    'article',
    { class: `hist-msg ${item.role}` },
    h('div.hist-meta', null, icon(item.role === 'user' ? 'user' : 'message', { size: 14 }), h('span', null, item.role === 'user' ? 'Tu' : 'Agente'), h('span.hint', null, timeAgo(item.at))),
    body,
    item.truncated ? h('p.hint', null, 'Messaggio lungo: qui si vede solo l\u2019inizio.') : null,
  );
}

export function mountHistory(root, id) {
  const enc = encodeURIComponent(id);
  let items = []; // dal piu' vecchio al piu' recente
  let from = null; // indice del primo bubble caricato
  let hasMore = false;
  let loading = true;
  let error = null;
  let alive = true;
  const host = h('div.region');
  replace(root, h('div', { class: 'screen hist-screen' }, host));

  async function fetchPage(before) {
    const q = before === null ? `?limit=${PAGE}` : `?before=${before}&limit=${PAGE}`;
    return api.get(`/api/chats/${enc}/history${q}`);
  }

  async function loadFirst() {
    try {
      const p = await fetchPage(null);
      if (!alive) return;
      items = p.items;
      from = p.from;
      hasMore = p.hasMore;
      error = null;
    } catch (err) {
      if (!alive) return;
      error = err.status === 404 ? 'Chat non trovata. Potrebbe essere stata archiviata o eliminata in Cursor.' : 'Non riesco a leggere la conversazione adesso.';
    }
    loading = false;
    render();
    if (!error) window.scrollTo(0, document.documentElement.scrollHeight);
  }

  async function loadOlder() {
    if (loading || !hasMore) return;
    loading = true;
    render();
    const before = document.documentElement.scrollHeight - window.scrollY;
    try {
      const p = await fetchPage(from);
      if (!alive) return;
      items = [...p.items, ...items];
      from = p.from;
      hasMore = p.hasMore;
    } catch {
      error = 'Non riesco a caricare i messaggi precedenti.';
    }
    loading = false;
    render();
    // Resta sullo stesso punto: i messaggi nuovi compaiono sopra.
    window.scrollTo(0, document.documentElement.scrollHeight - before);
  }

  function render() {
    if (!alive) return;
    const lv = getLive();
    const card = lv.payload?.state?.workspaces?.flatMap((w) => w.chats).find((c) => c.id === id) ?? null;
    const out = [appbar({ title: card?.name || 'Conversazione', backHref: `#/chat/${enc}` })];
    if (lv.offline) out.push(banner({ text: 'Daemon non raggiungibile', detail: 'Questi dati potrebbero non essere aggiornati.' }));
    if (error) out.push(emptyState({ iconName: 'info', title: 'Conversazione non disponibile', text: error }));
    else if (loading && !items.length) out.push(skeleton(3));
    else if (!items.length) out.push(emptyState({ iconName: 'message', title: 'Nessun messaggio', text: 'Questa chat non ha ancora messaggi.' }));
    else {
      if (hasMore) out.push(h('button', { class: 'btn block hist-older', type: 'button', disabled: loading, onClick: loadOlder }, loading ? icon('spinner', { size: 18, className: 'spin' }) : icon('chevronUp', { size: 18 }), 'Messaggi precedenti'));
      out.push(h('div.hist-list', null, items.map((it) => (it.role === 'tool' ? toolLine(it) : message(it)))));
    }
    commit(host, out);
  }

  loadFirst();
  render();
  return {
    update: render,
    destroy() {
      alive = false;
    },
  };
}
