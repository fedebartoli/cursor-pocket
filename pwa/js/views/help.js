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
    title: 'Gestire le chat',
    items: [
      'In fondo alla pagina di una chat puoi rinominarla o archiviarla. Un\u2019agente al lavoro non si archivia: fermalo prima.',
      'Nel campo dei messaggi il pulsante con l\u2019immagine allega fino a 4 foto: vengono ridimensionate sul telefono e arrivano nel messaggio di Cursor.',
      'Le chat archiviate si ripristinano da Impostazioni, Chat archiviate. Sul Mac Cursor esegue le stesse azioni del menu della riga.',
    ],
  },
  {
    title: 'Mac sveglio',
    items: [
      'Con l\u2019interruttore acceso, il Mac non va in stop mentre un agente lavora e torna normale subito dopo. Con lo schermo chiuso funziona solo con il caricatore collegato.',
      'A schermo chiuso e a batteria serve una configurazione una tantum sul Mac: sudo tools/mac/power-setup.sh install. Il Mac torna a poter dormire a fine lavoro, se il daemon si ferma e se la batteria scende sotto il 20%.',
      'Per la luminosit\u00e0 a zero: tools/mac/build.sh (serve swiftc). La luminosit\u00e0 torna com\u2019era all\u2019apertura dello schermo o a fine lavoro.',
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
