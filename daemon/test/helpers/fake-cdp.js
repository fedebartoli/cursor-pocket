// Server CDP finto per i test: HTTP (/json/version, /json/list) + WebSocket minimale (RFC 6455) su 127.0.0.1.
// Non e' un browser: risponde ai comandi con un gestore scritto dal test.
import crypto from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeText(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Estrae dal buffer tutti i frame completi (i client scrivono sempre con maschera). */
function takeFrames(state) {
  const frames = [];
  for (;;) {
    const b = state.buf;
    if (b.length < 2) break;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) break;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) break;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    const masked = (b[1] & 0x80) !== 0;
    const total = off + (masked ? 4 : 0) + len;
    if (b.length < total) break;
    const mask = masked ? b.subarray(off, off + 4) : null;
    const data = Buffer.from(b.subarray(off + (masked ? 4 : 0), total));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ opcode, data });
    state.buf = b.subarray(total);
  }
  return frames;
}

export class FakeCdp {
  /** @param {{ handler?: Function, targets?: object[] }} [opts] */
  constructor({ handler, targets } = {}) {
    this.handler = handler ?? (() => ({}));
    this.targets = targets ?? [{ id: 'PAGE0001', type: 'page', title: 'Cursor Agents', url: 'vscode-file://app/glass.html' }];
    this.commands = [];
    this.upgradeHeaders = [];
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.#http(req, res));
    this.server.on('upgrade', (req, socket) => this.#upgrade(req, socket));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  /** Chiude tutte le connessioni WebSocket aperte (simula Cursor che si chiude). */
  dropConnections() {
    for (const s of this.sockets) s.destroy();
  }

  #http(req, res) {
    const json = (obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.url === '/json/version') return json({ Browser: 'FakeChrome/1.0', 'Protocol-Version': '1.3' });
    if (req.url === '/json/list') {
      return json(
        this.targets.map((t) => ({
          description: '',
          webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? `ws://127.0.0.1:${this.port}/devtools/page/${t.id}`,
          ...t,
        })),
      );
    }
    res.writeHead(404);
    return res.end();
  }

  #upgrade(req, socket) {
    this.upgradeHeaders.push(req.headers);
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    const state = { buf: Buffer.alloc(0) };
    socket.on('data', async (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      for (const f of takeFrames(state)) {
        if (f.opcode === 8) return socket.end();
        if (f.opcode !== 1) continue;
        let msg;
        try {
          msg = JSON.parse(f.data.toString('utf8'));
        } catch {
          continue;
        }
        this.commands.push({ method: msg.method, params: msg.params });
        let reply;
        try {
          const result = await this.handler(msg.method, msg.params, this);
          if (result === 'NO_REPLY') continue; // per provare le scadenze
          reply = { id: msg.id, result: result ?? {} };
        } catch (err) {
          reply = { id: msg.id, error: { code: -32000, message: String(err?.message || err) } };
        }
        if (!socket.destroyed) socket.write(encodeText(JSON.stringify(reply)));
      }
    });
  }
}
