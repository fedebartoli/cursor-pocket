// Shared UI components across views.
import { h } from './dom.js';
import { timeAgo } from './format.js';
import { t } from './i18n/index.js';
import { icon } from './icons.js';

export const STATE = Object.freeze({
  RUNNING: 'running',
  ATTENTION: 'attention',
  PENDING: 'pending',
  DONE: 'done',
  IDLE: 'idle',
});

export function attentionKindLabel(kind) {
  return kind ? t(`attention.${kind}`) : t('components.stateNeedsAttention');
}

export function workspaceDisplayName(ws) {
  if (ws.name) return ws.name;
  if (ws.home) return t('common.noFolder');
  return '';
}

export function iconButton({ label, name, onClick, href, pip = false, spin = false }) {
  const props = { class: 'icon-btn', 'aria-label': label, title: label };
  const children = [icon(name, { size: 22, className: spin ? 'spin' : '' }), pip ? h('span.pip') : null];
  if (href) return h('a', { ...props, href }, children);
  return h('button', { ...props, type: 'button', onClick }, children);
}

/** Cursor brand top-left (separate file, replaceable: see docs/SETUP.md, "Cursor brand"). */
export const logoImg = (size = 28) => h('img', { class: 'appbar-logo', src: '/icons/app-logo.svg', alt: '', width: size, height: size, decoding: 'async' });

export function appbar({ title, backHref, actions = [], logo = false }) {
  return h(
    'header.appbar',
    null,
    backHref ? h('a', { class: 'icon-btn appbar-back', href: backHref, 'aria-label': t('components.back') }, icon('back', { size: 22 })) : null,
    logo && !backHref ? logoImg() : null,
    h('h1', { class: 'appbar-title', tabindex: '-1' }, title),
    h('div.appbar-actions', null, actions),
  );
}

export function banner({ tone = 'danger', iconName = 'alert', text, detail, actionLabel, onAction, href, onDismiss }) {
  const action = actionLabel ? (href ? h('a', { class: 'link', href }, actionLabel) : h('button', { class: 'link', type: 'button', onClick: onAction }, actionLabel)) : null;
  return h(
    'div',
    { class: `banner${tone === 'info' ? ' info' : ''}`, role: 'status' },
    icon(iconName, { size: 20 }),
    h('div.grow', null, h('div', null, h('strong', null, text)), detail ? h('div', null, detail) : null, action),
    onDismiss ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('components.dismiss'), onClick: onDismiss }, icon('close', { size: 18 })) : null,
  );
}

export function sectionHead({ label, count, tone, iconName, expanded, onToggle, alert = false }) {
  const cls = `section-head${tone === 'danger' ? ' danger' : ''}`;
  const children = [
    onToggle ? icon(expanded ? 'chevronDown' : 'chevronRight', { size: 16 }) : null,
    iconName ? icon(iconName, { size: 16 }) : null,
    h('span.grow', null, label),
    alert ? h('span', { class: 'dot attention', role: 'img', 'aria-label': t('components.sectionHasAttention') }) : null,
    count != null ? h('span', { class: `count${tone === 'danger' ? ' danger' : ''}` }, String(count)) : null,
  ];
  if (!onToggle) return h('div', { class: cls }, children);
  return h('button', { class: cls, type: 'button', 'aria-expanded': String(!!expanded), onClick: onToggle }, children);
}

/** Accessible switch (role=switch). `onToggle(newValue)`. */
export function switchRow({ label, sub, checked, onToggle, disabled = false }) {
  return h(
    'div.switch-row',
    null,
    h('div.switch-text', null, h('div.switch-label', null, label), sub ? h('div.switch-sub', null, sub) : null),
    h('button', { class: `switch${checked ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label, disabled, onClick: () => onToggle(!checked) }, h('span.switch-knob')),
  );
}

export function emptyState({ iconName = 'terminal', title, text }) {
  return h('div.empty', null, icon(iconName, { size: 32 }), h('h2', null, title), text ? h('p', null, text) : null);
}

export function skeleton(rows = 4) {
  return h('div', { class: 'skeleton-list', 'aria-busy': 'true', 'aria-label': t('components.loading') }, Array.from({ length: rows }, () => h('div.skel.skel-row')));
}

/** State marker on the left of the row (same meaning as Cursor indicators). */
export function markFor(card) {
  switch (card.state) {
    case STATE.RUNNING:
      return h('span', { class: 'mark running', role: 'img', 'aria-label': t('components.stateRunning') }, icon('spinner', { size: 20, className: 'spin' }));
    case STATE.ATTENTION:
      return h('span.mark', null, h('span', { class: 'dot attention', role: 'img', 'aria-label': t('components.stateNeedsAttention') }));
    case STATE.PENDING:
      return h('span', { class: 'mark pending', role: 'img', 'aria-label': t('components.statePending') }, icon('clock', { size: 20 }));
    case STATE.DONE:
      return h('span.mark', null, h('span', { class: 'dot done', role: 'img', 'aria-label': t('components.stateUnread') }));
    default:
      return h('span.mark', null, icon('terminal', { size: 18 }));
  }
}

/** Secondary row parts tied to state. */
export function stateParts(card) {
  const a = card.attention;
  switch (card.state) {
    case STATE.RUNNING:
      return [t('components.stateRunning')];
    case STATE.ATTENTION:
      return [attentionKindLabel(a?.kind)];
    case STATE.PENDING:
      return [attentionKindLabel(a?.kind), a?.reason === 'ignored' ? t('components.ignored') : t('components.unresolvedLong')];
    case STATE.DONE:
      return [t('components.stateUnread')];
    default:
      return [];
  }
}

export const STATE_PILL = Object.freeze({
  [STATE.RUNNING]: Object.freeze({ get text() { return t('components.pillRunning'); }, cls: 'running' }),
  [STATE.ATTENTION]: Object.freeze({ get text() { return t('components.pillNeedsAttention'); }, cls: 'attention' }),
  [STATE.PENDING]: Object.freeze({ get text() { return t('components.pillPending'); }, cls: '' }),
  [STATE.DONE]: Object.freeze({ get text() { return t('components.pillUnread'); }, cls: 'done' }),
  [STATE.IDLE]: Object.freeze({ get text() { return t('components.pillIdle'); }, cls: '' }),
});

const KIND_ICON = { question: 'question', approval: 'approval', plan: 'plan' };

/** Chat row: title, project, state (with request-type icon) and question preview. */
export function chatRow(card, { showWorkspace = false, showPrompt = false } = {}) {
  const labels = stateParts(card);
  // Project shows in mixed lists; inside a group, if there is no state to show, show the subtitle.
  const meta = showWorkspace ? (card.workspaceName || t('common.noFolder')) : labels.length ? '' : card.subtitle;
  let stateIcon = null;
  if (card.state === STATE.ATTENTION) stateIcon = icon(KIND_ICON[card.attention?.kind] ?? 'alert', { size: 15 });
  else if (card.state === STATE.PENDING) stateIcon = icon('clock', { size: 15 });
  const prompt = showPrompt ? card.attention?.prompt || card.attention?.title || '' : '';
  return h(
    'a',
    { class: 'row', href: `#/chat/${encodeURIComponent(card.id)}` },
    markFor(card),
    h(
      'div.row-main',
      null,
      h('div.row-title', null, card.name || t('common.untitled')),
      meta ? h('div.row-meta', null, meta) : null,
      labels.length ? h('div', { class: `row-state ${card.state}` }, stateIcon, h('span', null, labels.join(' \u00b7 '))) : null,
      prompt ? h('div.row-prompt', null, prompt) : null,
    ),
    h('div.row-side', null, card.muted ? icon('bellOff', { size: 14 }) : null, timeAgo(card.lastUpdatedAt)),
  );
}
