// Builds site/img/og.png (1200x630 social preview) from the framed screenshots in docs/screenshots.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tools/og-image.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const core = process.env.PLAYWRIGHT_CORE ?? 'playwright-core';
const { chromium } = await import(core.startsWith('/') ? pathToFileURL(core).href : core);

const b64 = (f) => `data:image/png;base64,${fs.readFileSync(path.join(ROOT, f)).toString('base64')}`;
const mark = `data:image/svg+xml;base64,${fs.readFileSync(path.join(ROOT, 'site/img/mark.svg')).toString('base64')}`;

const html = `<!doctype html><body style="margin:0;width:1200px;height:630px;background:#f3f4f6;overflow:hidden;position:relative;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:#1f2328">
  <div style="position:absolute;left:64px;top:64px;display:flex;align-items:center;gap:16px;font-weight:600;font-size:30px">
    <img src="${mark}" width="52" height="52"> cursor-pocket
  </div>
  <div style="position:absolute;left:64px;top:190px;width:560px">
    <div style="font-size:60px;line-height:1.08;font-weight:700;letter-spacing:-1px">Your local Cursor chats, on your phone.</div>
    <div style="margin-top:28px;font-size:26px;line-height:1.4;color:#59636e">Read, reply, approve, start new chats. A push when an agent needs you. Open source, no cloud, no account.</div>
  </div>
  <img src="${b64('docs/screenshots/question.png')}" style="position:absolute;left:660px;top:60px;width:260px">
  <img src="${b64('docs/screenshots/approval.png')}" style="position:absolute;left:940px;top:60px;width:260px">
</body>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(ROOT, 'site/img/og.png') });
await browser.close();
console.log('og written');
