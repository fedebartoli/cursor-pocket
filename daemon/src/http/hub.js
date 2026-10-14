// SSE hub: holds the latest presented state and sends it to connected clients ONLY when it changes.
import crypto from 'node:crypto';

const HEARTBEAT_MS = 25_000;

export class Hub {
  #clients = new Set();
  #hash = '';
  #version = 0;
  #payload = null;
  #beat = null;

  /** Latest `{version, state, status}` payload (null before the first scan). */
  get current() {
    return this.#payload;
  }

  get clientCount() {
    return this.#clients.size;
  }

  /** Updates state; returns true if it changed (and was sent to clients). */
  update(state, status, at = Date.now()) {
    const body = JSON.stringify({ state, status });
    const h = crypto.createHash('sha1').update(body).digest('hex');
    if (h === this.#hash) return false;
    this.#hash = h;
    this.#version += 1;
    // `at` (when the daemon generated the state) stays OUTSIDE the hash: used for latency diagnostics, must not
    // make an identical state look "changed".
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

  /** Registers a response as an SSE stream and sends the current state immediately. */
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
        // already closed
      }
    }
    this.#clients.clear();
  }
}
