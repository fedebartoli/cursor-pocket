// Componenti di interfaccia condivisi tra le viste.
import { h } from './dom.js';
import { timeAgo } from './format.js';
import { icon } from './icons.js';

export const STATE = Object.freeze({
  RUNNING: 'in_corso',
  ATTENTION: 'attenzione',
  PENDING: 'in_sospeso',
  DONE: 'finita',
  IDLE: 'inattiva',
});

export function iconButton({ label, name, onClick, href, pip = false, spin = false }) {
  const props = { class: 'icon-btn', 'aria-label': label, title: label };
  const children = [icon(name, { size: 22, className: spin ? 'spin' : '' }), pip ? h('span.pip') : null];
  if (href) return h('a', { ...props, href }, children);
  return h('button', { ...props, type: 'button', onClick }, children);
}

/** Marchio di Cursor in alto a sinistra (file a parte, sostituibile: vedi docs/SETUP.md, "Marchio Cursor"). */
export const logoImg = (size = 28) => h('img', { class: 'appbar-logo', src: '/icons/cursor-logo.svg', alt: '', width: size, height: size, decoding: 'async' });

export function appbar({ title, backHref, actions = [], logo = false }) {
  return h(
    'header.appbar',
    null,
    backHref ? h('a', { class: 'icon-btn appbar-back', href: backHref, 'aria-label': 'Indietro' }, icon('back', { size: 22 })) : null,
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
    onDismiss ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Nascondi', onClick: onDismiss }, icon('close', { size: 18 })) : null,
  );
}

export function sectionHead({ label, count, tone, iconName, expanded, onToggle, alert = false }) {
  const cls = `section-head${tone === 'danger' ? ' danger' : ''}`;
  const children = [
    onToggle ? icon(expanded ? 'chevronDown' : 'chevronRight', { size: 16 }) : null,
    iconName ? icon(iconName, { size: 16 }) : null,
    h('span.grow', null, label),
    alert ? h('span', { class: 'dot attention', role: 'img', 'aria-label': 'Contiene chat che richiedono attenzione' }) : null,
    count != null ? h('span', { class: `count${tone === 'danger' ? ' danger' : ''}` }, String(count)) : null,
  ];
  if (!onToggle) return h('div', { class: cls }, children);
  return h('button', { class: cls, type: 'button', 'aria-expanded': String(!!expanded), onClick: onToggle }, children);
}

/** Interruttore accessibile (role=switch). `onToggle(nuovoValore)`. */
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
  return h('div', { class: 'skeleton-list', 'aria-busy': 'true', 'aria-label': 'Caricamento' }, Array.from({ length: rows }, () => h('div.skel.skel-row')));
}

/** Marcatore di stato a sinistra della riga (stesso significato dei segnali di Cursor). */
export function markFor(card) {
  switch (card.state) {
    case STATE.RUNNING:
      return h('span', { class: 'mark running', role: 'img', 'aria-label': 'In corso' }, icon('spinner', { size: 20, className: 'spin' }));
    case STATE.ATTENTION:
      return h('span.mark', null, h('span', { class: 'dot attention', role: 'img', 'aria-label': 'Richiede attenzione' }));
    case STATE.PENDING:
      return h('span', { class: 'mark pending', role: 'img', 'aria-label': 'In sospeso' }, icon('clock', { size: 20 }));
    case STATE.DONE:
      return h('span.mark', null, h('span', { class: 'dot done', role: 'img', 'aria-label': 'Da leggere' }));
    default:
      return h('span.mark', null, icon('terminal', { size: 18 }));
  }
}

/** Parti della riga secondaria legate allo stato. */
export function stateParts(card) {
  const a = card.attention;
  switch (card.state) {
    case STATE.RUNNING:
      return ['In corso'];
    case STATE.ATTENTION:
      return [a?.label || 'Richiede attenzione'];
    case STATE.PENDING:
      return [a?.label || 'Richiesta non risolta', a?.reason === 'ignorata' ? 'ignorata' : 'non risolta da tempo'];
    case STATE.DONE:
      return ['Da leggere'];
    default:
      return [];
  }
}

export const STATE_PILL = Object.freeze({
  [STATE.RUNNING]: { text: 'In corso', cls: 'running' },
  [STATE.ATTENTION]: { text: 'Richiede attenzione', cls: 'attention' },
  [STATE.PENDING]: { text: 'In sospeso', cls: '' },
  [STATE.DONE]: { text: 'Da leggere', cls: 'done' },
  [STATE.IDLE]: { text: 'Inattiva', cls: '' },
});

const KIND_ICON = { domanda: 'question', approvazione: 'approval', piano: 'plan' };

/** Riga di una chat: titolo, progetto, stato (con icona del tipo di richiesta) e anteprima della domanda. */
export function chatRow(card, { showWorkspace = false, showPrompt = false } = {}) {
  const labels = stateParts(card);
  // Il progetto compare nelle liste miste; dentro un gruppo, se non c'e' uno stato da dire, si mostra il sottotitolo.
  const meta = showWorkspace ? card.workspaceName : labels.length ? '' : card.subtitle;
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
      h('div.row-title', null, card.name || 'Chat senza titolo'),
      meta ? h('div.row-meta', null, meta) : null,
      labels.length ? h('div', { class: `row-state ${card.state}` }, stateIcon, h('span', null, labels.join(' \u00b7 '))) : null,
      prompt ? h('div.row-prompt', null, prompt) : null,
    ),
    h('div.row-side', null, card.muted ? icon('bellOff', { size: 14 }) : null, timeAgo(card.lastUpdatedAt)),
  );
}
