// "Attivita' recente" di una chat: cosa sta facendo l'agente (tipo di azione, mai comandi o percorsi) e gli ultimi
// messaggi. Il daemon manda gia' etichette italiane e categorie: qui si sceglie solo l'icona.
import { h } from './dom.js';
import { timeAgo } from './format.js';
import { icon } from './icons.js';

const CATEGORY_ICON = {
  read: 'fileText',
  edit: 'pencil',
  delete: 'trash',
  terminal: 'terminal',
  search: 'search',
  web: 'globe',
  question: 'question',
  plan: 'plan',
  todo: 'listTodo',
  agent: 'bot',
  tool: 'wrench',
};

function iconFor(item) {
  if (item.kind === 'user') return 'user';
  if (item.kind === 'assistant') return 'message';
  return CATEGORY_ICON[item.category] ?? 'wrench';
}

const STATE_TEXT = { running: 'in corso', error: 'non riuscita', stopped: 'interrotta' };

function row(item) {
  const stateText = STATE_TEXT[item.state];
  const mark =
    item.state === 'running'
      ? icon('spinner', { size: 16, className: 'spin' })
      : item.state === 'error'
        ? icon('xCircle', { size: 16 })
        : icon(iconFor(item), { size: 16 });
  return h(
    'li',
    { class: `activity-row ${item.kind}${item.state ? ` ${item.state}` : ''}` },
    h('span', { class: 'activity-mark', 'aria-hidden': 'true' }, mark),
    h(
      'div.activity-body',
      null,
      h('div.activity-label', null, item.label, stateText ? h('span.activity-state', null, ` \u00b7 ${stateText}`) : null),
      item.preview ? h('div.activity-preview', null, item.preview) : null,
    ),
    item.at ? h('span.hint.activity-time', null, timeAgo(item.at)) : null,
  );
}

/**
 * Pannello dell'attivita'. `mode`:
 *  - 'working': la chat sta lavorando (o un'azione e' in corso);
 *  - 'waiting': si e' appena risposto o scritto e l'agente non ha ancora lasciato tracce;
 *  - 'idle': solo cronologia recente.
 * Con elenco vuoto e modo 'idle' non si mostra nulla.
 */
export function activityPanel(items, mode) {
  const list = items ?? [];
  if (!list.length && mode === 'idle') return null;
  const title = { working: 'L\u2019agente sta lavorando', waiting: 'Inviato: in attesa dell\u2019agente', idle: 'Attivit\u00e0 recente' }[mode];
  const busy = mode !== 'idle';
  return h(
    'section',
    { class: 'panel activity' },
    h(
      'div.panel-title',
      null,
      busy ? icon('spinner', { size: 20, className: 'spin' }) : icon('clock', { size: 20 }),
      h('span.grow', null, title),
    ),
    list.length ? h('ul.activity-list', null, list.slice(0, 8).map(row)) : null,
  );
}
