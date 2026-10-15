// Launches headless Chromium (Playwright's if present) with debug port, to exercise agents-ui.js on a
// real DOM. If no Chromium is available, tests that use this are skipped: the suite stays dependency-free.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CdpSession, listPageTargets, probeCdp } from '../../src/cursor/cdp.js';

export function findChromium() {
  const fromEnv = process.env.CP_TEST_CHROME;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const base = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  let dirs;
  try {
    dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const dir = path.join(base, d);
    for (const sub of fs.readdirSync(dir)) {
      const p = path.join(dir, sub, 'chrome-headless-shell');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Starts Chromium on local page `htmlPath`. Returns `{ port, evalPage(expr), close() }`. */
export async function launchChromium(htmlPath) {
  const bin = findChromium();
  if (!bin) throw new Error('no Chromium available');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-chromium-'));
  const child = spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=900,700', 'about:blank'], { stdio: 'ignore' });
  const close = async () => {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r)).catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 60; i++) {
      if ((await probeCdp(port, { timeoutMs: 500 })).up) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const [t] = await listPageTargets(port);
    const s = await CdpSession.open(t.wsUrl);
    await s.send('Page.enable');
    await s.send('Page.navigate', { url: pathToFileURL(htmlPath).toString() });
    for (let i = 0; i < 60; i++) {
      if (await s.evaluate('typeof window.__mock === "object"').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { port, evalPage: (expr) => s.evaluate(expr), close: async () => { s.close(); await close(); } };
  } catch (err) {
    await close();
    throw err;
  }
}
