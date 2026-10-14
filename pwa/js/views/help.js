// "Come funziona": le spiegazioni che non devono stare nelle schermate di lavoro.
import { appbar } from '../components.js';
import { h, replace } from '../dom.js';

const SECTIONS = [
  {
    title: 'Schede',
    items: [
      'Attenzione: domande e approvazioni che aspettano te, le chat in corso e quelle in sospeso (richieste vecchie o ignorate).',
      'Chat: tutte le chat locali di Cursor, raggruppate per progetto nello stesso ordine della sidebar.',
      'Preferite: le chat con il cuore. Il cuore e le chat silenziate sono preferenze di questa app, non cambiano nulla in Cursor.',
    ],
  },
  {
    title: 'Richieste',
    items: [
      'Ignora toglie il pallino solo da questa app e non invia nulla a Cursor. Se la chat pone una nuova richiesta, il pallino torna.',
      'Le risposte e le decisioni vengono eseguite in Cursor sul Mac, come se le dessi li. Servono la porta di debug e la finestra Agents aperta.',
      'Esegui e Rifiuta chiedono due tocchi: il primo arma il pulsante, il secondo conferma. Si decidono da qui solo i comandi di terminale.',
    ],
  },
  {
    title: 'Notifiche',
    items: [
      'Arrivano per una nuova domanda, per un\u2019approvazione ancora in attesa dopo qualche secondo e quando una chat finisce il lavoro.',
      'Su iPhone funzionano solo dall\u2019app aggiunta alla schermata Home.',
    ],
  },
];

export function mountHelp(root) {
  replace(
    root,
    h(
      'div.screen',
      null,
      appbar({ title: 'Come funziona', backHref: '#/impostazioni' }),
      SECTIONS.map((s) => h('section', { class: 'panel help' }, h('h2', { class: 'help-title' }, s.title), h('ul', { class: 'help-list' }, s.items.map((t) => h('li', null, t))))),
    ),
  );
  return {};
}
