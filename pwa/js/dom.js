// Helper DOM minimale. Costruisce SOLO nodi di testo e attributi (mai innerHTML): i contenuti delle chat
// non possono diventare markup, e la CSP vieta comunque script e stili inline.

/**
 * h('div.card#id', { onClick, 'aria-label': 'x' }, figli...)
 * Il selettore accetta tag, `.classi` e `#id`.
 */
export function h(selector, props, ...children) {
  const m = /^([a-z][a-z0-9-]*)?((?:[.#][\w-]+)*)$/i.exec(selector);
  if (!m) throw new Error(`selettore non valido: ${selector}`);
  const el = document.createElement(m[1] || 'div');
  for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (props.nodeType || typeof props !== 'object' || Array.isArray(props))) {
    // props omesso: il secondo argomento e' gia' un figlio
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (/^on[A-Z]/.test(k) && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function replace(el, ...children) {
  el.replaceChildren();
  committed.delete(el);
  return append(el, children);
}

const committed = new WeakMap();

/**
 * Sostituisce il contenuto di `root` SOLO se il markup e' cambiato. I ridisegni identici (aggiornamento periodico degli
 * orari, snapshot uguali) non toccano il DOM: cosi' non si perdono selezione del testo, tocchi in corso e animazioni.
 * Ritorna true se il DOM e' stato sostituito.
 */
export function commit(root, ...children) {
  const holder = document.createElement('div');
  append(holder, children);
  const signature = holder.innerHTML; // sola lettura: serve a confrontare, non a inserire markup
  if (committed.get(root) === signature) return false;
  committed.set(root, signature);
  root.replaceChildren(...holder.childNodes);
  return true;
}

/** Da chiamare quando una nuova vista prende possesso di `root`: la prima commit deve sempre sostituire. */
export function forgetCommit(root) {
  committed.delete(root);
}
