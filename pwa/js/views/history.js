// Full chat conversation, READ-ONLY, paginated from the bottom: start at latest messages and load older on demand.
// Tools appear as discrete rows (action type, never commands or paths).
import { api } from '../api.js';
import { CATEGORY_ICON } from '../activity.js';
import { appbar, banner, emptyState, skeleton } from '../components.js';
import { commit, h, replace } from '../dom.js';
import { timeAgo } from '../format.js';
import { icon } from '../icons.js';
import { getLive } from '../live.js';
import { t } from '../i18n/index.js';
import { renderMarkdown } from '../markdown.js';

const PAGE = 30;

function toolStateText(state) {
  if (state === 'running') return t('history.stateRunning');
  if (state === 'error') return t('history.stateError');
  if (state === 'stopped') return t('history.stateStopped');
  return '';
}

function toolLine(item) {
  const mark = item.state === 'running' ? icon('spinner', { size: 14, className: 'spin' }) : item.state === 'error' ? icon('xCircle', { size: 14 }) : icon(CATEGORY_ICON[item.category] ?? 'wrench', { size: 14 });
  const suffix = toolStateText(item.state);
  const label = item.action ? t(`activity.action.${item.action}`) : '';
  return h('div', { class: `hist-tool${item.state ? ` ${item.state}` : ''}` }, h('span.hist-tool-mark', { 'aria-hidden': 'true' }, mark), label, suffix ? ` \u00b7 ${suffix}` : '');
}

function message(item) {
  const body =
    item.role === 'assistant'
      ? h('div.message', null, renderMarkdown(item.text))
      : h('div.message', null, h('p', { class: 'md-p' }, item.text));
  return h(
    'article',
    { class: `hist-msg ${item.role}` },
    h('div.hist-meta', null, icon(item.role === 'user' ? 'user' : 'message', { size: 14 }), h('span', null, item.role === 'user' ? t('history.roleUser') : t('history.roleAgent')), h('span.hint', null, timeAgo(item.at))),
    body,
    item.truncated ? h('p.hint', null, t('history.truncatedHint')) : null,
  );
}

export function mountHistory(root, id) {
  const enc = encodeURIComponent(id);
  let items = []; // oldest to newest
  let from = null; // index of first loaded bubble
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
      error = err.status === 404 ? t('history.notFound') : t('history.readError');
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
      error = t('history.loadOlderError');
    }
    loading = false;
    render();
    // Stay at the same scroll position: new messages appear above.
    window.scrollTo(0, document.documentElement.scrollHeight - before);
  }

  function render() {
    if (!alive) return;
    const lv = getLive();
    const card = lv.payload?.state?.workspaces?.flatMap((w) => w.chats).find((c) => c.id === id) ?? null;
    const out = [appbar({ title: card?.name || t('history.defaultTitle'), backHref: `#/chat/${enc}` })];
    if (lv.offline) out.push(banner({ text: t('history.offlineTitle'), detail: t('history.offlineDetail') }));
    if (error) out.push(emptyState({ iconName: 'info', title: t('history.unavailableTitle'), text: error }));
    else if (loading && !items.length) out.push(skeleton(3));
    else if (!items.length) out.push(emptyState({ iconName: 'message', title: t('history.emptyTitle'), text: t('history.emptyText') }));
    else {
      if (hasMore) out.push(h('button', { class: 'btn block hist-older', type: 'button', disabled: loading, onClick: loadOlder }, loading ? icon('spinner', { size: 18, className: 'spin' }) : icon('chevronUp', { size: 18 }), t('history.loadOlder')));
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
