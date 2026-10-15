#!/usr/bin/env node
// Records the short demo animation of the README (docs/screenshots/demo.gif and demo-dark.gif) from the demo server.
// It really clicks through the app: answer a question, then approve a command. Synthetic data, English content.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tools/readme-demo.mjs [outDir]
//
// Needs WebKit installed for playwright-core, and ffmpeg in the PATH.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(HERE, '..', 'docs', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });
const { webkit, devices } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_CORE)).href : 'playwright-core');

const PORT = 8872;
const BASE = `http://127.0.0.1:${PORT}`;
const CHAT = (n) => `${BASE}/#/chat/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, 'demo-server.mjs'), '--port', String(PORT), '--lang', 'en'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 80 && !/\(15 min\)/.test(log); i++) await sleep(100);
  const code = /\(15 min\): ([A-Z0-9-]+)/.exec(log)?.[1];
  if (!code) {
    console.error('demo server did not start:', log);
    server.kill();
    process.exit(1);
  }
  return { server, code };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-demo-gif-'));
const browser = await webkit.launch();
try {
  for (const scheme of ['light', 'dark']) {
    // Fresh demo server per pass: answering the question changes its state, and pairing codes are single-use.
    const { server, code } = await startServer();
    const suffix = scheme === 'dark' ? '-dark' : '';
    const ctx = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 2, locale: 'en-US', colorScheme: scheme });
    const page = await ctx.newPage();
    const frames = []; // { file, caption, ms }
    const snap = async (caption, ms = 1800) => {
      await sleep(450);
      const file = path.join(tmp, `${scheme}-${frames.length}.png`);
      await page.screenshot({ path: file });
      frames.push({ file, caption, ms });
    };

    await page.goto(`${BASE}/`);
    await page.waitForSelector('#code');
    await page.fill('#code', code);
    await page.click('button[type=submit]');
    await page.waitForSelector('.row');
    await page.locator('.banner button[aria-label]').first().click({ timeout: 1500 }).catch(() => {});
    await snap('An agent needs you: a red dot, and a push notification', 2200);

    await page.goto(CHAT(1));
    await page.waitForSelector('.choice');
    await snap('Open the chat and read the question', 1800);
    await page.locator('.choice').first().click();
    await snap('Pick an answer', 1200);
    await page.locator('.btn.primary.block').first().click();
    await page.waitForSelector('.choice', { state: 'detached', timeout: 15000 }).catch(() => {});
    await snap('Send it: Cursor gets it as if you typed it on the Mac', 2200);

    await page.goto(CHAT(15));
    await page.waitForSelector('.decision');
    await snap('A terminal command is waiting for approval', 2200);
    await page.locator('.decision .btn.primary').click();
    await snap('Tap twice to confirm, so nothing runs by accident', 1800);
    await page.locator('.decision .btn.primary').click();
    await page.waitForSelector('.decision', { state: 'detached', timeout: 15000 }).catch(() => {});
    await snap('Done. The agent keeps working', 2400);
    await ctx.close();

    // Compose each frame: caption on top, phone below, flat background.
    const bg = scheme === 'dark' ? '#0d1117' : '#f3f4f6';
    const fg = scheme === 'dark' ? '#e6edf3' : '#1f2328';
    const edge = scheme === 'dark' ? '#30363d' : '#d0d5dd';
    const cctx = await browser.newContext({ viewport: { width: 420, height: 725 }, deviceScaleFactor: 1.5 });
    const cpage = await cctx.newPage();
    const list = [];
    for (const [i, f] of frames.entries()) {
      const uri = `data:image/png;base64,${fs.readFileSync(f.file).toString('base64')}`;
      await cpage.setContent(`<!doctype html><body style="margin:0;background:${bg};width:420px;height:725px;display:flex;flex-direction:column;align-items:center;font:600 17px -apple-system,Helvetica,Arial,sans-serif;color:${fg}">
        <div style="height:64px;display:flex;align-items:center;text-align:center;padding:0 24px;box-sizing:border-box">${f.caption}</div>
        <img src="${uri}" style="width:300px;border-radius:30px;border:2px solid ${edge};display:block"></body>`);
      await sleep(200);
      const out = path.join(tmp, `${scheme}-frame-${String(i).padStart(2, '0')}.png`);
      await cpage.screenshot({ path: out });
      list.push({ out, ms: f.ms });
    }
    await cctx.close();

    const concat = path.join(tmp, `${scheme}.txt`);
    fs.writeFileSync(concat, list.map((f) => `file '${f.out}'\nduration ${f.ms / 1000}`).join('\n') + `\nfile '${list.at(-1).out}'\n`);
    const gif = path.join(outDir, `demo${suffix}.gif`);
    const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'scale=420:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none', '-loop', '0', gif], { stdio: 'inherit' });
    if (run.status !== 0) throw new Error('ffmpeg failed');
    console.log('gif', gif, Math.round(fs.statSync(gif).size / 1024), 'KB');
    server.kill();
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
