// Abbinamento del dispositivo con il codice generato sul Mac (`npm run pair`) e schermata "daemon non raggiungibile".
import { api } from '../api.js';
import { logoImg } from '../components.js';
import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { environment } from '../push.js';

function messageFor(err) {
  if (err.status === 0) return 'Daemon non raggiungibile. Controlla la connessione.';
  if (err.status === 429) return 'Troppi tentativi. Riprova tra qualche minuto.';
  if (err.status === 401) return 'Codice non valido o scaduto. Generane uno nuovo sul Mac.';
  if (err.status === 403) return 'Richiesta rifiutata dal daemon.';
  return err.message || 'Abbinamento non riuscito.';
}

export function mountLogin(root, { onSuccess }) {
  const env = environment();
  const input = h('input', {
    id: 'code',
    name: 'code',
    type: 'text',
    inputmode: 'text',
    autocomplete: 'one-time-code',
    autocapitalize: 'characters',
    autocorrect: 'off',
    spellcheck: 'false',
    maxlength: '9',
    placeholder: 'XXXX-XXXX',
    'aria-describedby': 'code-error',
  });
  const error = h('p', { id: 'code-error', class: 'error', role: 'alert' });
  const button = h('button', { class: 'btn primary block', type: 'submit' }, 'Abbina');
  let busy = false;

  input.addEventListener('input', () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    input.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  });

  async function submit(ev) {
    ev.preventDefault();
    if (busy) return;
    const code = input.value.replace(/[^A-Za-z0-9]/g, '');
    if (code.length < 8) {
      error.textContent = 'Inserisci il codice di 8 caratteri.';
      return;
    }
    busy = true;
    button.disabled = true;
    error.textContent = '';
    try {
      await api.post('/api/pair', { code, label: env.ios ? 'iPhone' : 'Browser' });
      onSuccess();
    } catch (err) {
      error.textContent = messageFor(err);
      busy = false;
      button.disabled = false;
    }
  }

  const iosNote =
    env.ios && !env.standalone
      ? h(
          'div.banner.info',
          null,
          icon('info', { size: 20 }),
          h('div.grow', null, 'Su iPhone abbina il dispositivo dall\u2019app installata: aggiungi prima Cursor Pocket alla schermata Home (Condividi, poi Aggiungi alla schermata Home) e aprila da l\u00ec. Safari e l\u2019app non condividono l\u2019accesso.'),
        )
      : null;

  replace(
    root,
    h(
      'main.login',
      null,
      h('div.brand', null, logoImg(44), h('h1', null, 'Cursor Pocket')),
      h('p', null, 'Abbina questo dispositivo al daemon in esecuzione sul tuo Mac.'),
      h('form', { onSubmit: submit, novalidate: true }, h('div.field', null, h('label', { for: 'code' }, 'Codice di abbinamento'), input, error), button),
      h('p.hint', null, 'Sul Mac, dalla cartella del daemon, esegui ', h('code', null, 'npm run pair'), ' per ottenere un codice valido 15 minuti.'),
    ),
    iosNote,
  );
  input.focus({ preventScroll: true });
}

export function mountUnreachable(root, { onRetry }) {
  replace(
    root,
    h(
      'main',
      null,
      h('div.empty', null, icon('offline', { size: 32 }), h('h2', null, 'Daemon non raggiungibile'), h('p', null, 'Controlla che il daemon sia in esecuzione sul Mac e che Tailscale sia connesso.')),
      h('div.panel-actions', null, h('button', { class: 'btn primary', type: 'button', onClick: onRetry }, icon('refresh', { size: 18 }), 'Riprova')),
    ),
  );
}
