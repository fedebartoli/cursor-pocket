// Chats archived in Cursor (local only): list with "Ripristina". Restore goes through Cursor's row menu
// (daemon briefly toggles sidebar "Archived" filter and restores it).
import { describeActionError } from '../action-errors.js';
import { api } from '../api.js';
import { appbar, banner, emptyState, skeleton } from '../components.js';
import { h, replace, commit } from '../dom.js';
import { timeAgo } from '../format.js';
import { icon } from '../icons.js';
import { t } from '../i18n/index.js';
import { getLive } from '../live.js';

export function mountArchive(root) {
  let chats = null;
  let error = null;
  let notice = null;
  let busyId = null;
  let alive = true;
  const host = h('div.region');
  replace(root, h('div', { class: 'screen' }, host));

  async function load() {
    try {
      chats = (await api.get('/api/archived')).chats;
      error = null;
    } catch (err) {
      error = describeActionError(err);
    }
    render();
  }

  async function restore(c) {
    if (busyId) return;
    busyId = c.id;
    notice = null;
    render();
    try {
      const res = await api.post(`/api/archived/${encodeURIComponent(c.id)}/restore`, {});
      notice = {
        text: res?.verified === false ? t('archive.restoreUnverified') : t('archive.restoreSuccess'),
        error: false,
      };
    } catch (err) {
      notice = { text: describeActionError(err), error: true };
    }
    busyId = null;
    await load();
  }

  function row(c) {
    return h(
      'div',
      { class: 'row' },
      icon('archive', { size: 20 }),
      h(
        'div.row-main',
        null,
        h('div.row-title', null, c.name || t('archive.untitledChat')),
        h('div.row-meta', null, t('archive.rowMeta', { workspace: c.workspaceName || t('archive.noProject'), time: timeAgo(c.lastUpdatedAt) })),
      ),
      h(
        'button',
        { class: 'btn small', type: 'button', disabled: busyId !== null, onClick: () => restore(c) },
        icon('archiveRestore', { size: 18 }),
        busyId === c.id ? t('archive.wait') : t('archive.restore'),
      ),
    );
  }

  function render() {
    if (!alive) return;
    const out = [appbar({ title: t('archive.title'), backHref: '#/impostazioni' })];
    if (getLive().offline) out.push(banner({ text: t('archive.daemonUnreachable') }));
    if (error) out.push(banner({ text: error }));
    if (notice) out.push(banner({ text: notice.text, tone: notice.error ? 'danger' : 'info', iconName: notice.error ? 'alert' : 'info', onDismiss: () => { notice = null; render(); } }));
    if (chats === null) out.push(error ? null : skeleton(3));
    else if (!chats.length) out.push(emptyState({ iconName: 'archive', title: t('archive.emptyTitle'), text: t('archive.emptyText') }));
    else out.push(h('div', { class: 'list archive-list' }, chats.map(row)));
    commit(host, out);
  }

  render();
  load();
  return {
    update() {},
    destroy() {
      alive = false;
    },
  };
}
