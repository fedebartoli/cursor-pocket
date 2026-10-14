// Immagini da allegare a un messaggio (compositore di una chat e "nuova chat"): pulsante, anteprime e caricamento.
// Ogni immagine si ridimensiona sul telefono e si carica subito sul daemon (resta li' al massimo 30 minuti o fino all'invio).
import { api } from './api.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { MAX_IMAGES, prepareImage } from './images.js';

/**
 * @param {{ onChange: () => void, onError: (text: string) => void, onNote?: (text: string) => void }} p
 */
export function createAttachments({ onChange, onError, onNote }) {
  const items = []; // { id, url, state: 'uploading' | 'ready' }
  let locked = false;
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const button = h('button', { class: 'attach', type: 'button', 'aria-label': 'Allega immagini' }, icon('image', { size: 22 }));
  const strip = h('div', { class: 'attach-strip', hidden: true });

  const full = () => items.length >= MAX_IMAGES;
  const refreshButton = () => {
    button.disabled = locked || full();
  };

  function draw() {
    strip.hidden = items.length === 0;
    strip.replaceChildren(
      ...items.map((it) =>
        h(
          'div',
          { class: `attach-item${it.state === 'uploading' ? ' loading' : ''}` },
          h('img', { src: it.url, alt: '' }),
          it.state === 'uploading' ? h('span', { class: 'attach-wait', 'aria-label': 'Caricamento' }, icon('spinner', { size: 18, className: 'spin' })) : null,
          h('button', { class: 'attach-remove', type: 'button', 'aria-label': 'Rimuovi immagine', onClick: () => remove(it) }, icon('close', { size: 14 })),
        ),
      ),
    );
    refreshButton();
  }

  function remove(it, { remote = true } = {}) {
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
    URL.revokeObjectURL(it.url);
    if (remote && it.id) api.del(`/api/uploads/${it.id}`).catch(() => {});
    draw();
    onChange();
  }

  async function add(files) {
    const room = MAX_IMAGES - items.length;
    if (files.length > room) onNote?.(`Al massimo ${MAX_IMAGES} immagini per messaggio.`);
    for (const file of files.slice(0, room)) {
      const it = { id: null, url: URL.createObjectURL(file), state: 'uploading' };
      items.push(it);
      draw();
      onChange();
      try {
        const blob = await prepareImage(file);
        if (!items.includes(it)) continue; // tolta nel frattempo
        URL.revokeObjectURL(it.url);
        it.url = URL.createObjectURL(blob);
        const r = await api.upload(blob);
        if (!items.includes(it)) {
          api.del(`/api/uploads/${r.id}`).catch(() => {});
          continue;
        }
        it.id = r.id;
        it.state = 'ready';
        draw();
        onChange();
      } catch (err) {
        remove(it, { remote: false });
        onError(err?.message || 'Immagine non caricata.');
      }
    }
  }

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) add(files);
  });

  return {
    button,
    strip,
    input,
    count: () => items.length,
    readyIds: () => items.filter((i) => i.state === 'ready').map((i) => i.id),
    uploading: () => items.some((i) => i.state === 'uploading'),
    setLocked(v) {
      locked = Boolean(v);
      refreshButton();
    },
    /** Dopo un invio riuscito il daemon ha gia' cancellato i file: si toglie solo l'anteprima. */
    clearLocal() {
      for (const it of [...items]) remove(it, { remote: false });
    },
    destroy() {
      for (const it of [...items]) remove(it);
    },
  };
}
