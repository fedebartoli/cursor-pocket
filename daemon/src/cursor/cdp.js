// Minimal Chrome DevTools Protocol (CDP) client to Cursor's debug port (Phase 2).
//
// No dependencies: uses Node 22 global fetch and WebSocket.
// Security (see docs/ARCHITECTURE.md):
//  - connect ONLY to loopback and the configured port: the WebSocket URL from /json/list is
//    re-validated (host, port, path), so another service on that port cannot hijack the daemon;
//  - session lasts one action and leaves nothing in the page (no `Runtime.enable`, no
//    breakpoints, no global variables);
//  - never log content: errors carry only a code and a fixed message.
//
// This module does not know Cursor: selectors and page scripts live in `agents-ui.js`.

export class CdpError extends Error {
  /** @param {string} code  stable code (`unavailable`, `timeout`, `closed`, `cdp_error`, `page_exception`, ...) */
  constructor(code, message) {
    super(message || code);
    this.name = 'CdpError';
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Validates a target WebSocket URL: only ws://loopback:<port>/devtools/page/<id>. */
export function safeWsUrl(raw, port) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'ws:') return null;
  if (!LOOPBACK_HOSTS.has(u.hostname)) return null;
  if (Number(u.port) !== Number(port)) return null;
  if (!/^\/devtools\/page\/[A-Za-z0-9-]{8,64}$/.test(u.pathname)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u.toString();
}

async function getJson(port, path, timeoutMs) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch {
    throw new CdpError('unavailable', 'debug port unreachable');
  }
  if (!res.ok) throw new CdpError('unavailable', 'unexpected response from debug port');
  try {
    return await res.json();
  } catch {
    throw new CdpError('unavailable', 'invalid response from debug port');
  }
}

/** Does the debug port respond? One short HTTP request, never throws. */
export async function probeCdp(port, { timeoutMs = 1500 } = {}) {
  try {
    const v = await getJson(port, '/json/version', timeoutMs);
    return { up: true, browser: typeof v?.Browser === 'string' ? v.Browser.slice(0, 60) : null };
  } catch {
    return { up: false, browser: null };
  }
}

/** `page` targets with valid WebSocket URL: `{id, title, url, wsUrl}`. */
export async function listPageTargets(port, { timeoutMs = 2000 } = {}) {
  const list = await getJson(port, '/json/list', timeoutMs);
  if (!Array.isArray(list)) throw new CdpError('unavailable', 'invalid target list');
  const out = [];
  for (const t of list) {
    if (!t || t.type !== 'page') continue;
    const wsUrl = safeWsUrl(t.webSocketDebuggerUrl, port);
    if (!wsUrl) continue;
    out.push({
      id: String(t.id ?? ''),
      title: typeof t.title === 'string' ? t.title.slice(0, 120) : '',
      url: typeof t.url === 'string' ? t.url.slice(0, 300) : '',
      wsUrl,
    });
  }
  return out;
}

/** Keys used by actions (standard CDP values). */
export const KEYS = Object.freeze({
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
});
export const MODIFIER = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });

/**
 * Session on a single target. Each request has a timeout; on close in-flight ones fail.
 * `WebSocketImpl` is injectable for tests.
 */
export class CdpSession {
  #ws;
  #next = 0;
  #pending = new Map();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => this.#fail(new CdpError('closed', 'connection closed')));
    ws.addEventListener('error', () => this.#fail(new CdpError('closed', 'connection error')));
  }

  static open(wsUrl, { connectTimeoutMs = 3000, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== 'function') return Promise.reject(new CdpError('unavailable', 'WebSocket unavailable'));
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocketImpl(wsUrl);
      } catch {
        reject(new CdpError('unavailable', 'invalid address'));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // already closed
        }
        reject(new CdpError('timeout', 'connection timed out'));
      }, connectTimeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError('unavailable', 'connection refused'));
      });
    });
  }

  get closed() {
    return this.#closed;
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (typeof msg?.id !== 'number') return; // events are not needed
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new CdpError('cdp_error', `${p.method}: ${String(msg.error.message || 'error').slice(0, 120)}`));
    else p.resolve(msg.result ?? {});
  }

  #fail(err) {
    this.#closed = true;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.#pending.delete(id);
    }
  }

  /** Sends a command and waits for the response. */
  send(method, params = {}, { timeoutMs = 10_000 } = {}) {
    if (this.#closed) return Promise.reject(new CdpError('closed', 'connection closed'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError('timeout', `${method}: no response`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError('closed', 'send failed'));
      }
    });
  }

  /**
   * Evaluates an expression in the page and returns the value (JSON only). A page exception becomes
   * `CdpError('page_exception')` with a truncated message: page scripts never put content in messages.
   */
  async evaluate(expression, { timeoutMs = 10_000 } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      { timeoutMs },
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page exception';
      throw new CdpError('page_exception', String(d).split('\n')[0].slice(0, 160));
    }
    return r.result?.value;
  }

  /** Real click (reliable input events, like a user) at CSS window coordinates. */
  async click(x, y, { clickCount = 1 } = {}) {
    const base = { x, y, button: 'left', clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }

  /** Inserts text into the focused element (like paste/IME: fires `beforeinput` and `input`). */
  insertText(text) {
    return this.send('Input.insertText', { text });
  }

  /** Key press (keyDown + keyUp). `modifiers` is a MODIFIER bitmask. */
  async pressKey(def, { modifiers = 0 } = {}) {
    await this.send('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', modifiers, ...def });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, nativeVirtualKeyCode: def.nativeVirtualKeyCode });
  }

  close() {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
    this.#fail(new CdpError('closed', 'session closed'));
  }
}
