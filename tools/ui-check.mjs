// Browser verification of the PWA on real browsers (Chromium and WebKit, Safari's engine) with iPhone viewport, against the
// demo server (`tools/demo-server.mjs`: mock Cursor database, no real data and no Cursor involved).
//
// OPTIONAL development tool: the repository does not depend on Playwright. Requires `playwright-core` (and browsers
// installed with `npx playwright install chromium webkit`) wherever you prefer; if it cannot be resolved from here,
// point to the file with PLAYWRIGHT_CORE (e.g. .../node_modules/playwright-core/index.mjs).
//
//   node tools/ui-check.mjs [chromium|webkit] [--shots] [--dark]
//
// `--shots` saves screenshots to the system temp folder (prints the path); `--dark` emulates the phone's dark theme.
// In WebKit, Playwright screenshots trigger spurious CSP errors, which are ignored; for strict CSP checking run
// without `--shots`. Exit code 1 if a check fails.
// What CANNOT be tested here: real iOS behavior (double-tap zoom, keyboard, fullscreen PWA); only logic, CSS and DOM
// in rendering engines are tested.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadPlaywright() {
  try {
    return await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_CORE)).href : 'playwright-core');
  } catch {
    console.error('playwright-core not found. Install it (npm i -D playwright-core in a separate folder) or set PLAYWRIGHT_CORE.');
    process.exit(2);
  }
}
const { chromium, webkit, devices } = await loadPlaywright();
const HERE = path.dirname(fileURLToPath(import.meta.url));

const engineName = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'chromium';
const shots = process.argv.includes('--shots');
const dark = process.argv.includes('--dark');
const engine = engineName === 'webkit' ? webkit : chromium;
const PORT = 8799 + (engineName === 'webkit' ? 1 : 0);
const BASE = `http://127.0.0.1:${PORT}`;
const CHAT = (n) => `${BASE}/#/chat/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const outDir = path.join(os.tmpdir(), `cursor-pocket-shots-${engineName}${dark ? '-dark' : ''}`);
if (shots) {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Screenshots in ${outDir}`);
}

// --- demo server ---------------------------------------------------------------------------------------------
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, 'demo-server.mjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
for (let i = 0; i < 60 && !/Codice di abbinamento/.test(serverLog); i++) await new Promise((r) => setTimeout(r, 100));
const code = /\(15 min\): ([A-Z0-9-]+)/.exec(serverLog)?.[1];
if (!code) {
  console.error('demo server failed to start:', serverLog);
  server.kill();
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await engine.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'it-IT', colorScheme: dark ? 'dark' : 'light' });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Content Security Policy|CSP|violat/i.test(t) || m.type() === 'error') {
    const loc = m.location();
    const line = `${m.type()}: ${t.slice(0, 160)} @ ${page.url().split('#')[1] ?? ''} (${loc.url?.split('/').slice(-2).join('/')}:${loc.lineNumber})`;
    // WebKit refuses its own built-in <select> stylesheet under 'style-src self' (reproducible with a bare <select>
    // and no app code): it is a WebKit artifact, not an app violation.
    const webkitSelectArtifact = engineName === 'webkit' && /Refused to apply a stylesheet/.test(t) && page.url().includes('/impostazioni');
    if (!webkitSelectArtifact && !problems.includes(line)) problems.push(line);
  }
});
page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message).slice(0, 160)}`));
const shot = async (name) => {
  if (!shots) return;
  const before = problems.length;
  await new Promise((r) => setTimeout(r, 300)); // allow screen fade transitions to finish
  await page.screenshot({ path: `${outDir}/${name}.png` });
  await new Promise((r) => setTimeout(r, 150));
  // Playwright artifact: in WebKit the screenshot injects a style the page CSP rejects. Only those messages
  // appearing during the screenshot are discarded; strict CSP checking is running without --shots.
  for (let i = problems.length - 1; i >= before; i--) if (/Refused to apply a stylesheet/.test(problems[i])) problems.splice(i, 1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // --- pairing ---
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#code');
  check('login: Cursor logo present', (await page.locator('.brand img[src="/icons/cursor-logo.svg"]').count()) === 1);
  await shot('00-login');
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await page.waitForSelector('.appbar-logo');

  // --- home: logo top left ---
  await page.waitForSelector('.row');
  const logoBox = await page.locator('.appbar .appbar-logo').boundingBox();
  const titleBox = await page.locator('.appbar .appbar-title').boundingBox();
  check('home: Cursor logo top left', logoBox && logoBox.x < 24 && logoBox.y < 40 && logoBox.x + logoBox.width < titleBox.x + 4, JSON.stringify(logoBox));
  check('home: logo loaded (SVG decoded)', await page.evaluate(() => { const i = document.querySelector('.appbar-logo'); return i.complete && i.naturalWidth > 0; }));
  await shot('01-home');

  // --- bottom bar, rows, gestures, formatting ---
  const tabbarEl = page.locator('.tabbar');
  check('bottom bar: visible on home with "Attenzione" active and four items', (await tabbarEl.isVisible()) && (await tabbarEl.locator('.tab[aria-current=page]').innerText()).includes('Attenzione') && (await tabbarEl.locator('.tab').count()) === 4);
  const tbBox = await tabbarEl.boundingBox();
  const vpH = page.viewportSize().height;
  check('bottom bar: pinned to bottom, buttons at least 44px tall', tbBox && tbBox.y + tbBox.height >= vpH - 1 && (await page.locator('.tab').first().boundingBox()).height >= 44, JSON.stringify(tbBox));
  const attCount = await page.locator('.section-head.danger .count').first().innerText();
  check('bottom bar: badge reflects chats needing attention', (await page.locator('.tab-badge').innerText()) === attCount, `${await page.locator('.tab-badge').innerText()} / ${attCount}`);
  check('home: no "Impostazioni" icon in header (it\'s in the bar)', (await page.locator('.appbar [aria-label=Impostazioni]').count()) === 0);
  const attRow = page.locator('.swipe .row').first();
  check('row: title, project and status on separate lines', (await attRow.locator('.row-title').isVisible()) && (await attRow.locator('.row-meta').isVisible()) && (await attRow.locator('.row-state svg').count()) === 1);
  check('row: attention state in red (not just the dot)', await attRow.locator('.row-state.attention').isVisible());
  // swipe: dragging the row left reveals "Ignora" without opening the chat
  const swipeBox = await page.locator('.swipe').nth(1).boundingBox();
  const sy = swipeBox.y + swipeBox.height / 2;
  const hashBefore = await page.evaluate(() => location.hash);
  await page.mouse.move(swipeBox.x + swipeBox.width - 30, sy);
  await page.mouse.down();
  await page.mouse.move(swipeBox.x + swipeBox.width - 70, sy, { steps: 4 });
  await page.mouse.move(swipeBox.x + swipeBox.width - 130, sy, { steps: 4 });
  await page.mouse.up();
  await sleep(350);
  check('gesture: swipe left reveals "Ignora"', await page.locator('.swipe.open').count() === 1);
  check('gesture: chat does not open after drag', (await page.evaluate(() => location.hash)) === hashBefore);
  const openBox = await page.locator('.swipe.open .row').boundingBox();
  check('gesture: swipe rows allow vertical pan and pinch only (no double-tap zoom)', (await page.evaluate(() => getComputedStyle(document.querySelector('.swipe .row')).touchAction)) === 'pan-y pinch-zoom');
  check('gesture: row shifts by roughly the button width', openBox && Math.abs(openBox.x - (swipeBox.x - 96)) < 6, JSON.stringify(openBox));
  await page.mouse.click(swipeBox.x + 40, 140); // tap elsewhere (header): closes
  await sleep(350);
  check('gesture: tap elsewhere closes the row', (await page.locator('.swipe.open').count()) === 0);
  check('gesture: simple tap still opens the chat', await (async () => {
    await page.locator('.swipe .row').first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/chat/'), null, { timeout: 5000 });
    await page.goBack();
    await page.waitForSelector('.swipe');
    return true;
  })());

  // --- tabs: Chat (with search), Preferite, Come funziona ---
  await page.locator('.tabbar .tab', { hasText: 'Chat' }).click();
  await page.waitForSelector('.search-input');
  await sleep(200);
  check('Chat tab: title, search and groups by project', (await page.locator('.appbar-title').innerText()) === 'Chat' && (await page.locator('.section-head', { hasText: 'negozio-online' }).count()) >= 1 && (await page.locator('.section-head', { hasText: 'Richiedono attenzione' }).count()) === 0);
  check('Chat tab: active item is Chat', (await page.locator('.tab[aria-current=page]').innerText()).includes('Chat'));
  const allRows = await page.locator('.row').count();
  await page.locator('.search-input').fill('carrello');
  await sleep(250);
  check('search: filters by title and keeps field focused', (await page.locator('.list .row').count()) === 1 && (await page.locator('.list .row-title').first().innerText()).toLowerCase().includes('carrello') && (await page.evaluate(() => document.activeElement?.classList.contains('search-input'))));
  await page.locator('.search-input').fill('zzzz-non-esiste');
  await sleep(250);
  check('search: no results', await page.locator('.empty h2', { hasText: 'Nessun risultato' }).isVisible());
  await page.locator('.search-clear').click();
  await sleep(250);
  check('search: clearing restores all chats', (await page.locator('.row').count()) === allRows);
  await shot('11-chat-tab');
  const vh = page.viewportSize().height;
  await page.evaluate(() => { const a = document.getElementById('app'); a.scrollTop = a.scrollHeight; });
  await sleep(250);
  const tb2 = await page.locator('.tabbar').boundingBox();
  check('bottom bar: stays pinned after scroll', tb2 && Math.abs(tb2.y + tb2.height - vh) <= 1, JSON.stringify(tb2));
  const sc = await page.evaluate(() => ({ app: document.getElementById('app').scrollTop, doc: Math.round(window.scrollY), over: document.documentElement.scrollHeight - window.innerHeight }));
  check('bottom bar: only content scrolls, document stays fixed', sc.app > 0 && sc.doc === 0 && sc.over <= 1, JSON.stringify(sc));
  await page.evaluate(() => { document.getElementById('app').scrollTop = 0; });

  // heart: from chat page; appears in Preferite and can be removed there
  await page.goto(CHAT(2));
  await page.waitForSelector('.chat-head');
  await page.locator('.appbar [aria-label="Aggiungi alle preferite"]').click();
  await page.waitForSelector('.appbar [aria-label="Togli dalle preferite"]', { timeout: 8000 });
  check('chat: heart adds chat to favorites', true);
  await page.goto(`${BASE}/#/preferite`);
  await page.waitForSelector('.list .row');
  check('Preferite tab: hearted chat is listed', (await page.locator('.list .row').count()) === 1 && (await page.locator('.list .row-title').first().innerText()).includes('Migrazione'));
  await shot('12-favorites');
  await page.locator('.list .row').first().click();
  await page.waitForSelector('.appbar [aria-label="Togli dalle preferite"]');
  await page.locator('.appbar [aria-label="Togli dalle preferite"]').click();
  await page.waitForSelector('.appbar [aria-label="Aggiungi alle preferite"]', { timeout: 8000 });
  await page.goto(`${BASE}/#/preferite`);
  await page.waitForSelector('.empty');
  check('Preferite tab: empty state when no favorites', await page.locator('.empty h2', { hasText: 'Nessuna preferita' }).isVisible());

  // mute: chat (bell on chat page) and projects/hours (Impostazioni)
  await page.goto(CHAT(2));
  await page.waitForSelector('.chat-head');
  await page.locator('.appbar [aria-label="Silenzia le notifiche di questa chat"]').click();
  await page.waitForSelector('.appbar [aria-label="Riattiva le notifiche di questa chat"]', { timeout: 8000 });
  await page.goto(`${BASE}/#/chat`);
  await page.waitForSelector('.list .row');
  check('muted chat: row shows struck bell', (await page.locator('.row', { hasText: 'Migrazione della tabella ordini' }).locator('.row-side svg').count()) === 1);
  await page.goto(CHAT(2));
  await page.waitForSelector('.chat-head');
  await page.locator('.appbar [aria-label="Riattiva le notifiche di questa chat"]').click();
  await page.waitForSelector('.appbar [aria-label="Silenzia le notifiche di questa chat"]', { timeout: 8000 });
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('.switch');
  check('settings: quiet hours and muted projects with toggles', (await page.locator('.panel-title', { hasText: 'Orari senza notifiche' }).isVisible()) && (await page.locator('.panel-title', { hasText: 'Progetti silenziati' }).isVisible()) && (await page.locator('.switch').count()) >= 4);
  await page.locator('.switch[aria-label="Silenzio programmato"]').click();
  await page.waitForSelector('.time-field', { timeout: 8000 });
  check('quiet hours: enabling shows From and To fields', (await page.locator('.time-field input').count()) === 2 && (await page.locator('.switch[aria-label="Silenzio programmato"]').getAttribute('aria-checked')) === 'true');
  await shot('13-quiet-settings');
  await page.locator('.switch[aria-label="Silenzio programmato"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.time-field').length === 0, null, { timeout: 8000 });

  // "Come funziona" is under Impostazioni and holds explanations removed from other screens
  await page.goto(`${BASE}/#/impostazioni`);
  await page.locator('.help-link[href="#/come-funziona"]').click();
  await page.waitForSelector('.help-list');
  check('"Come funziona": reachable from Impostazioni, Impostazioni active in bar', (await page.locator('.tab[aria-current=page]').innerText()).includes('Impostazioni') && (await page.locator('.help-list li').count()) >= 6);
  await page.goto(CHAT(1));
  await page.waitForSelector('.panel.attention');
  check('chat: no fixed explanation note in panel', !(await page.locator('.panel.attention').innerText()).includes('come se la scegliessi') && !(await page.locator('.panel.attention').innerText()).includes('toglie solo il pallino'));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.swipe');

  // --- styling: zoom and fields ---
  const styles = await page.evaluate(() => {
    const ta = (sel) => (document.querySelector(sel) ? getComputedStyle(document.querySelector(sel)) : null);
    return {
      html: getComputedStyle(document.documentElement).touchAction,
      body: getComputedStyle(document.body).touchAction,
      row: ta('.list > .swipe .row')?.touchAction === 'pan-y pinch-zoom' ? 'manipulation' : ta('.list > .swipe .row')?.touchAction, // swipe rows: pan-y + pinch-zoom = no double-tap zoom
      btn: ta('.icon-btn')?.touchAction,
    };
  });
  check('touch-action manipulation on html/body/rows/buttons', Object.values(styles).every((v) => v === 'manipulation'), JSON.stringify(styles));

  // --- ignored question: can still answer ("even after hours or days" rule), "Ripristina" reactivates it ---
  await page.goto(CHAT(1));
  await page.waitForSelector('.choice[role=radio]');
  await page.locator('button:has-text("Ignora")').click();
  await page.waitForSelector('.panel-title:has-text("ignorata")', { timeout: 8000 });
  check('chat 1: after "Ignora" question is still answerable (clickable options)', (await page.locator('.choice[role=radio]').count()) === 3 && (await page.locator('.choice[role=radio]').first().isEnabled()));
  check('chat 1: button becomes "Ripristina"', await page.locator('button:has-text("Ripristina")').isVisible());
  await page.locator('button:has-text("Ripristina")').click();
  await page.waitForFunction(() => !document.body.innerText.includes('(ignorata)'), null, { timeout: 8000 });
  check('chat 1: "Ripristina" returns question to needing attention', (await page.locator('button:has-text("Ignora")').isVisible()) && (await page.locator('.choice[role=radio]').count()) === 3);

  // --- single question ---
  await page.goto(CHAT(1));
  await page.waitForSelector('.choice');
  await sleep(300);
  check('chat 1: actions state "ok" (interactive questionnaire, not read-only)', (await page.locator('.choice[role=radio]').count()) === 3, 'opzioni+altro=3');
  check('chat 1: no "read-only" text in panel', (await page.locator('.options').count()) === 0);
  await shot('02-question');
  const submit = page.locator('button:has-text("Invia risposta")');
  check('chat 1: submit disabled without choice', await submit.isDisabled());
  await page.locator('.choice', { hasText: 'Dopo la spedizione' }).click();
  check('chat 1: option selected', (await page.locator('.choice[aria-checked=true]').count()) === 1);
  check('chat 1: submit enabled after choice', await submit.isEnabled());
  // Altro: shows field, deselects option (single choice)
  await page.locator('.choice.other').click();
  check('chat 1: "Altro" shows free-text field', await page.locator('textarea.field-input').isVisible());
  check('chat 1: "Altro" deselects options (single)', (await page.locator('.choice[aria-checked=true]').count()) === 1 && (await page.locator('.choice.other[aria-checked=true]').count()) === 1);
  check('chat 1: submit disabled with empty "Altro"', await submit.isDisabled());
  const fs16 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('textarea.field-input')).fontSize));
  check('free-text field: font >= 16px (no zoom on focus)', fs16 >= 16, `${fs16}px`);
  const focused = await page.evaluate(() => document.activeElement?.className);
  check('chat 1: focus in free-text field after tapping "Altro"', /field-input/.test(focused ?? ''), focused);
  await page.fill('textarea.field-input', 'Dipende dal paese del cliente');
  check('chat 1: submit enabled with free text', await submit.isEnabled());
  // back to a normal option
  await page.locator('.choice', { hasText: 'Prima della spedizione' }).click();
  check('chat 1: choosing an option closes free-text field', !(await page.locator('textarea.field-input').isVisible()));

  // live update must not break selection: force a render
  await page.evaluate(() => window.dispatchEvent(new Event('hashchange')));
  await sleep(200);
  // (hashchange remounts view: selection is form state, so it resets; here we only check there are no errors)
  await page.locator('.choice', { hasText: 'Dopo la spedizione' }).click();
  await submit.click();
  await page.waitForSelector('text=Risposta inviata', { timeout: 8000 });
  check('chat 1: outcome "Risposta inviata"', true);
  // questionnaire disappears immediately, but confirmation stays visible in composer for a few seconds
  await page.waitForFunction(() => !document.querySelector('.choice'), null, { timeout: 15000 }).catch(() => {});
  check('chat 1: confirmation stays visible after questionnaire disappears', await page.locator('.dock-status', { hasText: 'Risposta inviata' }).isVisible());
  await shot('03-answered');
  check('chat 1: after answer, "in attesa dell\u2019agente" panel appears (no apparent block)', await page.locator('.activity .panel-title', { hasText: 'in attesa' }).isVisible());
  // daemon records answer: question panel disappears
  await page.waitForFunction(() => !document.querySelector('.choice'), null, { timeout: 15000 }).then(
    () => check('chat 1: after answer questionnaire disappears (state updated)', true),
    () => check('chat 1: after answer questionnaire disappears (state updated)', false),
  );

  // --- two questions, one multiple choice ---
  await page.goto(CHAT(14));
  await page.waitForSelector('.choice');
  const radios = await page.locator('.choice[role=radio]').count();
  const checks = await page.locator('.choice[role=checkbox]').count();
  check('chat 14: one single-choice (radio) and one multiple (checkbox)', radios === 4 && checks === 5, `radio=${radios} checkbox=${checks}`);
  const submit2 = page.locator('button:has-text("Invia risposta")');
  check('chat 14: reminder "Mancano le risposte a 2 domande"', await page.locator('text=Mancano le risposte a 2 domande').isVisible());
  await page.locator('.question').nth(0).locator('.choice', { hasText: 'Solo di giorno' }).click();
  check('chat 14: with one question answered submit stays disabled', await submit2.isDisabled());
  const q2 = page.locator('.question').nth(1);
  await q2.locator('.choice', { hasText: 'Nuovi messaggi' }).click();
  await q2.locator('.choice', { hasText: 'Promemoria' }).click();
  check('chat 14: multiple choice accepts two options', (await q2.locator('.choice[aria-checked=true]').count()) === 2);
  await q2.locator('.choice', { hasText: 'Promemoria' }).click();
  check('chat 14: multiple choice allows removing an option', (await q2.locator('.choice[aria-checked=true]').count()) === 1);
  check('chat 14: now complete', await submit2.isEnabled());
  await shot('04-multi');
  // Skip button asks for confirmation
  const skipBtn = page.locator('button:has-text("Salta")');
  await skipBtn.click();
  check('chat 14: "Salta" asks for second confirmation', await page.locator('button:has-text("Tocca ancora per saltare")').isVisible());
  await sleep(4300);
  check('chat 14: "Salta" confirmation expires on its own', await page.locator('button:has-text("Salta")').isVisible());
  await submit2.click();
  await page.waitForSelector('text=Risposta inviata', { timeout: 8000 });
  check('chat 14: two-question answer sent', true);

  // --- pending approval (reviewData Requested) ---
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.row');
  const apRow = page.locator('.row', { hasText: 'Pubblicazione del pacchetto' });
  check('home: approval row names it', (await apRow.locator('text=Approvazione richiesta').count()) >= 1);
  await page.goto(CHAT(15));
  await page.waitForSelector('.panel.attention');
  await sleep(300);
  check('chat 15: "Approvazione richiesta" panel with action type', (await page.locator('.panel-title', { hasText: 'Approvazione richiesta' }).isVisible()));
  check('chat 15: shows command to decide and description', (await page.locator('.cmd', { hasText: 'npm publish --access public' }).isVisible()));
  check('chat 15: Esegui and Rifiuta buttons with SVG icon', (await page.locator('.decision .btn svg').count()) === 2);
  check('chat 15: no questionnaire and no composer (with pending approval daemon would reject message)', (await page.locator('.choice').count()) === 0 && (await page.locator('.dock').isHidden()));
  const apTitle = page.locator('.panel.attention .panel-title');
  check('chat 15: SVG icon in title, no emoji', (await apTitle.locator('svg').count()) === 1 && !/\p{Extended_Pictographic}/u.test(await apTitle.innerText()));
  await shot('08-approval');
  await page.locator('button:has-text("Ignora")').click();
  await page.waitForSelector('.panel-title:has-text("ignorata")', { timeout: 8000 });
  check('chat 15: after "Ignora" panel says so, composer stays hidden (daemon would reject message)', await page.locator('.dock').isHidden());
  await page.locator('button:has-text("Ripristina")').click();
  await page.waitForSelector('.panel.attention', { timeout: 8000 });
  check('chat 15: "Ripristina" returns approval to needing attention', await page.locator('.panel-title.danger').isVisible());

  // Rifiuta (chat 17): same caution, first tap alone does not decide
  await page.goto(CHAT(17));
  await page.waitForSelector('.cmd');
  check('chat 17: shows description and command', (await page.locator('.panel-detail', { hasText: 'Svuota la cache locale' }).isVisible()) && (await page.locator('.cmd', { hasText: 'rm -rf ./tmp/cache' }).isVisible()));
  await page.locator('.decision .btn:not(.primary)').click();
  check('chat 17: first tap on Rifiuta arms button', (await page.locator('.decision .btn.armed').count()) === 1);
  await shot('08c-reject-armed');
  await page.waitForFunction(() => document.querySelectorAll('.decision .btn.armed').length === 0, null, { timeout: 9000 });
  check('chat 17: without second tap button disarms on its own', true);
  await page.locator('.decision .btn:not(.primary)').click();
  await sleep(200);
  await page.locator('.decision .btn:not(.primary)').click();
  await page.waitForSelector('.panel.attention', { state: 'detached', timeout: 15000 });
  check('chat 17: after Rifiuta request disappears', true);

  // Esegui (chat 19): first tap arms, second sends (no send on first tap)
  await page.goto(CHAT(19));
  await page.waitForSelector('.cmd');
  await page.locator('.decision .btn.primary').click();
  check('chat 19: first tap on Esegui arms button and does not send', (await page.locator('.decision .btn.primary.armed').count()) === 1 && (await page.locator('.panel-title.danger').isVisible()));
  await sleep(300);
  await page.locator('.decision .btn.primary').click();
  await page.waitForFunction(() => !document.querySelector('.decision') || document.querySelector('.decision .btn[disabled]'), null, { timeout: 8000 });
  await page.waitForSelector('.panel.attention', { state: 'detached', timeout: 15000 });
  check('chat 19: after Esegui request disappears from panel', (await page.locator('.cmd').count()) === 0);
  await shot('08b-approval-done');

  // Non-terminal request (chat 18): cannot decide here, explains why
  await page.goto(CHAT(18));
  await page.waitForSelector('.panel.attention');
  await sleep(400);
  check('chat 18: non-terminal request: no buttons, explains to decide on Mac', (await page.locator('.decision').count()) === 0 && (await page.locator('.panel-note', { hasText: 'sul Mac' }).isVisible()));

  // "Ignora" from row: chat leaves "Richiedono attenzione"; "Ripristina" (chat page) brings it back
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.swipe');
  const prefRow = page.locator('.swipe', { hasText: 'Pubblicazione del pacchetto' });
  const pb = await prefRow.boundingBox();
  await page.mouse.move(pb.x + pb.width - 30, pb.y + pb.height / 2);
  await page.mouse.down();
  await page.mouse.move(pb.x + pb.width - 80, pb.y + pb.height / 2, { steps: 4 });
  await page.mouse.move(pb.x + pb.width - 140, pb.y + pb.height / 2, { steps: 4 });
  await page.mouse.up();
  await sleep(300);
  await prefRow.locator('.swipe-action').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.swipe')].some((e) => e.innerText.includes('Pubblicazione del pacchetto')), null, { timeout: 8000 });
  await sleep(300);
  // Only the "Richiedono attenzione" section: "In corso" chats are in another list and do not count toward the badge.
  const nRows = await page.evaluate(() => {
    const head = [...document.querySelectorAll('*')].find((e) => e.children.length < 4 && /^Richiedono attenzione/.test((e.innerText || '').trim()) && e.nextElementSibling?.classList.contains('list'));
    return head ? head.nextElementSibling.querySelectorAll('.swipe').length : 0;
  });
  check('gesture: "Ignora" from row removes chat from needing attention (badge consistent)', nRows === 0 ? await page.locator('.tab-badge').isHidden() : Number(await page.locator('.tab-badge').innerText()) === nRows, `righe ${nRows}`);
  await page.goto(CHAT(15));
  await page.locator('button:has-text("Ripristina")').click();
  await page.waitForSelector('.panel.attention', { timeout: 8000 });
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.swipe');
  check('gesture: after "Ripristina" chat is back among those needing attention', (await page.locator('.swipe', { hasText: 'Pubblicazione del pacchetto' }).count()) === 1);

  // pull to refresh (real touch events: Chromium only)
  if (engineName === 'chromium') {
    const cdp = await ctx.newCDPSession(page);
    let stateReqs = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/state')) stateReqs += 1; });
    await page.evaluate(() => { document.getElementById('app').scrollTop = 0; });
    const t0 = stateReqs;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 200 }] });
    for (let y = 215; y <= 335; y += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
    const o = await page.evaluate(() => getComputedStyle(document.querySelector('.ptr')).opacity);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
    check('pull to refresh: indicator appears and, past threshold, reloads state', Number(o) > 0.9 && stateReqs > t0, `opacita' ${o}, richieste ${stateReqs - t0}`);
    const t1 = stateReqs;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 200 }] });
    for (let y = 205; y <= 225; y += 5) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    check('pull to refresh: short drag does not refresh', stateReqs === t1, `richieste ${stateReqs - t1}`);
  }

  // --- bottom bar across screens, formatted agent text ---
  await page.goto(CHAT(9));
  await page.waitForSelector('.message');
  check('chat: bottom bar absent (composer at bottom)', await page.locator('.tabbar').isHidden());
  await shot('09-message-list');
  check('chat: agent message has formatted lists', (await page.locator('.message ul.md-list li').count()) >= 3);
  await page.goto(CHAT(4));
  await page.waitForSelector('.message');
  await shot('10-message-code');
  check('chat: code block, bold and inline code formatted', (await page.locator('.message pre.md-code').count()) === 1 && (await page.locator('.message strong').innerText()) === 'verdi' && (await page.locator('.message .md-inline-code').innerText()) === 'jest');
  check('chat: text with HTML tags stays text (no script in DOM)', (await page.locator('.message script').count()) === 0 && (await page.locator('.message').innerText()).includes('<script>alert(1)</script>'));
  await page.goto(CHAT(16));
  await page.waitForSelector('.panel.attention');
  const prep = await page.locator('.panel.attention').innerText();
  check('chat: live question without text: "sta preparando la domanda" instead of "Apri Cursor sul Mac"', prep.includes('sta preparando la domanda') && !prep.includes('Apri Cursor sul Mac'));
  await shot('10a-preparing');
  await page.goto(CHAT(4));
  await page.waitForSelector('.message');
  check('chat: idle chat with history: "Attivit\u00e0 recente" panel', (await page.locator('.activity .panel-title').innerText()).includes('Attivit\u00e0 recente') && (await page.locator('.activity .activity-row').count()) >= 2);
  await page.goto(CHAT(2));
  await page.waitForSelector('.activity-row');
  await shot('10b-activity');
  const actText = await page.locator('.activity').innerText();
  check('chat: in-progress chat: "L\u2019agente sta lavorando" with steps (action type) and command in progress', actText.includes('sta lavorando') && actText.includes('Esegue un comando') && actText.includes('in corso') && actText.includes('Modifica un file') && actText.includes('Legge un file'));
  check('chat: steps do not show commands or paths', !actText.includes('npm test') && !actText.includes('/demo'));
  check('chat: step icons are SVG (no emoji)', (await page.locator('.activity .activity-mark svg').count()) >= 3);
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.tabbar .tab');
  await page.locator('.tab', { hasText: 'Impostazioni' }).click();
  await page.waitForSelector('.appbar-title:has-text("Impostazioni")');
  check('bottom bar: "Impostazioni" opens settings and becomes active item', (await page.locator('.tab[aria-current=page]').innerText()).includes('Impostazioni') && (await page.locator('.tabbar').isVisible()));
  await page.locator('.tab', { hasText: 'Chat' }).click();
  await page.waitForSelector('.swipe');
  check('bottom bar: "Chat" returns to list', (await page.locator('.tab[aria-current=page]').innerText()).includes('Chat'));

  // --- composer ---
  await page.goto(CHAT(4));
  await page.waitForSelector('.composer-input');
  await sleep(300);
  const dock = page.locator('.dock');
  const area = page.locator('.composer-input');
  const sendBtn = page.locator('.send');
  const dockBox = await dock.boundingBox();
  const vp = page.viewportSize();
  check('composer: pinned to bottom of screen', dockBox && Math.abs(dockBox.y + dockBox.height - vp.height) < 3, `${Math.round(dockBox.y + dockBox.height)} / ${vp.height}`);
  check('composer: active (actions available)', await area.isEnabled());
  check('composer: send disabled when empty', await sendBtn.isDisabled());
  const cfs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.composer-input')).fontSize));
  check('composer: font >= 16px', cfs >= 16, `${cfs}px`);
  await area.fill('Prima riga\nSeconda riga\nTerza riga\nQuarta riga');
  const grown = (await area.boundingBox()).height;
  check('composer: field grows with text', grown > 60, `${Math.round(grown)}px`);
  check('composer: send enabled with text', await sendBtn.isEnabled());
  await shot('05-composer');
  // draft persists when leaving and returning
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.row');
  await page.goto(CHAT(4));
  await page.waitForSelector('.composer-input');
  check('composer: draft preserved when leaving and returning', (await page.locator('.composer-input').inputValue()).startsWith('Prima riga'));
  await page.locator('.send').click();
  await page.waitForSelector('.dock-status', { state: 'visible', timeout: 8000 });
  const st = await page.locator('.dock-status').innerText();
  check('composer: outcome shown', /inviato|coda/i.test(st), st);
  check('composer: field cleared after send', (await page.locator('.composer-input').inputValue()) === '');
  await shot('06-sent');

  // --- attached images: pick, preview, remove, send ---
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.waitForSelector('.attach');
  check('images: "Allega immagini" button with SVG icon', (await page.locator('.attach svg').count()) === 1 && (await page.locator('.attach').isEnabled()));
  await page.locator('input[type=file]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') }, { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') }]);
  await page.waitForFunction(() => document.querySelectorAll('.attach-item').length === 2 && !document.querySelector('.attach-item.loading'), null, { timeout: 8000 });
  check('images: two previews, send enabled even without text', (await page.locator('.attach-item img').count()) === 2 && (await page.locator('.send').isEnabled()));
  await shot('20-attach');
  await page.locator('.attach-remove').first().click();
  check('images: "Rimuovi" removes preview', (await page.locator('.attach-item').count()) === 1);
  await page.locator('.send').click();
  await page.waitForFunction(() => document.querySelectorAll('.attach-item').length === 0, null, { timeout: 10000 });
  check('images: after send previews disappear and outcome appears', /inviato|coda/i.test(await page.locator('.dock-status').innerText()));
  await page.locator('input[type=file]').setInputFiles([{ name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('non un\'immagine') }]);
  await page.waitForFunction(() => /non supportato|non caricata/i.test(document.querySelector('.dock-status')?.textContent || ''), null, { timeout: 8000 });
  check('images: non-image file rejected with warning', (await page.locator('.attach-item').count()) === 0);

  // --- double tap: safety net blocks second rapid tap ---
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('.panel');
  await page.evaluate(() => {
    window.__taps = [];
    window.addEventListener('touchend', (e) => window.__taps.push({ prevented: e.defaultPrevented, cancelable: e.cancelable }), { passive: true });
  });
  const tb = await page.evaluate(() => {
    const t = document.querySelector('.panel-note') || document.body;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + 20), y: Math.round(r.top + 8) };
  });
  await page.touchscreen.tap(tb.x, tb.y);
  await page.touchscreen.tap(tb.x, tb.y); // double tap
  await sleep(700);
  await page.touchscreen.tap(tb.x, tb.y); // isolated tap, far apart in time
  await sleep(100);
  const dt = await page.evaluate(() => window.__taps);
  check('double tap: first tap passes', dt.length === 3 && dt[0].prevented === false, JSON.stringify(dt));
  check('double tap: second rapid tap is blocked', dt[1]?.prevented === true);
  check('double tap: isolated tap afterward is not blocked', dt[2]?.prevented === false);

  // --- settings ---
  await page.waitForSelector('text=Rispondere dal telefono');
  const diagText = await page.locator('section.panel', { hasText: 'Diagnostica connessione' }).innerText();
  check('settings: connection diagnostics (live stream, events and response time)', diagText.includes('Flusso live') && diagText.includes('attivo') && /Tempo di risposta del daemon\s+\d+ ms/.test(diagText.replace(/\n/g, ' ')), diagText.replace(/\n/g, ' | ').slice(0, 160));
  check('settings: "Rispondere dal telefono" panel with Attivo state', await page.locator('text=Attivo. Dalle chat').isVisible());
  await shot('07-settings');

  // --- full conversation: read-only, paginated from bottom ---
  await page.goto(CHAT(8));
  await page.waitForSelector('a[href$="/storia"]');
  await page.locator('a[href$="/storia"]').click();
  await page.waitForSelector('.hist-msg');
  await sleep(300);
  check('conversation: opens from link, starts at bottom (last message visible)', await page.locator('.hist-msg', { hasText: 'Ho generato la documentazione' }).isVisible());
  check('conversation: read-only (no composer) and no bottom bar', (await page.locator('.composer-input').count()) === 0 && !(await page.locator('.tabbar').isVisible()));
  check('conversation: tools are discrete rows with SVG icon', (await page.locator('.hist-tool svg').count()) >= 1 && !(await page.locator('.hist-list').innerText()).includes('schema.json'));
  const nBefore = await page.locator('.hist-msg').count();
  check('conversation: "Messaggi precedenti" present (more than one page)', await page.locator('.hist-older').isVisible() || nBefore > 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.hist-older').click();
  await page.waitForFunction((n) => document.querySelectorAll('.hist-msg').length > n, nBefore, { timeout: 8000 });
  check('conversation: "Messaggi precedenti" loads more messages and button disappears at end', (await page.locator('.hist-msg', { hasText: /Domanda numero 1 sulla/ }).count()) === 1 && (await page.locator('.hist-older').count()) === 0);
  await shot('16-history');
  await page.locator('.appbar-back').click();
  await page.waitForSelector('.chat-head');

  // --- chat management: rename, archive, restore ---
  await page.goto(CHAT(13));
  await page.waitForSelector('.manage');
  check('manage: idle chat has "Rinomina", "Fissa" and "Archivia" (with SVG icons)', (await page.locator('.manage .btn svg').count()) === 3 && (await page.locator('.manage .btn', { hasText: 'Fissa' }).count()) === 1 && (await page.locator('.manage .btn', { hasText: 'Archivia' }).isEnabled()));
  await shot('17-manage');
  await page.locator('.manage .btn', { hasText: 'Rinomina' }).click();
  await page.waitForSelector('#rename-input');
  check('manage: name field starts with current name and has focus', (await page.locator('#rename-input').inputValue()) === 'Testi della pagina iniziale' && (await page.evaluate(() => document.activeElement?.id)) === 'rename-input');
  await shot('18-rename');
  await page.locator('#rename-input').fill('Testi rivisti');
  await page.locator('.rename-form .btn.primary').click();
  await page.waitForFunction(() => document.querySelector('.chat-name')?.textContent === 'Testi rivisti', null, { timeout: 10000 });
  check('manage: after "Salva" chat title changes and field closes', (await page.locator('#rename-input').count()) === 0 && (await page.locator('.manage', { hasText: 'Nome cambiato' }).count()) === 1);
  await page.locator('.manage .btn', { hasText: 'Fissa' }).click();
  await page.waitForSelector('.manage .btn:has-text("Togli")', { timeout: 8000 });
  check('manage: "Fissa" pins chat, notice appears and button becomes "Togli"', (await page.locator('.manage', { hasText: 'Chat fissata' }).count()) === 1);
  await page.locator('.manage .btn', { hasText: 'Togli' }).click();
  await page.waitForSelector('.manage .btn:has-text("Fissa")', { timeout: 8000 });
  check('manage: "Togli" unpins and button returns to "Fissa"', (await page.locator('.manage', { hasText: 'Chat tolta dai fissati' }).count()) === 1);
  await page.locator('.manage .btn', { hasText: 'Archivia' }).click();
  check('manage: "Archivia" requires second tap', (await page.locator('.manage .btn.armed').innerText()).includes('Conferma'));
  await page.locator('.manage .btn.armed').click();
  await page.waitForFunction(() => location.hash === '#/chat', null, { timeout: 10000 });
  check('manage: archived, returns to list and chat is gone', (await page.locator('.row', { hasText: 'Testi rivisti' }).count()) === 0);
  await page.goto(`${BASE}/#/impostazioni`);
  await page.locator('a[href="#/archivio"]').click();
  await page.waitForSelector('.list .row');
  check('archive: two archived chats appear (with icon and "Ripristina")', (await page.locator('.list .row').count()) === 2 && (await page.locator('.list .row', { hasText: 'Testi rivisti' }).count()) === 1 && (await page.locator('.list .row .btn svg').count()) === 2);
  await shot('19-archive');
  await page.locator('.list .row', { hasText: 'Prova di un tema scuro' }).locator('.btn').click();
  await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 1, null, { timeout: 10000 });
  check('archive: after "Ripristina" chat leaves list and outcome appears', (await page.locator('.banner', { hasText: 'ripristinata' }).count()) === 1);
  await page.locator('.list .row', { hasText: 'Testi rivisti' }).locator('.btn').click();
  await page.waitForSelector('.empty');
  check('archive: empty state when no archived chats', (await page.locator('.empty h2', { hasText: 'Nessuna chat archiviata' }).count()) === 1);

  // --- new chat: from Chat tab, with project, text and image ---
  await page.goto(`${BASE}/#/chat`);
  await page.waitForSelector('a[aria-label="Nuova chat"]');
  check('new chat: "Nuova chat" button at top on Chat tab (SVG icon)', (await page.locator('a[aria-label="Nuova chat"] svg').count()) === 1);
  await page.locator('a[aria-label="Nuova chat"]').click();
  await page.waitForSelector('#newchat-project');
  check('new chat: project list, message field, "Avvia" disabled when empty', (await page.locator('#newchat-project [role=radio]').count()) === 3 && (await page.locator('.newchat button[type=submit]').isDisabled()));
  await page.locator('#newchat-project [role=radio]', { hasText: 'sito-vetrina' }).click();
  check('new chat: tapped project is selected (one only)', (await page.locator('#newchat-project [aria-checked=true]').count()) === 1 && (await page.locator('#newchat-project [aria-checked=true]').innerText()).includes('sito-vetrina'));
  await page.locator('.newchat button', { hasText: 'Scegli ramo e modello' }).click();
  await page.waitForSelector('[role=radiogroup][aria-label="Ramo"]', { timeout: 8000 });
  check('new chat: branch and model from Cursor ("Come in Cursor" already selected and SVG icons)', (await page.locator('[aria-label="Ramo"] [role=radio]').count()) === 4 && (await page.locator('[aria-label="Modello"] [role=radio]').count()) === 5 && (await page.locator('[aria-label="Ramo"] [aria-checked=true]').innerText()).includes('Come in Cursor') && (await page.locator('[aria-label="Ramo"] [role=radio] svg').count()) >= 6);
  await page.locator('[aria-label="Ramo"] [role=radio]', { hasText: 'sviluppo' }).click();
  await page.locator('[aria-label="Modello"] [role=radio]', { hasText: 'Composer 2.5' }).click();
  check('new chat: choosing branch and model selects one item per group', (await page.locator('[aria-label="Ramo"] [aria-checked=true]').count()) === 1 && (await page.locator('[aria-label="Ramo"] [aria-checked=true]').innerText()).includes('sviluppo') && (await page.locator('[aria-label="Modello"] [aria-checked=true]').innerText()).includes('Composer 2.5'));
  await page.locator('#newchat-text').fill('Aggiungi una pagina contatti');
  await page.locator('input[type=file]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') }]);
  await page.waitForFunction(() => document.querySelectorAll('.attach-item').length === 1 && !document.querySelector('.attach-item.loading'), null, { timeout: 8000 });
  await shot('21-newchat');
  check('new chat: with text and image "Avvia" is enabled', await page.locator('.newchat button[type=submit]').isEnabled());
  await page.locator('.newchat button[type=submit]').click();
  await page.waitForFunction(() => /^#\/chat\/00000000-0000-4000-8000-0000000001\d\d$/.test(location.hash), null, { timeout: 15000 });
  await page.waitForSelector('.chat-name');
  check('new chat: after start opens created chat page (in chosen project)', (await page.locator('.chat-name').innerText()).startsWith('Aggiungi una pagina') && (await page.locator('.chat-name').innerText()).includes('[sviluppo|Composer 2.5]') && (await page.locator('.appbar-title').innerText()) === 'sito-vetrina');

  // --- keep Mac awake: toggle in Impostazioni (active when an agent is working) ---
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('.switch[aria-label="Resta sveglio mentre un agente lavora"]');
  const awakeSw = page.locator('.switch[aria-label="Resta sveglio mentre un agente lavora"]');
  check('keep awake: off by default', (await awakeSw.getAttribute('aria-checked')) === 'false');
  await awakeSw.click();
  await page.waitForFunction(() => document.querySelector('.switch[aria-label="Resta sveglio mentre un agente lavora"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 8000 });
  await page.waitForSelector('text=Attivo adesso', { timeout: 8000 });
  check('keep awake: when on, two levels appear (lid closed, brightness)', (await page.locator('.switch[aria-label="Anche a schermo chiuso e a batteria"]').isVisible()) && (await page.locator('.switch[aria-label^="Luminosit"]').isVisible()));
  await page.locator('.switch[aria-label="Anche a schermo chiuso e a batteria"]').click();
  await page.waitForFunction(() => document.querySelector('.switch[aria-label="Anche a schermo chiuso e a batteria"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 8000 });
  await page.waitForSelector('text=Attivo adesso >> nth=1', { timeout: 8000 });
  await shot('17-awake');
  await page.locator('.switch[aria-label="Anche a schermo chiuso e a batteria"]').click();
  await awakeSw.click();
  await page.waitForFunction(() => document.querySelector('.switch[aria-label="Resta sveglio mentre un agente lavora"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 8000 });

  // --- paired devices: other device unpairs with two taps ---
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('.device-row');
  check('devices: list with this device and another (iPad)', (await page.locator('.device-row').count()) === 2 && (await page.locator('.device-row', { hasText: 'Questo dispositivo' }).count()) === 1 && (await page.locator('.device-row', { hasText: 'iPad' }).count()) === 1);
  check('devices: current device has no "Scollega"', (await page.locator('.device-row', { hasText: 'Questo dispositivo' }).locator('button').count()) === 0);
  await shot('15-devices');
  await page.locator('.device-row', { hasText: 'iPad' }).locator('button').click();
  check('devices: first tap asks for confirmation', (await page.locator('.device-row', { hasText: 'iPad' }).locator('button').innerText()).includes('Tocca ancora'));
  await page.locator('.device-row', { hasText: 'iPad' }).locator('button').click();
  await page.waitForFunction(() => !document.querySelector('.device-row'), null, { timeout: 8000 });
  check('devices: after second tap iPad disappears (and with one device the panel is gone)', (await page.locator('.device-row').count()) === 0);

  // --- stop agent: send button becomes "Ferma" when empty, requires second tap ---
  await page.goto(CHAT(2));
  await page.waitForSelector('.composer-input');
  await page.waitForSelector('.send.stop', { timeout: 8000 });
  check('stop: with agent working and empty field button is "Ferma" (SVG icon)', (await page.locator('.send.stop svg').count()) === 1 && (await page.locator('.send.stop').isEnabled()));
  await page.locator('.composer-input').fill('x');
  check('stop: typing restores "Invia"', (await page.locator('.send.stop').count()) === 0 && (await page.locator('.send').isEnabled()));
  await page.locator('.composer-input').fill('');
  await page.locator('.send.stop').click();
  await page.waitForSelector('.send.stop.armed');
  check('stop: first tap asks confirmation and does not stop', (await page.locator('.dock-status').innerText()).includes('Tocca ancora'));
  await shot('14-stop-armed');
  await page.locator('.send.stop').click();
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 12000 });
  check('stop: after second tap agent stopped and button returns to "Invia"', (await page.locator('.send').count()) === 1);

  // --- stuck connection: startup does not hang on skeleton, after timeout "Riprova" appears ---
  const stalled = await ctx.newPage();
  // Session request never gets a response and aborts only if the app cancels it (timeout signal).
  await stalled.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = (url, opts) =>
      url === '/api/session'
        ? new Promise((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new DOMException('annullata', 'AbortError'))))
        : real(url, opts);
  });
  await stalled.goto(`${BASE}/`);
  await stalled.waitForSelector('text=Daemon non raggiungibile', { timeout: 14000 });
  check('startup with stuck connection: after timeout shows "Daemon non raggiungibile" with "Riprova"', (await stalled.locator('button', { hasText: 'Riprova' }).count()) === 1);
  await stalled.close();

  // --- language: English via the selector, then every supported language renders its tab bar without missing keys ---
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('select.lang-select');
  check('language: the phone is Italian, so "Automatic" shows the Italian interface', (await page.locator('.tabbar .tab-label').allInnerTexts()).join('|').includes('Impostazioni'));
  await Promise.all([page.waitForEvent('load'), page.selectOption('select.lang-select', 'en')]);
  await page.waitForSelector('.tabbar .tab-label');
  const enTabs = (await page.locator('.tabbar .tab-label').allInnerTexts()).map((x) => x.trim());
  check('language: choosing English reloads and translates the tab bar', enTabs.join('|') === 'Attention|Chats|Favorites|Settings', enTabs.join('|'));
  check('language: html lang follows the choice', (await page.evaluate(() => document.documentElement.lang)) === 'en');
  for (const code of ['es', 'fr', 'de', 'pt', 'ja', 'zh']) {
    const problemsBefore = problems.length;
    await page.evaluate((c) => localStorage.setItem('cp.lang', c), code);
    await page.reload();
    await page.waitForSelector('.tabbar .tab-label');
    const labels = (await page.locator('.tabbar .tab-label').allInnerTexts()).map((x) => x.trim());
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`language ${code}: settings page has no horizontal overflow`, ov <= 0, `${ov}px`);
    check(`language ${code}: no console or CSP errors while loading`, problems.length === problemsBefore, problems.slice(problemsBefore).join(' | ').slice(0, 300));
    check(`language ${code}: tab bar translated (no raw keys, different from English)`, labels.length === 4 && labels.join('|') !== 'Attention|Chats|Favorites|Settings' && labels.every((l) => l && !/^[a-zA-Z]+\.[a-zA-Z]+/.test(l)), labels.join('|'));
  }
  await page.evaluate(() => localStorage.removeItem('cp.lang'));
  await page.goto(`${BASE}/#/`);

  // --- no horizontal scroll ---
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scroll', overflow <= 0, `${overflow}px`);

  check('no console errors / CSP violation', problems.length === 0, problems.join(' | '));
} catch (err) {
  check(`EXCEPTION: ${String(err.message).split('\n')[0]}`, false);
  await shot('zz-errore');
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${engineName}: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
