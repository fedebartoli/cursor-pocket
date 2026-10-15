#!/usr/bin/env node
// Generates the README screenshots from the demo server (synthetic data, English content).
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tools/readme-shots.mjs [outDir]
//
// Default output: docs/screenshots. Needs WebKit installed for playwright-core.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(HERE, '..', 'docs', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });
const { webkit, devices } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_CORE)).href : 'playwright-core');

const PORT = 8871;
const BASE = `http://127.0.0.1:${PORT}`;
const CHAT = (n) => `${BASE}/#/chat/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const browser = await webkit.launch();
let session = null; // the pairing code is single-use: the dark pass reuses the light pass session
try {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 2, locale: 'en-US', colorScheme: scheme, ...(session ? { storageState: session } : {}) });
    const page = await ctx.newPage();
    const suffix = scheme === 'dark' ? '-dark' : '';
    const shot = async (name) => {
      await sleep(400);
      await page.screenshot({ path: path.join(outDir, `${name}${suffix}.png`) });
      console.log('shot', `${name}${suffix}`);
    };

    await page.goto(`${BASE}/`);
    if (!session) {
      await page.waitForSelector('#code');
      await page.fill('#code', code);
      await page.click('button[type=submit]');
    }
    await page.waitForSelector('.row');
    session ??= await ctx.storageState();
    // The notification banner is not part of the story: dismiss it if it is there.
    await page.locator('.banner button[aria-label]').first().click({ timeout: 1500 }).catch(() => {});
    await shot('home');

    await page.goto(CHAT(1));
    await page.waitForSelector('.choice');
    await shot('question');

    await page.goto(CHAT(15));
    await page.waitForSelector('.decision');
    await shot('approval');

    await page.goto(CHAT(9));
    await page.waitForSelector('.chat-head');
    await shot('chat');

    await page.goto(`${BASE}/#/chat`);
    await page.waitForSelector('.row');
    await shot('chats');

    await page.goto(CHAT(8));
    await page.waitForSelector('a[href$="/storia"]');
    await page.locator('a[href$="/storia"]').click();
    await page.waitForSelector('.hist-msg');
    await shot('conversation');

    await page.goto(`${BASE}/#/nuova`);
    await page.waitForSelector('#newchat-project');
    await page.locator('#newchat-project [role=radio]', { hasText: 'showcase-site' }).click();
    await page.locator('.newchat button', { hasText: 'Choose branch and model' }).click();
    await page.waitForSelector('[role=radiogroup]', { timeout: 8000 });
    await page.locator('#newchat-text').fill('Add a contact page');
    await shot('new-chat');

    await page.goto(`${BASE}/#/impostazioni`);
    await page.waitForSelector('select.lang-select');
    await shot('settings');

    if (scheme === 'light') {
      for (const lang of ['ja', 'de', 'es']) {
        await page.evaluate((l) => localStorage.setItem('cp.lang', l), lang);
        await page.goto(`${BASE}/#/`);
        await page.reload();
        await page.waitForSelector('.row');
        await page.locator('.banner button[aria-label]').first().click({ timeout: 1000 }).catch(() => {});
        await shot(`lang-${lang}`);
      }
    }
    await ctx.close();
  }
  // Hero images: four screens side by side on a flat background (one per color scheme), for the top of the README.
  for (const scheme of ['light', 'dark']) {
    const suffix = scheme === 'dark' ? '-dark' : '';
    const uri = (n) => `data:image/png;base64,${fs.readFileSync(path.join(outDir, `${n}${suffix}.png`)).toString('base64')}`;
    const bg = scheme === 'dark' ? '#0d1117' : '#f3f4f6';
    const edge = scheme === 'dark' ? '#30363d' : '#d0d5dd';
    const html = `<!doctype html><body style="margin:0;background:${bg};display:flex;gap:28px;padding:40px;width:max-content">${['home', 'question', 'approval', 'new-chat']
      .map((n) => `<img src="${uri(n)}" style="width:300px;border-radius:30px;border:2px solid ${edge};display:block">`)
      .join('')}</body>`;
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.setContent(html);
    await sleep(300);
    const box = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    await page.setViewportSize({ width: box.w, height: box.h });
    await page.screenshot({ path: path.join(outDir, `hero${suffix}.png`) });
    console.log('shot', `hero${suffix}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
