// Verifica della PWA in browser veri (Chromium e WebKit, il motore di Safari) con viewport iPhone, contro il server
// dimostrativo (`tools/demo-server.mjs`: database di Cursor finto, nessun dato reale e nessun Cursor coinvolto).
//
// Strumento FACOLTATIVO di sviluppo: il repository non dipende da Playwright. Serve `playwright-core` (e i browser
// scaricati con `npx playwright install chromium webkit`) installato dove preferisci; se non e' risolvibile da qui,
// indica il file con la variabile PLAYWRIGHT_CORE (es. .../node_modules/playwright-core/index.mjs).
//
//   node tools/ui-check.mjs [chromium|webkit] [--shots] [--dark]
//
// `--shots` salva gli screenshot nella cartella temporanea del sistema (se ne stampa il percorso); `--dark` emula il
// tema scuro del telefono. In WebKit lo screenshot di Playwright provoca errori CSP spuri, che vengono ignorati: per il
// controllo CSP rigoroso eseguire senza `--shots`. Codice di uscita 1 se un controllo fallisce.
// Cio' che NON si puo' provare qui: il comportamento reale di iOS (zoom con doppio tocco, tastiera, PWA a schermo
// intero); si provano solo logica, CSS e DOM nei motori di rendering.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadPlaywright() {
  try {
    return await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_CORE)).href : 'playwright-core');
  } catch {
    console.error('playwright-core non trovato. Installalo (npm i -D playwright-core in una cartella a parte) oppure imposta PLAYWRIGHT_CORE.');
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
  console.log(`Screenshot in ${outDir}`);
}

// --- demo server ---------------------------------------------------------------------------------------------
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, 'demo-server.mjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
for (let i = 0; i < 60 && !/Codice di abbinamento/.test(serverLog); i++) await new Promise((r) => setTimeout(r, 100));
const code = /\(15 min\): ([A-Z0-9-]+)/.exec(serverLog)?.[1];
if (!code) {
  console.error('demo server non avviato:', serverLog);
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
  if (/Content Security Policy|CSP|violat/i.test(t) || m.type() === 'error') problems.push(`${m.type()}: ${t.slice(0, 160)} @ ${page.url().split('#')[1] ?? ''}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message).slice(0, 160)}`));
const shot = async (name) => {
  if (!shots) return;
  const before = problems.length;
  await new Promise((r) => setTimeout(r, 300)); // lascia finire la dissolvenza tra le schermate
  await page.screenshot({ path: `${outDir}/${name}.png` });
  await new Promise((r) => setTimeout(r, 150));
  // Artefatto di Playwright: in WebKit lo screenshot inietta uno stile che la CSP della pagina rifiuta. Si scartano
  // solo quei messaggi comparsi durante lo screenshot; il controllo CSP rigoroso e' l'esecuzione senza --shots.
  for (let i = problems.length - 1; i >= before; i--) if (/Refused to apply a stylesheet/.test(problems[i])) problems.splice(i, 1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // --- abbinamento ---
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#code');
  check('login: logo Cursor presente', (await page.locator('.brand img[src="/icons/cursor-logo.svg"]').count()) === 1);
  await shot('00-login');
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await page.waitForSelector('.appbar-logo');

  // --- home: logo in alto a sinistra ---
  await page.waitForSelector('.row');
  const logoBox = await page.locator('.appbar .appbar-logo').boundingBox();
  const titleBox = await page.locator('.appbar .appbar-title').boundingBox();
  check('home: logo Cursor in alto a sinistra', logoBox && logoBox.x < 24 && logoBox.y < 40 && logoBox.x + logoBox.width < titleBox.x + 4, JSON.stringify(logoBox));
  check('home: logo caricato (SVG decodificato)', await page.evaluate(() => { const i = document.querySelector('.appbar-logo'); return i.complete && i.naturalWidth > 0; }));
  await shot('01-home');

  // --- barra in basso, righe, gesti, formattazione ---
  const tabbarEl = page.locator('.tabbar');
  check('barra in basso: visibile in home con "Attenzione" attiva e quattro voci', (await tabbarEl.isVisible()) && (await tabbarEl.locator('.tab[aria-current=page]').innerText()).includes('Attenzione') && (await tabbarEl.locator('.tab').count()) === 4);
  const tbBox = await tabbarEl.boundingBox();
  const vpH = page.viewportSize().height;
  check('barra in basso: ancorata in fondo, tasti alti almeno 44px', tbBox && tbBox.y + tbBox.height >= vpH - 1 && (await page.locator('.tab').first().boundingBox()).height >= 44, JSON.stringify(tbBox));
  const attCount = await page.locator('.section-head.danger .count').first().innerText();
  check('barra in basso: il badge riporta le chat che richiedono attenzione', (await page.locator('.tab-badge').innerText()) === attCount, `${await page.locator('.tab-badge').innerText()} / ${attCount}`);
  check('home: nessuna icona Impostazioni in alto (e\' nella barra)', (await page.locator('.appbar [aria-label=Impostazioni]').count()) === 0);
  const attRow = page.locator('.swipe .row').first();
  check('riga: titolo, progetto e stato su righe distinte', (await attRow.locator('.row-title').isVisible()) && (await attRow.locator('.row-meta').isVisible()) && (await attRow.locator('.row-state svg').count()) === 1);
  check('riga: stato di attenzione in rosso (non solo il pallino)', await attRow.locator('.row-state.attenzione').isVisible());
  // scorrimento: trascinare la riga a sinistra scopre "Ignora" senza aprire la chat
  const swipeBox = await page.locator('.swipe').nth(1).boundingBox();
  const sy = swipeBox.y + swipeBox.height / 2;
  const hashBefore = await page.evaluate(() => location.hash);
  await page.mouse.move(swipeBox.x + swipeBox.width - 30, sy);
  await page.mouse.down();
  await page.mouse.move(swipeBox.x + swipeBox.width - 70, sy, { steps: 4 });
  await page.mouse.move(swipeBox.x + swipeBox.width - 130, sy, { steps: 4 });
  await page.mouse.up();
  await sleep(350);
  check('gesto: scorrere a sinistra scopre "Ignora"', await page.locator('.swipe.open').count() === 1);
  check('gesto: la chat non si apre dopo il trascinamento', (await page.evaluate(() => location.hash)) === hashBefore);
  const openBox = await page.locator('.swipe.open .row').boundingBox();
  check('gesto: le righe scorrevoli ammettono solo pan verticale e pinch (niente zoom col doppio tocco)', (await page.evaluate(() => getComputedStyle(document.querySelector('.swipe .row')).touchAction)) === 'pan-y pinch-zoom');
  check('gesto: la riga si sposta di circa la larghezza del pulsante', openBox && Math.abs(openBox.x - (swipeBox.x - 96)) < 6, JSON.stringify(openBox));
  await page.mouse.click(swipeBox.x + 40, 140); // tocco altrove (intestazione): chiude
  await sleep(350);
  check('gesto: un tocco altrove richiude la riga', (await page.locator('.swipe.open').count()) === 0);
  check('gesto: sul tocco semplice la chat si apre ancora', await (async () => {
    await page.locator('.swipe .row').first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/chat/'), null, { timeout: 5000 });
    await page.goBack();
    await page.waitForSelector('.swipe');
    return true;
  })());

  // --- schede: Chat (con ricerca), Preferite, Come funziona ---
  await page.locator('.tabbar .tab', { hasText: 'Chat' }).click();
  await page.waitForSelector('.search-input');
  await sleep(200);
  check('scheda Chat: titolo, ricerca e gruppi per progetto', (await page.locator('.appbar-title').innerText()) === 'Chat' && (await page.locator('.section-head', { hasText: 'negozio-online' }).count()) >= 1 && (await page.locator('.section-head', { hasText: 'Richiedono attenzione' }).count()) === 0);
  check('scheda Chat: la voce attiva e\' Chat', (await page.locator('.tab[aria-current=page]').innerText()).includes('Chat'));
  const allRows = await page.locator('.row').count();
  await page.locator('.search-input').fill('carrello');
  await sleep(250);
  check('ricerca: filtra per titolo e mantiene il campo attivo', (await page.locator('.list .row').count()) === 1 && (await page.locator('.list .row-title').first().innerText()).toLowerCase().includes('carrello') && (await page.evaluate(() => document.activeElement?.classList.contains('search-input'))));
  await page.locator('.search-input').fill('zzzz-non-esiste');
  await sleep(250);
  check('ricerca: nessun risultato', await page.locator('.empty h2', { hasText: 'Nessun risultato' }).isVisible());
  await page.locator('.search-clear').click();
  await sleep(250);
  check('ricerca: cancellando tornano tutte le chat', (await page.locator('.row').count()) === allRows);
  await shot('11-chat-tab');
  const vh = page.viewportSize().height;
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(250);
  const tb2 = await page.locator('.tabbar').boundingBox();
  check('barra in basso: dopo lo scorrimento resta incollata al fondo', tb2 && Math.abs(tb2.y + tb2.height - vh) <= 1, JSON.stringify(tb2));
  await page.evaluate(() => window.scrollTo(0, 0));

  // cuore: dalla pagina della chat; compare in Preferite e si toglie da li'
  await page.goto(CHAT(2));
  await page.waitForSelector('.chat-head');
  await page.locator('.appbar [aria-label="Aggiungi alle preferite"]').click();
  await page.waitForSelector('.appbar [aria-label="Togli dalle preferite"]', { timeout: 8000 });
  check('chat: il cuore aggiunge la chat alle preferite', true);
  await page.goto(`${BASE}/#/preferite`);
  await page.waitForSelector('.list .row');
  check('scheda Preferite: la chat con il cuore e\' in elenco', (await page.locator('.list .row').count()) === 1 && (await page.locator('.list .row-title').first().innerText()).includes('Migrazione'));
  await shot('12-favorites');
  await page.locator('.list .row').first().click();
  await page.waitForSelector('.appbar [aria-label="Togli dalle preferite"]');
  await page.locator('.appbar [aria-label="Togli dalle preferite"]').click();
  await page.waitForSelector('.appbar [aria-label="Aggiungi alle preferite"]', { timeout: 8000 });
  await page.goto(`${BASE}/#/preferite`);
  await page.waitForSelector('.empty');
  check('scheda Preferite: senza cuori mostra lo stato vuoto', await page.locator('.empty h2', { hasText: 'Nessuna preferita' }).isVisible());

  // silenziare: chat (campanella nella pagina) e progetti/orari (Impostazioni)
  await page.goto(CHAT(2));
  await page.waitForSelector('.chat-head');
  await page.locator('.appbar [aria-label="Silenzia le notifiche di questa chat"]').click();
  await page.waitForSelector('.appbar [aria-label="Riattiva le notifiche di questa chat"]', { timeout: 8000 });
  await page.goto(`${BASE}/#/chat`);
  await page.waitForSelector('.list .row');
  check('chat silenziata: la riga mostra la campanella barrata', (await page.locator('.row', { hasText: 'Migrazione della tabella ordini' }).locator('.row-side svg').count()) === 1);
  await page.goto(CHAT(2));
  await page.waitForSelector('.chat-head');
  await page.locator('.appbar [aria-label="Riattiva le notifiche di questa chat"]').click();
  await page.waitForSelector('.appbar [aria-label="Silenzia le notifiche di questa chat"]', { timeout: 8000 });
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('.switch');
  check('impostazioni: orari senza notifiche e progetti silenziati con interruttori', (await page.locator('.panel-title', { hasText: 'Orari senza notifiche' }).isVisible()) && (await page.locator('.panel-title', { hasText: 'Progetti silenziati' }).isVisible()) && (await page.locator('.switch').count()) >= 4);
  await page.locator('.switch[aria-label="Silenzio programmato"]').click();
  await page.waitForSelector('.time-field', { timeout: 8000 });
  check('orari senza notifiche: attivandoli compaiono Dalle e Alle', (await page.locator('.time-field input').count()) === 2 && (await page.locator('.switch[aria-label="Silenzio programmato"]').getAttribute('aria-checked')) === 'true');
  await shot('13-quiet-settings');
  await page.locator('.switch[aria-label="Silenzio programmato"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.time-field').length === 0, null, { timeout: 8000 });

  // "Come funziona" sta sotto Impostazioni e contiene le spiegazioni tolte dalle schermate
  await page.goto(`${BASE}/#/impostazioni`);
  await page.locator('.help-link[href="#/come-funziona"]').click();
  await page.waitForSelector('.help-list');
  check('Come funziona: raggiungibile da Impostazioni, con Impostazioni attiva nella barra', (await page.locator('.tab[aria-current=page]').innerText()).includes('Impostazioni') && (await page.locator('.help-list li').count()) >= 6);
  await page.goto(CHAT(1));
  await page.waitForSelector('.panel.attention');
  check('chat: nessuna nota fissa di spiegazione nel pannello', !(await page.locator('.panel.attention').innerText()).includes('come se la scegliessi') && !(await page.locator('.panel.attention').innerText()).includes('toglie solo il pallino'));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.swipe');

  // --- stile: zoom e campi ---
  const styles = await page.evaluate(() => {
    const ta = (sel) => (document.querySelector(sel) ? getComputedStyle(document.querySelector(sel)) : null);
    return {
      html: getComputedStyle(document.documentElement).touchAction,
      body: getComputedStyle(document.body).touchAction,
      row: ta('.list > .swipe .row')?.touchAction === 'pan-y pinch-zoom' ? 'manipulation' : ta('.list > .swipe .row')?.touchAction, // righe scorrevoli: pan-y + pinch-zoom = senza zoom col doppio tocco
      btn: ta('.icon-btn')?.touchAction,
    };
  });
  check('touch-action manipulation su html/body/righe/pulsanti', Object.values(styles).every((v) => v === 'manipulation'), JSON.stringify(styles));

  // --- domanda ignorata: si puo' ancora rispondere (regola "anche dopo ore o giorni"), "Ripristina" la riattiva ---
  await page.goto(CHAT(1));
  await page.waitForSelector('.choice[role=radio]');
  await page.locator('button:has-text("Ignora")').click();
  await page.waitForSelector('.panel-title:has-text("ignorata")', { timeout: 8000 });
  check('chat 1: dopo "Ignora" la domanda e\' ancora rispondibile (opzioni cliccabili)', (await page.locator('.choice[role=radio]').count()) === 3 && (await page.locator('.choice[role=radio]').first().isEnabled()));
  check('chat 1: il pulsante diventa "Ripristina"', await page.locator('button:has-text("Ripristina")').isVisible());
  await page.locator('button:has-text("Ripristina")').click();
  await page.waitForFunction(() => !document.body.innerText.includes('(ignorata)'), null, { timeout: 8000 });
  check('chat 1: "Ripristina" riporta la domanda tra quelle che richiedono attenzione', (await page.locator('button:has-text("Ignora")').isVisible()) && (await page.locator('.choice[role=radio]').count()) === 3);

  // --- domanda singola ---
  await page.goto(CHAT(1));
  await page.waitForSelector('.choice');
  await sleep(300);
  check('chat 1: stato azioni "ok" (questionario interattivo, non sola lettura)', (await page.locator('.choice[role=radio]').count()) === 3, 'opzioni+altro=3');
  check('chat 1: nessun testo "sola lettura" nel pannello', (await page.locator('.options').count()) === 0);
  await shot('02-question');
  const submit = page.locator('button:has-text("Invia risposta")');
  check('chat 1: invio disattivato senza scelta', await submit.isDisabled());
  await page.locator('.choice', { hasText: 'Dopo la spedizione' }).click();
  check('chat 1: opzione selezionata', (await page.locator('.choice[aria-checked=true]').count()) === 1);
  check('chat 1: invio attivo dopo la scelta', await submit.isEnabled());
  // Altro: compare il campo, si deseleziona l'opzione (scelta singola)
  await page.locator('.choice.other').click();
  check('chat 1: "Altro" mostra il campo libero', await page.locator('textarea.field-input').isVisible());
  check('chat 1: "Altro" deseleziona le opzioni (singola)', (await page.locator('.choice[aria-checked=true]').count()) === 1 && (await page.locator('.choice.other[aria-checked=true]').count()) === 1);
  check('chat 1: invio disattivato con "Altro" vuoto', await submit.isDisabled());
  const fs16 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('textarea.field-input')).fontSize));
  check('campo libero: font >= 16px (niente zoom al focus)', fs16 >= 16, `${fs16}px`);
  const focused = await page.evaluate(() => document.activeElement?.className);
  check('chat 1: focus nel campo libero dopo il tocco su "Altro"', /field-input/.test(focused ?? ''), focused);
  await page.fill('textarea.field-input', 'Dipende dal paese del cliente');
  check('chat 1: invio attivo con testo libero', await submit.isEnabled());
  // si torna a un'opzione normale
  await page.locator('.choice', { hasText: 'Prima della spedizione' }).click();
  check('chat 1: tornando a un\'opzione il campo libero si chiude', !(await page.locator('textarea.field-input').isVisible()));

  // un aggiornamento live non deve rompere la selezione: forziamo un render
  await page.evaluate(() => window.dispatchEvent(new Event('hashchange')));
  await sleep(200);
  // (hashchange rimonta la vista: la selezione e' dello stato del modulo, quindi riparte da zero; qui si controlla solo che non ci siano errori)
  await page.locator('.choice', { hasText: 'Dopo la spedizione' }).click();
  await submit.click();
  await page.waitForSelector('text=Risposta inviata', { timeout: 8000 });
  check('chat 1: esito "Risposta inviata"', true);
  // il questionario sparisce subito, ma la conferma resta visibile nel compositore per alcuni secondi
  await page.waitForFunction(() => !document.querySelector('.choice'), null, { timeout: 15000 }).catch(() => {});
  check('chat 1: la conferma resta visibile dopo la scomparsa del questionario', await page.locator('.dock-status', { hasText: 'Risposta inviata' }).isVisible());
  await shot('03-answered');
  check('chat 1: dopo la risposta compare il pannello "in attesa dell\u2019agente" (nessun blocco apparente)', await page.locator('.activity .panel-title', { hasText: 'in attesa' }).isVisible());
  // il daemon registra la risposta: il pannello della domanda sparisce
  await page.waitForFunction(() => !document.querySelector('.choice'), null, { timeout: 15000 }).then(
    () => check('chat 1: dopo la risposta il questionario sparisce (stato aggiornato)', true),
    () => check('chat 1: dopo la risposta il questionario sparisce (stato aggiornato)', false),
  );

  // --- due domande, una multipla ---
  await page.goto(CHAT(14));
  await page.waitForSelector('.choice');
  const radios = await page.locator('.choice[role=radio]').count();
  const checks = await page.locator('.choice[role=checkbox]').count();
  check('chat 14: una domanda singola (radio) e una multipla (checkbox)', radios === 4 && checks === 5, `radio=${radios} checkbox=${checks}`);
  const submit2 = page.locator('button:has-text("Invia risposta")');
  check('chat 14: promemoria "Mancano le risposte a 2 domande"', await page.locator('text=Mancano le risposte a 2 domande').isVisible());
  await page.locator('.question').nth(0).locator('.choice', { hasText: 'Solo di giorno' }).click();
  check('chat 14: con una sola domanda risposta resta disattivato', await submit2.isDisabled());
  const q2 = page.locator('.question').nth(1);
  await q2.locator('.choice', { hasText: 'Nuovi messaggi' }).click();
  await q2.locator('.choice', { hasText: 'Promemoria' }).click();
  check('chat 14: multipla accetta due opzioni', (await q2.locator('.choice[aria-checked=true]').count()) === 2);
  await q2.locator('.choice', { hasText: 'Promemoria' }).click();
  check('chat 14: multipla permette di togliere un\'opzione', (await q2.locator('.choice[aria-checked=true]').count()) === 1);
  check('chat 14: ora e\' completo', await submit2.isEnabled());
  await shot('04-multi');
  // il tasto Salta chiede conferma
  const skipBtn = page.locator('button:has-text("Salta")');
  await skipBtn.click();
  check('chat 14: "Salta" chiede una seconda conferma', await page.locator('button:has-text("Tocca ancora per saltare")').isVisible());
  await sleep(4300);
  check('chat 14: la conferma di "Salta" scade da sola', await page.locator('button:has-text("Salta")').isVisible());
  await submit2.click();
  await page.waitForSelector('text=Risposta inviata', { timeout: 8000 });
  check('chat 14: risposta con due domande inviata', true);

  // --- approvazione in attesa (reviewData Requested) ---
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.row');
  const apRow = page.locator('.row', { hasText: 'Pubblicazione del pacchetto' });
  check('home: la riga dell\'approvazione la nomina', (await apRow.locator('text=Approvazione richiesta').count()) >= 1);
  await page.goto(CHAT(15));
  await page.waitForSelector('.panel.attention');
  await sleep(300);
  check('chat 15: pannello "Approvazione richiesta" con il tipo di azione', (await page.locator('.panel-title', { hasText: 'Approvazione richiesta' }).isVisible()));
  check('chat 15: mostra il comando da decidere e la descrizione', (await page.locator('.cmd', { hasText: 'npm publish --access public' }).isVisible()));
  check('chat 15: pulsanti Esegui e Rifiuta con icona SVG', (await page.locator('.decision .btn svg').count()) === 2);
  check('chat 15: nessun questionario e nessun compositore (con un\'approvazione in sospeso il daemon rifiuterebbe il messaggio)', (await page.locator('.choice').count()) === 0 && (await page.locator('.dock').isHidden()));
  const apTitle = page.locator('.panel.attention .panel-title');
  check('chat 15: icona SVG nel titolo, nessuna emoji', (await apTitle.locator('svg').count()) === 1 && !/\p{Extended_Pictographic}/u.test(await apTitle.innerText()));
  await shot('08-approval');
  await page.locator('button:has-text("Ignora")').click();
  await page.waitForSelector('.panel-title:has-text("ignorata")', { timeout: 8000 });
  check('chat 15: dopo "Ignora" il pannello lo dice, e il compositore resta nascosto (il daemon rifiuterebbe il messaggio)', await page.locator('.dock').isHidden());
  await page.locator('button:has-text("Ripristina")').click();
  await page.waitForSelector('.panel.attention', { timeout: 8000 });
  check('chat 15: "Ripristina" riporta l\'approvazione tra le richieste che richiedono attenzione', await page.locator('.panel-title.danger').isVisible());

  // Rifiuta (chat 17): stessa cautela, un primo tocco da solo non decide
  await page.goto(CHAT(17));
  await page.waitForSelector('.cmd');
  check('chat 17: mostra descrizione e comando', (await page.locator('.panel-detail', { hasText: 'Svuota la cache locale' }).isVisible()) && (await page.locator('.cmd', { hasText: 'rm -rf ./tmp/cache' }).isVisible()));
  await page.locator('.decision .btn:not(.primary)').click();
  check('chat 17: primo tocco su Rifiuta arma il pulsante', (await page.locator('.decision .btn.armed').count()) === 1);
  await shot('08c-reject-armed');
  await page.waitForFunction(() => document.querySelectorAll('.decision .btn.armed').length === 0, null, { timeout: 9000 });
  check('chat 17: senza secondo tocco il pulsante si disarma da solo', true);
  await page.locator('.decision .btn:not(.primary)').click();
  await sleep(200);
  await page.locator('.decision .btn:not(.primary)').click();
  await page.waitForSelector('.panel.attention', { state: 'detached', timeout: 15000 });
  check('chat 17: dopo Rifiuta la richiesta sparisce', true);

  // Esegui (chat 19): il primo tocco arma, il secondo invia (nessun invio al primo tocco)
  await page.goto(CHAT(19));
  await page.waitForSelector('.cmd');
  await page.locator('.decision .btn.primary').click();
  check('chat 19: primo tocco su Esegui arma il pulsante e non invia', (await page.locator('.decision .btn.primary.armed').count()) === 1 && (await page.locator('.panel-title.danger').isVisible()));
  await sleep(300);
  await page.locator('.decision .btn.primary').click();
  await page.waitForFunction(() => !document.querySelector('.decision') || document.querySelector('.decision .btn[disabled]'), null, { timeout: 8000 });
  await page.waitForSelector('.panel.attention', { state: 'detached', timeout: 15000 });
  check('chat 19: dopo Esegui la richiesta sparisce dal pannello', (await page.locator('.cmd').count()) === 0);
  await shot('08b-approval-done');

  // Richiesta non di terminale (chat 18): da qui non si decide, si spiega perche'
  await page.goto(CHAT(18));
  await page.waitForSelector('.panel.attention');
  await sleep(400);
  check('chat 18: richiesta non di terminale: nessun pulsante, spiega di decidere sul Mac', (await page.locator('.decision').count()) === 0 && (await page.locator('.panel-note', { hasText: 'sul Mac' }).isVisible()));

  // "Ignora" dalla riga: la chat esce da "Richiedono attenzione"; "Ripristina" (pagina chat) la riporta
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
  // Solo la sezione "Richiedono attenzione": le chat "In corso" stanno in un'altra lista e non contano nel badge.
  const nRows = await page.evaluate(() => {
    const head = [...document.querySelectorAll('*')].find((e) => e.children.length < 4 && /^Richiedono attenzione/.test((e.innerText || '').trim()) && e.nextElementSibling?.classList.contains('list'));
    return head ? head.nextElementSibling.querySelectorAll('.swipe').length : 0;
  });
  check('gesto: "Ignora" dalla riga toglie la chat da quelle che richiedono attenzione (badge coerente)', nRows === 0 ? await page.locator('.tab-badge').isHidden() : Number(await page.locator('.tab-badge').innerText()) === nRows, `righe ${nRows}`);
  await page.goto(CHAT(15));
  await page.locator('button:has-text("Ripristina")').click();
  await page.waitForSelector('.panel.attention', { timeout: 8000 });
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.swipe');
  check('gesto: dopo "Ripristina" la chat e\' di nuovo tra quelle che richiedono attenzione', (await page.locator('.swipe', { hasText: 'Pubblicazione del pacchetto' }).count()) === 1);

  // tira per aggiornare (eventi tocco veri: solo Chromium)
  if (engineName === 'chromium') {
    const cdp = await ctx.newCDPSession(page);
    let stateReqs = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/state')) stateReqs += 1; });
    await page.evaluate(() => window.scrollTo(0, 0));
    const t0 = stateReqs;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 200 }] });
    for (let y = 215; y <= 335; y += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
    const o = await page.evaluate(() => getComputedStyle(document.querySelector('.ptr')).opacity);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
    check('tira per aggiornare: l\'indicatore appare e, oltre la soglia, rilegge lo stato', Number(o) > 0.9 && stateReqs > t0, `opacita' ${o}, richieste ${stateReqs - t0}`);
    const t1 = stateReqs;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 200 }] });
    for (let y = 205; y <= 225; y += 5) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    check('tira per aggiornare: un trascinamento breve non aggiorna', stateReqs === t1, `richieste ${stateReqs - t1}`);
  }

  // --- barra in basso tra le schermate, testo dell'agente formattato ---
  await page.goto(CHAT(9));
  await page.waitForSelector('.message');
  check('chat: la barra in basso non c\'e\' (in fondo c\'e\' il compositore)', await page.locator('.tabbar').isHidden());
  await shot('09-message-list');
  check('chat: il messaggio dell\'agente ha gli elenchi formattati', (await page.locator('.message ul.md-list li').count()) >= 3);
  await page.goto(CHAT(4));
  await page.waitForSelector('.message');
  await shot('10-message-code');
  check('chat: blocco di codice, grassetto e codice in linea formattati', (await page.locator('.message pre.md-code').count()) === 1 && (await page.locator('.message strong').innerText()) === 'verdi' && (await page.locator('.message .md-inline-code').innerText()) === 'jest');
  check('chat: il testo con tag HTML resta testo (nessuno script nel DOM)', (await page.locator('.message script').count()) === 0 && (await page.locator('.message').innerText()).includes('<script>alert(1)</script>'));
  await page.goto(CHAT(16));
  await page.waitForSelector('.panel.attention');
  const prep = await page.locator('.panel.attention').innerText();
  check('chat: domanda viva senza testo: "sta preparando la domanda" invece di "apri Cursor sul Mac"', prep.includes('sta preparando la domanda') && !prep.includes('Apri Cursor sul Mac'));
  await shot('10a-preparing');
  await page.goto(CHAT(4));
  await page.waitForSelector('.message');
  check('chat: chat ferma con cronologia: pannello "Attivit\u00e0 recente"', (await page.locator('.activity .panel-title').innerText()).includes('Attivit\u00e0 recente') && (await page.locator('.activity .activity-row').count()) >= 2);
  await page.goto(CHAT(2));
  await page.waitForSelector('.activity-row');
  await shot('10b-activity');
  const actText = await page.locator('.activity').innerText();
  check('chat: chat in corso: "L\u2019agente sta lavorando" con i passi (tipo di azione) e il comando in corso', actText.includes('sta lavorando') && actText.includes('Esegue un comando') && actText.includes('in corso') && actText.includes('Modifica un file') && actText.includes('Legge un file'));
  check('chat: nei passi non compaiono comandi ne\' percorsi', !actText.includes('npm test') && !actText.includes('/demo'));
  check('chat: le icone dei passi sono SVG (nessuna emoji)', (await page.locator('.activity .activity-mark svg').count()) >= 3);
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.tabbar .tab');
  await page.locator('.tab', { hasText: 'Impostazioni' }).click();
  await page.waitForSelector('.appbar-title:has-text("Impostazioni")');
  check('barra in basso: "Impostazioni" apre le impostazioni e diventa la voce attiva', (await page.locator('.tab[aria-current=page]').innerText()).includes('Impostazioni') && (await page.locator('.tabbar').isVisible()));
  await page.locator('.tab', { hasText: 'Chat' }).click();
  await page.waitForSelector('.swipe');
  check('barra in basso: "Chat" riporta all\'elenco', (await page.locator('.tab[aria-current=page]').innerText()).includes('Chat'));

  // --- compositore ---
  await page.goto(CHAT(4));
  await page.waitForSelector('.composer-input');
  await sleep(300);
  const dock = page.locator('.dock');
  const area = page.locator('.composer-input');
  const sendBtn = page.locator('.send');
  const dockBox = await dock.boundingBox();
  const vp = page.viewportSize();
  check('compositore: ancorato in fondo alla schermata', dockBox && Math.abs(dockBox.y + dockBox.height - vp.height) < 3, `${Math.round(dockBox.y + dockBox.height)} / ${vp.height}`);
  check('compositore: attivo (azioni disponibili)', await area.isEnabled());
  check('compositore: invio disattivato a campo vuoto', await sendBtn.isDisabled());
  const cfs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.composer-input')).fontSize));
  check('compositore: font >= 16px', cfs >= 16, `${cfs}px`);
  await area.fill('Prima riga\nSeconda riga\nTerza riga\nQuarta riga');
  const grown = (await area.boundingBox()).height;
  check('compositore: il campo cresce con il testo', grown > 60, `${Math.round(grown)}px`);
  check('compositore: invio attivo con testo', await sendBtn.isEnabled());
  await shot('05-composer');
  // la bozza resta tornando indietro e rientrando
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.row');
  await page.goto(CHAT(4));
  await page.waitForSelector('.composer-input');
  check('compositore: la bozza si conserva uscendo e rientrando', (await page.locator('.composer-input').inputValue()).startsWith('Prima riga'));
  await page.locator('.send').click();
  await page.waitForSelector('.dock-status', { state: 'visible', timeout: 8000 });
  const st = await page.locator('.dock-status').innerText();
  check('compositore: esito mostrato', /inviato|coda/i.test(st), st);
  check('compositore: campo svuotato dopo l\'invio', (await page.locator('.composer-input').inputValue()) === '');
  await shot('06-sent');

  // --- immagini allegate: scelta, anteprima, rimozione, invio ---
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.waitForSelector('.attach');
  check('immagini: pulsante "Allega immagini" con icona SVG', (await page.locator('.attach svg').count()) === 1 && (await page.locator('.attach').isEnabled()));
  await page.locator('input[type=file]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') }, { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') }]);
  await page.waitForFunction(() => document.querySelectorAll('.attach-item').length === 2 && !document.querySelector('.attach-item.loading'), null, { timeout: 8000 });
  check('immagini: due anteprime, invio attivo anche senza testo', (await page.locator('.attach-item img').count()) === 2 && (await page.locator('.send').isEnabled()));
  await shot('20-attach');
  await page.locator('.attach-remove').first().click();
  check('immagini: "Rimuovi" toglie l\'anteprima', (await page.locator('.attach-item').count()) === 1);
  await page.locator('.send').click();
  await page.waitForFunction(() => document.querySelectorAll('.attach-item').length === 0, null, { timeout: 10000 });
  check('immagini: dopo l\'invio le anteprime spariscono e compare l\'esito', /inviato|coda/i.test(await page.locator('.dock-status').innerText()));
  await page.locator('input[type=file]').setInputFiles([{ name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('non un\'immagine') }]);
  await page.waitForFunction(() => /non supportato|non caricata/i.test(document.querySelector('.dock-status')?.textContent || ''), null, { timeout: 8000 });
  check('immagini: un file che non e\' un\'immagine viene rifiutato con un avviso', (await page.locator('.attach-item').count()) === 0);

  // --- doppio tocco: la rete di sicurezza blocca il secondo tocco ravvicinato ---
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
  await page.touchscreen.tap(tb.x, tb.y); // doppio tocco
  await sleep(700);
  await page.touchscreen.tap(tb.x, tb.y); // tocco isolato, lontano nel tempo
  await sleep(100);
  const dt = await page.evaluate(() => window.__taps);
  check('doppio tocco: il primo tocco passa', dt.length === 3 && dt[0].prevented === false, JSON.stringify(dt));
  check('doppio tocco: il secondo tocco ravvicinato viene bloccato', dt[1]?.prevented === true);
  check('doppio tocco: un tocco isolato dopo non viene bloccato', dt[2]?.prevented === false);

  // --- impostazioni ---
  await page.waitForSelector('text=Rispondere dal telefono');
  const diagText = await page.locator('section.panel', { hasText: 'Diagnostica connessione' }).innerText();
  check('impostazioni: diagnostica connessione (flusso attivo, eventi e tempo di risposta)', diagText.includes('Flusso live') && diagText.includes('attivo') && /Tempo di risposta del daemon\s+\d+ ms/.test(diagText.replace(/\n/g, ' ')), diagText.replace(/\n/g, ' | ').slice(0, 160));
  check('impostazioni: pannello "Rispondere dal telefono" con stato Attivo', await page.locator('text=Attivo. Dalle chat').isVisible());
  await shot('07-settings');

  // --- conversazione intera: solo lettura, a pagine dal fondo ---
  await page.goto(CHAT(8));
  await page.waitForSelector('a[href$="/storia"]');
  await page.locator('a[href$="/storia"]').click();
  await page.waitForSelector('.hist-msg');
  await sleep(300);
  check('conversazione: si apre dal link, parte dal fondo (ultimo messaggio visibile)', await page.locator('.hist-msg', { hasText: 'Ho generato la documentazione' }).isVisible());
  check('conversazione: solo lettura (nessun compositore) e senza barra in basso', (await page.locator('.composer-input').count()) === 0 && !(await page.locator('.tabbar').isVisible()));
  check('conversazione: i tool sono righe discrete con icona SVG', (await page.locator('.hist-tool svg').count()) >= 1 && !(await page.locator('.hist-list').innerText()).includes('schema.json'));
  const nBefore = await page.locator('.hist-msg').count();
  check('conversazione: c\'e\' "Messaggi precedenti" (oltre una pagina)', await page.locator('.hist-older').isVisible() || nBefore > 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.hist-older').click();
  await page.waitForFunction((n) => document.querySelectorAll('.hist-msg').length > n, nBefore, { timeout: 8000 });
  check('conversazione: "Messaggi precedenti" carica altri messaggi e il bottone sparisce a fine storia', (await page.locator('.hist-msg', { hasText: /Domanda numero 1 sulla/ }).count()) === 1 && (await page.locator('.hist-older').count()) === 0);
  await shot('16-history');
  await page.locator('.appbar-back').click();
  await page.waitForSelector('.chat-head');

  // --- gestione chat: rinomina, archivia, ripristina ---
  await page.goto(CHAT(13));
  await page.waitForSelector('.manage');
  check('gestione: in una chat ferma ci sono "Rinomina" e "Archivia" (con icone SVG)', (await page.locator('.manage .btn svg').count()) === 2 && (await page.locator('.manage .btn', { hasText: 'Archivia' }).isEnabled()));
  await page.locator('.manage .btn', { hasText: 'Rinomina' }).click();
  await page.waitForSelector('#rename-input');
  check('gestione: il campo del nome parte con il nome attuale e il focus', (await page.locator('#rename-input').inputValue()) === 'Testi della pagina iniziale' && (await page.evaluate(() => document.activeElement?.id)) === 'rename-input');
  await shot('18-rename');
  await page.locator('#rename-input').fill('Testi rivisti');
  await page.locator('.rename-form .btn.primary').click();
  await page.waitForFunction(() => document.querySelector('.chat-name')?.textContent === 'Testi rivisti', null, { timeout: 10000 });
  check('gestione: dopo "Salva" il titolo della chat cambia e il campo si chiude', (await page.locator('#rename-input').count()) === 0 && (await page.locator('.manage', { hasText: 'Nome cambiato' }).count()) === 1);
  await page.locator('.manage .btn', { hasText: 'Archivia' }).click();
  check('gestione: "Archivia" chiede un secondo tocco', (await page.locator('.manage .btn.armed').innerText()).includes('Conferma'));
  await page.locator('.manage .btn.armed').click();
  await page.waitForFunction(() => location.hash === '#/chat', null, { timeout: 10000 });
  check('gestione: archiviata, si torna all\'elenco e la chat non c\'e\' piu\'', (await page.locator('.row', { hasText: 'Testi rivisti' }).count()) === 0);
  await page.goto(`${BASE}/#/impostazioni`);
  await page.locator('a[href="#/archivio"]').click();
  await page.waitForSelector('.list .row');
  check('archivio: compaiono le due chat archiviate (con icona e "Ripristina")', (await page.locator('.list .row').count()) === 2 && (await page.locator('.list .row', { hasText: 'Testi rivisti' }).count()) === 1 && (await page.locator('.list .row .btn svg').count()) === 2);
  await shot('19-archive');
  await page.locator('.list .row', { hasText: 'Prova di un tema scuro' }).locator('.btn').click();
  await page.waitForFunction(() => document.querySelectorAll('.list .row').length === 1, null, { timeout: 10000 });
  check('archivio: dopo "Ripristina" la chat esce dall\'elenco e compare l\'esito', (await page.locator('.banner', { hasText: 'ripristinata' }).count()) === 1);
  await page.locator('.list .row', { hasText: 'Testi rivisti' }).locator('.btn').click();
  await page.waitForSelector('.empty');
  check('archivio: senza chat archiviate c\'e\' lo stato vuoto', (await page.locator('.empty h2', { hasText: 'Nessuna chat archiviata' }).count()) === 1);

  // --- nuova chat: dalla scheda Chat, con progetto, testo e immagine ---
  await page.goto(`${BASE}/#/chat`);
  await page.waitForSelector('a[aria-label="Nuova chat"]');
  check('nuova chat: il pulsante "Nuova chat" e\' in alto nella scheda Chat (icona SVG)', (await page.locator('a[aria-label="Nuova chat"] svg').count()) === 1);
  await page.locator('a[aria-label="Nuova chat"]').click();
  await page.waitForSelector('#newchat-project');
  check('nuova chat: elenco dei progetti, campo per il messaggio, "Avvia" disattivato a campo vuoto', (await page.locator('#newchat-project [role=radio]').count()) === 3 && (await page.locator('.newchat button[type=submit]').isDisabled()));
  await page.locator('#newchat-project [role=radio]', { hasText: 'sito-vetrina' }).click();
  check('nuova chat: il progetto toccato risulta scelto (uno solo)', (await page.locator('#newchat-project [aria-checked=true]').count()) === 1 && (await page.locator('#newchat-project [aria-checked=true]').innerText()).includes('sito-vetrina'));
  await page.locator('#newchat-text').fill('Aggiungi una pagina contatti');
  await page.locator('input[type=file]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') }]);
  await page.waitForFunction(() => document.querySelectorAll('.attach-item').length === 1 && !document.querySelector('.attach-item.loading'), null, { timeout: 8000 });
  await shot('21-newchat');
  check('nuova chat: con testo e immagine "Avvia" e\' attivo', await page.locator('.newchat button[type=submit]').isEnabled());
  await page.locator('.newchat button[type=submit]').click();
  await page.waitForFunction(() => /^#\/chat\/00000000-0000-4000-8000-0000000001\d\d$/.test(location.hash), null, { timeout: 15000 });
  await page.waitForSelector('.chat-name');
  check('nuova chat: dopo l\'avvio si apre la pagina della chat creata (nel progetto scelto)', (await page.locator('.chat-name').innerText()).startsWith('Aggiungi una pagina') && (await page.locator('.appbar-title').innerText()) === 'sito-vetrina');

  // --- Mac sveglio: interruttore in Impostazioni (con una chat in corso diventa attivo) ---
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('.switch[aria-label="Resta sveglio mentre un agente lavora"]');
  const awakeSw = page.locator('.switch[aria-label="Resta sveglio mentre un agente lavora"]');
  check('mac sveglio: spento di default', (await awakeSw.getAttribute('aria-checked')) === 'false');
  await awakeSw.click();
  await page.waitForFunction(() => document.querySelector('.switch[aria-label="Resta sveglio mentre un agente lavora"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 8000 });
  await page.waitForSelector('text=Attivo adesso', { timeout: 8000 });
  check('mac sveglio: acceso compaiono i due livelli (schermo chiuso, luminosita)', (await page.locator('.switch[aria-label="Anche a schermo chiuso e a batteria"]').isVisible()) && (await page.locator('.switch[aria-label^="Luminosit"]').isVisible()));
  await page.locator('.switch[aria-label="Anche a schermo chiuso e a batteria"]').click();
  await page.waitForFunction(() => document.querySelector('.switch[aria-label="Anche a schermo chiuso e a batteria"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 8000 });
  await page.waitForSelector('text=Attivo adesso >> nth=1', { timeout: 8000 });
  await shot('17-awake');
  await page.locator('.switch[aria-label="Anche a schermo chiuso e a batteria"]').click();
  await awakeSw.click();
  await page.waitForFunction(() => document.querySelector('.switch[aria-label="Resta sveglio mentre un agente lavora"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 8000 });

  // --- dispositivi abbinati: l'altro dispositivo si scollega con due tocchi ---
  await page.goto(`${BASE}/#/impostazioni`);
  await page.waitForSelector('.device-row');
  check('dispositivi: elenco con questo dispositivo e un altro (iPad)', (await page.locator('.device-row').count()) === 2 && (await page.locator('.device-row', { hasText: 'Questo dispositivo' }).count()) === 1 && (await page.locator('.device-row', { hasText: 'iPad' }).count()) === 1);
  check('dispositivi: il dispositivo corrente non ha "Scollega"', (await page.locator('.device-row', { hasText: 'Questo dispositivo' }).locator('button').count()) === 0);
  await shot('15-devices');
  await page.locator('.device-row', { hasText: 'iPad' }).locator('button').click();
  check('dispositivi: il primo tocco chiede conferma', (await page.locator('.device-row', { hasText: 'iPad' }).locator('button').innerText()).includes('Tocca ancora'));
  await page.locator('.device-row', { hasText: 'iPad' }).locator('button').click();
  await page.waitForFunction(() => !document.querySelector('.device-row'), null, { timeout: 8000 });
  check('dispositivi: dopo il secondo tocco l\'iPad sparisce (e con un solo dispositivo il pannello non c\'e\')', (await page.locator('.device-row').count()) === 0);

  // --- ferma l'agente: il pulsante di invio diventa "Ferma" a campo vuoto, serve un secondo tocco ---
  await page.goto(CHAT(2));
  await page.waitForSelector('.composer-input');
  await page.waitForSelector('.send.stop', { timeout: 8000 });
  check('ferma: con l\'agente al lavoro e il campo vuoto il pulsante e\' "Ferma" (icona SVG)', (await page.locator('.send.stop svg').count()) === 1 && (await page.locator('.send.stop').isEnabled()));
  await page.locator('.composer-input').fill('x');
  check('ferma: scrivendo torna "Invia"', (await page.locator('.send.stop').count()) === 0 && (await page.locator('.send').isEnabled()));
  await page.locator('.composer-input').fill('');
  await page.locator('.send.stop').click();
  await page.waitForSelector('.send.stop.armed');
  check('ferma: il primo tocco chiede conferma e non ferma nulla', (await page.locator('.dock-status').innerText()).includes('Tocca ancora'));
  await shot('14-stop-armed');
  await page.locator('.send.stop').click();
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 12000 });
  check('ferma: dopo il secondo tocco l\'agente e\' fermo e il pulsante torna "Invia"', (await page.locator('.send').count()) === 1);

  // --- niente scorrimento orizzontale ---
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('nessun scorrimento orizzontale', overflow <= 0, `${overflow}px`);

  check('nessun errore in console / violazione CSP', problems.length === 0, problems.join(' | '));
} catch (err) {
  check(`ECCEZIONE: ${String(err.message).split('\n')[0]}`, false);
  await shot('zz-errore');
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${engineName}: ${results.length - failed}/${results.length} controlli superati`);
process.exit(failed ? 1 : 0);
