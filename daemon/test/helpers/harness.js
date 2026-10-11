// Harness per i test di integrazione HTTP: app completa su porta effimera, con database Cursor sintetico.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/log.js';
import { CursorFixture, testConfig } from './fixture.js';

export const T0 = 1_700_000_200_000;

export function request(port, { method = 'GET', path: p = '/', headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = null;
    if (body !== undefined) {
      payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!h['Content-Type'] && typeof body !== 'string') h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function startHarness({ configOverrides = {}, files = {}, actionsDeps } = {}) {
  const fx = new CursorFixture();
  const pwaDir = path.join(fx.dir, 'pwa');
  fs.mkdirSync(pwaDir, { recursive: true });
  for (const [name, content] of Object.entries({ 'index.html': '<!doctype html><title>x</title>', 'sw.js': "const B='__BUILD_ID__';", 'app.js': 'x', ...files })) {
    const f = path.join(pwaDir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  fs.writeFileSync(path.join(fx.dir, 'fuori.txt'), 'SEGRETO-FUORI-DALLA-ROOT');

  const logLines = [];
  const logger = createLogger({ level: 'debug', stream: { write: (s) => logLines.push(s) } });
  const clock = { t: T0 };
  const sent = [];
  const send = async (p) => {
    sent.push(p);
    return { ok: true, status: 201 };
  };
  const config = { ...testConfig(fx, configOverrides), port: 0 };
  const app = createApp({ config, logger, now: () => clock.t, send, actionsDeps });
  await app.http.listen();
  const port = app.http.server.address().port;

  const h = {
    fx,
    app,
    port,
    clock,
    sent,
    logLines,
    pwaDir,
    req: (opts) => request(port, opts),
    tick(ms = 1000) {
      clock.t += ms;
      app.watcher.tick();
    },
    /** Abbina un "telefono" e restituisce l'intestazione Cookie. */
    async pair() {
      const { code } = app.auth.createPairingCode();
      const r = await request(port, { method: 'POST', path: '/api/pair', body: { code } });
      if (r.status !== 200) throw new Error(`pair fallito: ${r.status}`);
      return r.headers['set-cookie'][0].split(';')[0];
    },
    async stop() {
      await app.stop().catch(() => {});
      fx.close();
    },
  };
  return h;
}
