// Device pairing with code generated on the Mac (`npm run pair`) and "daemon unreachable" screen.
import { api } from '../api.js';
import { logoImg } from '../components.js';
import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../i18n/index.js';
import { environment } from '../push.js';

function messageFor(err) {
  if (err.status === 0) return t('login.daemonUnreachable');
  if (err.status === 429) return t('login.tooManyAttempts');
  if (err.status === 401) return t('login.invalidCode');
  if (err.status === 403) return t('login.rejected');
  return err.message || t('login.pairFailed');
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
    placeholder: t('login.codePlaceholder'),
    'aria-describedby': 'code-error',
  });
  const error = h('p', { id: 'code-error', class: 'error', role: 'alert' });
  const button = h('button', { class: 'btn primary block', type: 'submit' }, t('login.pairButton'));
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
      error.textContent = t('login.codeTooShort');
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
      ? h('div.banner.info', null, icon('info', { size: 20 }), h('div.grow', null, t('login.iosBanner')))
      : null;

  replace(
    root,
    h(
      'main.login',
      null,
      h('div.brand', null, logoImg(44), h('h1', null, 'Cursor Pocket')),
      h('p', null, t('login.subtitle')),
      h('form', { onSubmit: submit, novalidate: true }, h('div.field', null, h('label', { for: 'code' }, t('login.codeLabel')), input, error), button),
      h('p.hint', null, t('login.hintBefore'), h('code', null, 'npm run pair'), t('login.hintAfter')),
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
      h('div.empty', null, icon('offline', { size: 32 }), h('h2', null, t('login.unreachableTitle')), h('p', null, t('login.unreachableBody'))),
      h('div.panel-actions', null, h('button', { class: 'btn primary', type: 'button', onClick: onRetry }, icon('refresh', { size: 18 }), t('login.retry'))),
    ),
  );
}
