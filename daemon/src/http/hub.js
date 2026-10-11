// Hub SSE: tiene l'ultimo stato presentato e lo invia ai client collegati SOLO quando cambia.
import crypto from 'node:crypto';

const HEARTBEAT_MS = 25_000;

export class Hub {
  #clients = new Set();
  #hash = '';
  #version = 0;
  #payload = null;
  #beat = null;

  /** Ultimo payload `{version, state, status}` (null prima della prima scansione). */
  get current() {
    return this.#payload;
  }

  get clientCount() {
    return this.#clients.size;
  }

  /** Aggiorna lo stato; ritorna true se e' cambiato (e quindi e' stato inviato ai client). */
  update(state, status, at = Date.now()) {
    const body = JSON.stringify({ state, status });
    const h = crypto.createHash('sha1').update(body).digest('hex');
    if (h === this.#hash) return false;
    this.#hash = h;
    this.#version += 1;
    // `at` (quando il daemon ha generato lo stato) resta FUORI dall'hash: serve alla diagnostica del ritardo, non deve
    // far considerare "cambiato" uno stato uguale.
    this.#payload = { version: this.#version, at, state, status };
    const frame = Hub.frame(this.#payload);
    for (const res of this.#clients) this.#write(res, frame);
    return true;
  }

  static frame(payload) {
    return `event: state\nid: ${payload.version}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  #write(res, chunk) {
    try {
      res.write(chunk);
    } catch {
      this.#clients.delete(res);
    }
  }

  /** Registra una risposta come flusso SSE e invia subito lo stato corrente. */
  addClient(req, res, headers = {}) {
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    if (this.#payload) res.write(Hub.frame(this.#payload));
    this.#clients.add(res);
    const drop = () => this.#clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
    if (!this.#beat) {
      this.#beat = setInterval(() => {
        for (const c of this.#clients) this.#write(c, ': ping\n\n');
      }, HEARTBEAT_MS);
      this.#beat.unref();
    }
  }

  close() {
    if (this.#beat) clearInterval(this.#beat);
    this.#beat = null;
    for (const res of this.#clients) {
      try {
        res.end();
      } catch {
        // gia' chiusa
      }
    }
    this.#clients.clear();
  }
}
