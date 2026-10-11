// Client minimale del Chrome DevTools Protocol (CDP) verso la porta di debug di Cursor (Fase 2).
//
// Nessuna dipendenza: usa fetch e il WebSocket globali di Node 22.
// Sicurezza (vedi docs/ARCHITECTURE.md):
//  - ci si collega SOLO a loopback e alla porta configurata: l'URL del WebSocket restituito da /json/list viene
//    ricontrollato (host, porta, percorso), quindi un servizio diverso su quella porta non puo' dirottare il daemon;
//  - la sessione dura quanto una singola azione e non lascia nulla nella pagina (nessun `Runtime.enable`, nessun
//    breakpoint, nessuna variabile globale);
//  - mai log di contenuti: gli errori portano solo un codice e un messaggio fisso.
//
// Questo modulo non conosce Cursor: i selettori e gli script di pagina stanno in `agents-ui.js`.

export class CdpError extends Error {
  /** @param {string} code  codice stabile (`unavailable`, `timeout`, `closed`, `cdp_error`, `page_exception`, ...) */
  constructor(code, message) {
    super(message || code);
    this.name = 'CdpError';
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Valida l'URL WebSocket di un target: solo ws://loopback:<porta>/devtools/page/<id>. */
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
    throw new CdpError('unavailable', 'porta di debug non raggiungibile');
  }
  if (!res.ok) throw new CdpError('unavailable', 'risposta inattesa dalla porta di debug');
  try {
    return await res.json();
  } catch {
    throw new CdpError('unavailable', 'risposta non valida dalla porta di debug');
  }
}

/** La porta di debug risponde? Una sola richiesta HTTP breve, mai un'eccezione. */
export async function probeCdp(port, { timeoutMs = 1500 } = {}) {
  try {
    const v = await getJson(port, '/json/version', timeoutMs);
    return { up: true, browser: typeof v?.Browser === 'string' ? v.Browser.slice(0, 60) : null };
  } catch {
    return { up: false, browser: null };
  }
}

/** Target di tipo `page` con URL WebSocket valido: `{id, title, url, wsUrl}`. */
export async function listPageTargets(port, { timeoutMs = 2000 } = {}) {
  const list = await getJson(port, '/json/list', timeoutMs);
  if (!Array.isArray(list)) throw new CdpError('unavailable', 'elenco dei target non valido');
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

/** Tasti usati dalle azioni (valori standard di CDP). */
export const KEYS = Object.freeze({
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
});
export const MODIFIER = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });

/**
 * Sessione su un singolo target. Ogni richiesta ha una scadenza; alla chiusura quelle in volo falliscono.
 * `WebSocketImpl` e' iniettabile per i test.
 */
export class CdpSession {
  #ws;
  #next = 0;
  #pending = new Map();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => this.#fail(new CdpError('closed', 'connessione chiusa')));
    ws.addEventListener('error', () => this.#fail(new CdpError('closed', 'errore di connessione')));
  }

  static open(wsUrl, { connectTimeoutMs = 3000, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== 'function') return Promise.reject(new CdpError('unavailable', 'WebSocket non disponibile'));
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocketImpl(wsUrl);
      } catch {
        reject(new CdpError('unavailable', 'indirizzo non valido'));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // gia' chiuso
        }
        reject(new CdpError('timeout', 'connessione scaduta'));
      }, connectTimeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError('unavailable', 'connessione rifiutata'));
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
    if (typeof msg?.id !== 'number') return; // gli eventi non servono
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new CdpError('cdp_error', `${p.method}: ${String(msg.error.message || 'errore').slice(0, 120)}`));
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

  /** Invia un comando e attende la risposta. */
  send(method, params = {}, { timeoutMs = 10_000 } = {}) {
    if (this.#closed) return Promise.reject(new CdpError('closed', 'connessione chiusa'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError('timeout', `${method}: nessuna risposta`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError('closed', 'invio non riuscito'));
      }
    });
  }

  /**
   * Esegue un'espressione nella pagina e restituisce il valore (solo JSON). Un'eccezione nella pagina diventa
   * `CdpError('page_exception')` con un messaggio troncato: gli script di pagina non mettono mai contenuti nei messaggi.
   */
  async evaluate(expression, { timeoutMs = 10_000 } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      { timeoutMs },
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eccezione nella pagina';
      throw new CdpError('page_exception', String(d).split('\n')[0].slice(0, 160));
    }
    return r.result?.value;
  }

  /** Clic "vero" (eventi di input affidabili, come un utente) alle coordinate CSS della finestra. */
  async click(x, y, { clickCount = 1 } = {}) {
    const base = { x, y, button: 'left', clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }

  /** Inserisce testo nell'elemento che ha il focus (come un incolla/IME: genera `beforeinput` e `input`). */
  insertText(text) {
    return this.send('Input.insertText', { text });
  }

  /** Pressione di un tasto (keyDown + keyUp). `modifiers` e' una maschera di MODIFIER. */
  async pressKey(def, { modifiers = 0 } = {}) {
    await this.send('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', modifiers, ...def });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, nativeVirtualKeyCode: def.nativeVirtualKeyCode });
  }

  close() {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      // gia' chiuso
    }
    this.#fail(new CdpError('closed', 'sessione chiusa'));
  }
}
