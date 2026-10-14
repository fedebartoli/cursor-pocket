// Minimal DOM helper. Builds ONLY text nodes and attributes (never innerHTML): chat content
// cannot become markup, and CSP forbids inline scripts and styles anyway.

/**
 * h('div.card#id', { onClick, 'aria-label': 'x' }, children...)
 * Selector accepts tag, `.classes`, and `#id`.
 */
export function h(selector, props, ...children) {
  const m = /^([a-z][a-z0-9-]*)?((?:[.#][\w-]+)*)$/i.exec(selector);
  if (!m) throw new Error(`invalid selector: ${selector}`);
  const el = document.createElement(m[1] || 'div');
  for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (props.nodeType || typeof props !== 'object' || Array.isArray(props))) {
    // props omitted: second argument is already a child
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
 * Replace `root` content ONLY if markup changed. Identical redraws (periodic time updates, same snapshots)
 * do not touch the DOM: so text selection, in-progress taps, and animations are not lost.
 * Returns true if the DOM was replaced.
 */
export function commit(root, ...children) {
  const holder = document.createElement('div');
  append(holder, children);
  const signature = holder.innerHTML; // read-only: used to compare, not to insert markup
  if (committed.get(root) === signature) return false;
  committed.set(root, signature);
  root.replaceChildren(...holder.childNodes);
  return true;
}

/** Call when a new view takes over `root`: the first commit must always replace. */
export function forgetCommit(root) {
  committed.delete(root);
}
