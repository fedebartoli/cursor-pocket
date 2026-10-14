// Azioni sull'interfaccia dell'Agents Window di Cursor via CDP (Fase 2): aprire una chat, rispondere al questionario
// di `ask_question`, saltarlo, scrivere un messaggio.
//
// QUESTO e' il solo file che conosce la struttura della pagina di Cursor: selettori in `SEL`, script eseguiti nella
// pagina in `pageKit`/`pageDo`. Se un aggiornamento di Cursor li rompe, si corregge qui (vedi FINDINGS sez. 10).
//
// Origine dei selettori: bundle `out/vs/workbench/workbench.glass.main.js` di Cursor 3.24 (lettura, mai modifiche):
//  - questionario: componente `kVC` (classe `glass-questionnaire-tray`), opzioni `ui-tray-option`, campo libero
//    `questionnaire-freeform-option` ("Other..."), footer con azione primaria ("Next"/"Continue") e "Skip";
//  - cliccare un'opzione di una domanda a scelta SINGOLA gia' selezionata la DESELEZIONA (funzione `Weg`); con scelta
//    singola selezionare un'opzione fa avanzare da solo allo step successivo (`Jnl`); l'invio finale e' sempre il
//    pulsante primario;
//  - composer: editor Lexical `aislash-editor-input` e pulsante con aria-label "Send message";
//  - sidebar: righe con attributo `data-sidebar-item-key` (forma `row:<id>`).
// Cio' che non e' ancora provato su un'istanza reale e' segnato [DA VERIFICARE] e coperto da diagnostica (`inspect`).
//
// Regole di sicurezza: nessun contenuto di chat nei log o negli errori; gli script di pagina non scrivono nulla se non
// tramite eventi di input (clic, testo, tasti) uguali a quelli di un utente.
import { sleep as realSleep } from '../util.js';
import { CdpError, CdpSession, KEYS, MODIFIER, listPageTargets, probeCdp } from './cdp.js';
import { FREEFORM_ID } from './questions.js';

export { FREEFORM_ID };

export class UiError extends CdpError {}

export const SEL = Object.freeze({
  tray: '.glass-questionnaire-tray',
  option: '.ui-tray-option',
  optionBadge: '.ui-tray-option__badge',
  optionLabel: '.ui-tray-option__label',
  freeform: '.questionnaire-freeform-option',
  primary: '.ui-tray-footer__primary button',
  secondary: '.ui-tray-footer__secondary button',
  sidebarRowAttr: 'data-sidebar-item-key',
  sidebarRow: '[data-sidebar-item-key]',
  // Cursor 3.24 reale: editor tiptap/ProseMirror; i selettori Lexical restano per le versioni precedenti.
  composer: '.ui-prompt-input-editor__input[contenteditable="true"], .aislash-editor-input[contenteditable="true"], [data-lexical-editor="true"][contenteditable="true"]',
  composerReadonly: '.aislash-editor-input-readonly, .ui-prompt-input-tiptap-readonly',
  // Cursor tiene vivi i pannelli di piu' chat: ognuno ha `data-glass-agent-id` = composerId; quelli non in primo piano
  // portano `data-keep-alive-hidden`. Composer, vassoio e invio si cercano SOLO nel pannello in primo piano.
  panel: '[data-agent-panel-conversation-shell]',
  panelAgentAttr: 'data-glass-agent-id',
  panelHidden: '[data-keep-alive-hidden]',
  send: 'button[aria-label="Send message"]',
  // Mentre l'agente lavora e il campo e' vuoto il pulsante di invio diventa "Stop generation".
  stop: 'button[aria-label="Stop generation"]',
  // Approvazione di un comando di terminale (Cursor 3.24): la carta `.ui-shell-tool-call` sta dentro la riga del
  // transcript, che porta `data-message-id` = id del bubble nel database. In fondo ha "Skip" e "Run" (piu' il menu
  // delle opzioni e il pulsante della modalita' di esecuzione automatica, che NON si toccano).
  shellCard: '.ui-shell-tool-call',
  // Menu contestuale di una riga (tasto destro) e rinomina in linea: voci `role=menuitem`; il campo del nome e' un input
  // `ui-text-editable` dentro la riga, con il testo gia' selezionato.
  menuItem: '[role="menuitem"],[role="menuitemcheckbox"]',
  renameInput: 'input.ui-text-editable',
  customize: 'button[aria-label="Customize Sidebar"]',
  messageIdAttr: 'data-message-id',
});

// Etichette dei due pulsanti della carta (inglese; italiano per le interfacce localizzate). "Run Everything (...)" e'
// il selettore della modalita' automatica: l'espressione e' ancorata di proposito perche' NON lo catturi.
const APPROVE_LABEL = '^(run|esegui)\\s*(\\u23ce|\\u21b5|enter)?$';
const REJECT_LABEL = '^(skip|salta)$';
// Voci del menu di una riga (inglese; italiano per le interfacce localizzate).
const MENU = Object.freeze({
  rename: '^(rename|rinomina)$',
  archive: '^(archive|archivia)$',
  unarchive: '^(unarchive|restore|ripristina|dearchivia)$',
  archivedFilter: '^(archived|archiviat[eio])$',
});

// ---------------------------------------------------------------------------------------------------------------
// Codice eseguito NELLA PAGINA di Cursor. Le due funzioni sono autosufficienti (niente variabili del modulo):
// vengono inviate come testo con Function.prototype.toString.
// ---------------------------------------------------------------------------------------------------------------

/* eslint-disable no-undef */
function pageKit(SEL, APPROVE_LABEL, REJECT_LABEL) {
  const K = { SEL };
  // Su Cursor 3.24 reale `innerText` del questionario e' VUOTO anche se l'elemento e' visibile (verificato dal vivo):
  // si ripiega su `textContent`.
  K.text = (el) => (el ? String(el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  K.visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return !el.closest('[hidden],[inert]');
  };
  K.selectedClass = (el) =>
    [...(el.classList || [])].some((c) => /(^|[-_])(selected|checked|active)$/i.test(c) || /--(selected|checked|active)/i.test(c));
  K.hasSignal = (el) => ['aria-pressed', 'aria-checked', 'aria-selected', 'data-selected', 'data-state'].some((a) => el.hasAttribute(a));
  K.isSelected = (el) => {
    if (!el) return false;
    const a = (n) => el.getAttribute(n);
    if (a('aria-pressed') === 'true' || a('aria-checked') === 'true' || a('aria-selected') === 'true') return true;
    const d = a('data-selected');
    if (d !== null && d !== 'false') return true;
    const s = a('data-state');
    if (s === 'checked' || s === 'selected' || s === 'on' || s === 'active') return true;
    return K.selectedClass(el);
  };
  K.isDisabled = (el) => !!el && (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'));
  K.rect = (el) => {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const covered = !hit || !(el === hit || el.contains(hit) || hit.contains(el));
    return { x, y, w: Math.round(r.width), h: Math.round(r.height), covered };
  };
  K.clickable = (el) => (el.matches('button,[role="button"],a') ? el : el.querySelector('button,[role="button"]') || el);
  K.panelHidden = (p) => {
    const h = p.closest(SEL.panelHidden);
    return !!h && h.getAttribute('data-keep-alive-hidden') !== 'false';
  };
  K.panel = () => [...document.querySelectorAll(SEL.panel)].find((p) => K.visible(p) && !K.panelHidden(p)) || null;
  K.panelAgent = () => {
    const p = K.panel();
    return p ? p.getAttribute(SEL.panelAgentAttr) || '' : null;
  };
  K.scope = () => K.panel() || document;
  K.tray = () => [...K.scope().querySelectorAll(SEL.tray)].find(K.visible) || null;
  K.freeformRoot = (tray) => (tray ? [...tray.querySelectorAll(SEL.freeform)].find(K.visible) || null : null);
  K.regularOptions = (tray) => {
    const ff = K.freeformRoot(tray);
    return [...tray.querySelectorAll(SEL.option)].filter(
      (el) => K.visible(el) && !(el.parentElement && el.parentElement.closest(SEL.option)) && !(ff && (el === ff || ff.contains(el) || el.contains(ff))),
    );
  };
  K.editorIn = (root) => [...root.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]')].find(K.visible) || null;
  K.editorText = (ed) => (ed ? String(ed.value ?? (ed.innerText || ed.textContent) ?? '') : '').replace(/\u00a0/g, ' ').replace(/\n+$/g, '').trim();
  K.buttons = (root) => [...root.querySelectorAll('button,[role="button"]')].filter(K.visible);
  K.primary = (tray) => [...tray.querySelectorAll(SEL.primary)].find(K.visible) || null;
  K.secondary = (tray) => {
    const bySel = [...tray.querySelectorAll(SEL.secondary)].find(K.visible);
    return bySel || K.buttons(tray).find((b) => /^(skip|salta)$/i.test(K.text(b))) || null;
  };
  K.composer = () => {
    const all = [...K.scope().querySelectorAll(SEL.composer)].filter((el) => K.visible(el) && !el.closest(SEL.tray) && !el.closest(SEL.composerReadonly));
    all.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return all[0] || null;
  };
  K.approvalCard = (messageId) =>
    [...K.scope().querySelectorAll(SEL.shellCard)].find((c) => {
      if (!K.visible(c)) return false;
      const row = c.closest('[' + SEL.messageIdAttr + ']');
      return !!row && row.getAttribute(SEL.messageIdAttr) === messageId;
    }) || null;
  K.approvalButtons = (card) => {
    const list = K.buttons(card);
    const approve = list.find((b) => new RegExp(APPROVE_LABEL, 'i').test(K.text(b)));
    const reject = list.find((b) => new RegExp(REJECT_LABEL, 'i').test(K.text(b)));
    return { approve: approve || null, reject: reject || null };
  };
  K.rows = () => [...document.querySelectorAll(SEL.sidebarRow)];
  K.rowKey = (row) => row.getAttribute(SEL.sidebarRowAttr) || '';
  K.rowSelected = (row) =>
    row.matches('[aria-selected="true"],[aria-current="true"],[aria-current="page"],[data-selected="true"],[data-sidebar-selected-static-row],[data-sidebar-selected="true"]') ||
    !!row.querySelector('[data-sidebar-selected-static-row],[aria-selected="true"],[aria-current="true"]') ||
    K.selectedClass(row);
  K.findRow = (id) => {
    const rows = K.rows();
    return rows.find((r) => K.rowKey(r) === `row:${id}`) || rows.find((r) => K.rowKey(r).endsWith(id)) || null;
  };
  K.send = () => {
    const c = K.composer();
    const root = (c && (c.closest('form') || c.parentElement?.parentElement?.parentElement?.parentElement)) || document;
    return [...root.querySelectorAll(SEL.send)].find(K.visible) || [...document.querySelectorAll(SEL.send)].find(K.visible) || null;
  };
  K.menuItems = () => [...document.querySelectorAll(SEL.menuItem)].filter(K.visible);
  K.menuItem = (re) => K.menuItems().find((m) => new RegExp(re, 'i').test(K.text(m))) || null;
  K.renameInput = () => [...document.querySelectorAll(SEL.renameInput)].find(K.visible) || null;
  K.customize = () => [...document.querySelectorAll(SEL.customize)].find(K.visible) || null;
  K.stop = () => [...K.scope().querySelectorAll(SEL.stop)].find(K.visible) || null;
  return K;
}

function pageDo(a, K) {
  const SEL = K.SEL;
  const describe = (el, extra) => ({ found: true, ...K.rect(el), disabled: K.isDisabled(el), selected: K.isSelected(el), ...(extra || {}) });
  const resolve = () => {
    const tray = K.tray();
    switch (a.target) {
      case 'option': {
        if (!tray) return null;
        const el = K.regularOptions(tray)[a.index];
        return el ? K.clickable(el) : null;
      }
      case 'freeform': {
        // Si clicca l'etichetta (non il centro: a campo aperto al centro c'e' l'editor, che non commuta la selezione).
        const ff = K.freeformRoot(tray);
        return ff ? ff.querySelector(SEL.optionLabel) || ff.querySelector(SEL.optionBadge) || K.clickable(ff) : null;
      }
      case 'freeformEditor': {
        const ff = K.freeformRoot(tray);
        return ff ? K.editorIn(ff) : null;
      }
      case 'primary':
        return tray ? K.primary(tray) : null;
      case 'secondary':
        return tray ? K.secondary(tray) : null;
      case 'approve':
      case 'reject': {
        const card = K.approvalCard(a.messageId);
        const b = card ? K.approvalButtons(card) : null;
        return b ? (a.target === 'approve' ? b.approve : b.reject) : null;
      }
      case 'row':
        return K.findRow(a.id);
      case 'selectedRow':
        return K.rows().find(K.rowSelected) || null;
      case 'composer':
        return K.composer();
      case 'send':
        return K.send();
      case 'stop':
        return K.stop();
      case 'menuitem':
        return K.menuItem(a.label);
      case 'renameInput':
        return K.renameInput();
      case 'customize':
        return K.customize();
      default:
        return null;
    }
  };

  switch (a.op) {
    case 'tray': {
      const tray = K.tray();
      if (!tray) return null;
      const ff = K.freeformRoot(tray);
      const regular = K.regularOptions(tray).map((el, i) => ({
        i,
        badge: K.text(el.querySelector(SEL.optionBadge)),
        label: K.text(el.querySelector(SEL.optionLabel)) || K.text(el),
        selected: K.isSelected(el) || K.isSelected(K.clickable(el)),
        signal: K.hasSignal(el) || K.hasSignal(K.clickable(el)),
      }));
      const ed = ff ? K.editorIn(ff) : null;
      const primary = K.primary(tray);
      const secondary = K.secondary(tray);
      return {
        text: K.text(tray).slice(0, 6000),
        options: regular,
        freeform: ff ? { present: true, selected: K.isSelected(ff) || K.isSelected(K.clickable(ff)), editorVisible: !!ed, text: K.editorText(ed) } : { present: false, selected: false, editorVisible: false, text: '' },
        primary: primary ? { label: K.text(primary), disabled: K.isDisabled(primary) } : null,
        secondary: secondary ? { label: K.text(secondary), disabled: K.isDisabled(secondary) } : null,
      };
    }
    case 'locate': {
      const el = resolve();
      if (!el) return { found: false };
      const extra = {};
      if (a.target === 'row') extra.key = K.rowKey(el);
      return describe(el, extra);
    }
    case 'jsclick': {
      const el = resolve();
      if (!el || K.isDisabled(el)) return false;
      el.click();
      return true;
    }
    case 'focusState': {
      const el = resolve();
      if (!el) return { found: false };
      const active = document.activeElement;
      return { found: true, focused: !!active && (active === el || el.contains(active)), text: K.editorText(el), empty: K.editorText(el) === '' };
    }
    case 'selectedKey': {
      const row = K.rows().find(K.rowSelected);
      if (row) return K.rowKey(row);
      // Nessun marcatore di riga selezionata in Cursor 3.24: la chat aperta si riconosce dal pannello in primo piano.
      const agent = K.panelAgent();
      return agent ? `row:${agent}` : null;
    }
    case 'composerInfo': {
      const c = K.composer();
      const s = K.send();
      return {
        composer: c ? { text: K.editorText(c), empty: K.editorText(c) === '' } : null,
        send: s ? { disabled: K.isDisabled(s) } : null,
        stop: !!K.stop(),
        tray: !!K.tray(),
      };
    }
    case 'approvalState': {
      const card = K.approvalCard(a.messageId);
      if (!card) return { found: false };
      const b = K.approvalButtons(card);
      return { found: true, approve: !!b.approve && !K.isDisabled(b.approve), reject: !!b.reject && !K.isDisabled(b.reject) };
    }
    case 'menuState': {
      const f = K.menuItem(a.label);
      return { open: document.querySelectorAll('[role="menu"]').length > 0, checked: f ? f.getAttribute('aria-checked') : null };
    }
    case 'focusRename': {
      const i = K.renameInput();
      if (!i) return { editing: false, focused: false };
      i.focus();
      i.select();
      return { editing: true, focused: document.activeElement === i };
    }
    case 'renameState': {
      const i = K.renameInput();
      return { editing: !!i, focused: !!i && document.activeElement === i, value: i ? String(i.value || '') : '' };
    }
    case 'outline': {
      // Solo struttura: nomi di attributi e classi, mai testi.
      const attrNames = (el) => (el ? [...el.attributes].map((x) => x.name).filter((n) => n !== 'style').slice(0, 14) : null);
      const tray = K.tray();
      const opts = tray ? K.regularOptions(tray) : [];
      const ff = K.freeformRoot(tray);
      const c = K.composer();
      const s = K.send();
      const rows = K.rows();
      return {
        counts: {
          tray: document.querySelectorAll(SEL.tray).length,
          options: opts.length,
          freeform: ff ? 1 : 0,
          primary: tray && K.primary(tray) ? 1 : 0,
          secondary: tray && K.secondary(tray) ? 1 : 0,
          rows: rows.length,
          composers: document.querySelectorAll(SEL.composer).length,
          send: document.querySelectorAll(SEL.send).length,
        },
        selectedKey: (rows.find(K.rowSelected) && K.rowKey(rows.find(K.rowSelected)).slice(0, 80)) || null,
        sampleKeys: rows.slice(0, 6).map((r) => K.rowKey(r).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>').slice(0, 60)),
        optionAttrs: opts[0] ? attrNames(opts[0]) : null,
        optionClasses: opts[0] ? [...opts[0].classList].slice(0, 8) : null,
        freeformAttrs: ff ? attrNames(ff) : null,
        freeformClasses: ff ? [...ff.classList].slice(0, 8) : null,
        primaryClasses: tray && K.primary(tray) ? [...K.primary(tray).classList].slice(0, 8) : null,
        composerClasses: c ? [...c.classList].slice(0, 8) : null,
        composerAttrs: attrNames(c),
        sendAttrs: attrNames(s),
        title: document.title.slice(0, 80),
      };
    }
    default:
      throw new Error(`operazione sconosciuta: ${a.op}`);
  }
}
/* eslint-enable no-undef */

function expressionFor(args) {
  return `(${pageDo.toString()})(${JSON.stringify(args)}, (${pageKit.toString()})(${JSON.stringify(SEL)}, ${JSON.stringify(APPROVE_LABEL)}, ${JSON.stringify(REJECT_LABEL)}))`;
}

// ---------------------------------------------------------------------------------------------------------------
// Parte Node: operazioni di alto livello
// ---------------------------------------------------------------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s) => (String(s ?? '').toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]{4,}/gu) || []).slice(0, 14);

/** Il testo visibile del questionario contiene questa domanda? (il prompt e' Markdown: si confronta in modo tollerante) */
export function promptMatches(trayText, prompt) {
  const t = norm(trayText);
  const p = norm(prompt);
  if (!p) return false;
  if (t.includes(p.slice(0, 24))) return true;
  const ws = words(prompt);
  if (ws.length < 3) return false;
  const spaced = String(trayText ?? '').toLowerCase().normalize('NFKD');
  const hits = ws.filter((w) => spaced.includes(w)).length;
  return hits / ws.length >= 0.7;
}

/** Indice della domanda mostrata ora nel tray (-1 se nessuna o ambigua). */
export function currentQuestionIndex(view, questions) {
  const hits = [];
  questions.forEach((q, i) => {
    if (promptMatches(view.text, q.prompt)) hits.push(i);
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // piu' prompt simili: decide chi ha piu' etichette di opzione presenti nel testo visibile
    const t = norm(view.text);
    const score = (i) => questions[i].options.filter((o) => norm(o.label) && t.includes(norm(o.label).slice(0, 16))).length;
    hits.sort((a, b) => score(b) - score(a));
    return score(hits[0]) > score(hits[1]) ? hits[0] : -1;
  }
  return -1;
}

async function waitFor(fn, { timeoutMs = 3000, intervalMs = 100, sleep = realSleep } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

/** Contesto di una sessione CDP: wrapper comodi per gli script di pagina. */
class Ctx {
  constructor(session, { sleep }) {
    this.s = session;
    this.sleep = sleep;
  }

  page(args, opts) {
    return this.s.evaluate(expressionFor(args), opts);
  }

  readTray() {
    return this.page({ op: 'tray' });
  }

  locate(args) {
    return this.page({ op: 'locate', ...args });
  }

  /** Clic reale sull'elemento (con ripiego su element.click() se coperto o senza dimensioni). */
  async clickTarget(args) {
    const loc = await this.locate(args);
    if (!loc.found) throw new UiError('not_found', `elemento non trovato: ${args.target}`);
    if (loc.disabled) throw new UiError('disabled', `elemento disattivato: ${args.target}`);
    if (loc.covered || loc.w < 2 || loc.h < 2) {
      if (await this.page({ op: 'jsclick', ...args })) return;
      throw new UiError('click_failed', `clic non riuscito: ${args.target}`);
    }
    await this.s.click(loc.x, loc.y);
  }

  /** Tasto destro al centro dell'elemento (menu contestuale). */
  async rightClick(args) {
    const loc = await this.locate(args);
    if (!loc.found) throw new UiError('not_found', `elemento non trovato: ${args.target}`);
    const base = { x: loc.x, y: loc.y, button: 'right', clickCount: 1 };
    await this.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
    await this.s.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 2 });
    await this.s.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }

  /** Scrive testo con il focus gia' sull'elemento; `\n` diventa Maiusc+Invio (a capo senza inviare). */
  async typeText(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.s.insertText(lines[i]);
      if (i < lines.length - 1) await this.s.pressKey(KEYS.enter, { modifiers: MODIFIER.shift });
    }
  }

  async focusState(target) {
    return this.page({ op: 'focusState', target });
  }
}

export class AgentsUi {
  /**
   * @param {{ port: number, restoreSelection?: boolean, sleep?: Function, WebSocketImpl?: Function }} opts
   */
  constructor({ port, restoreSelection = true, sleep = realSleep, WebSocketImpl } = {}) {
    this.port = port;
    this.restoreSelection = restoreSelection;
    this.sleep = sleep;
    this.WebSocketImpl = WebSocketImpl;
  }

  /** Stato leggero (solo HTTP): la porta risponde? */
  probe() {
    return probeCdp(this.port);
  }

  /** La finestra Agents e' raggiungibile? Solo HTTP, mai un'eccezione. */
  async hasWindow() {
    try {
      await this.#target();
      return true;
    } catch {
      return false;
    }
  }

  async #target() {
    const targets = await listPageTargets(this.port);
    const t =
      targets.find((x) => /agents/i.test(x.title)) ||
      targets.find((x) => /glass/i.test(x.url)) ||
      null;
    if (!t) throw new UiError('no_window', 'finestra Agents non trovata');
    return t;
  }

  /** Apre una sessione sulla finestra Agents, esegue `fn(ctx)` e chiude sempre. */
  async withSession(fn) {
    const target = await this.#target();
    const session = await CdpSession.open(target.wsUrl, { WebSocketImpl: this.WebSocketImpl });
    try {
      // La pagina si comporta come se avesse il focus anche se Cursor e' in secondo piano (vale solo per questa sessione).
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      return await fn(new Ctx(session, { sleep: this.sleep }));
    } finally {
      session.close();
    }
  }

  /** Diagnostica per `npm run cdp -- inspect`: porta, finestre e STRUTTURA della pagina (mai testi). */
  async inspect() {
    const p = await this.probe();
    if (!p.up) return { up: false };
    const targets = await listPageTargets(this.port).catch(() => []);
    const out = { up: true, browser: p.browser, targets: targets.map((t) => ({ title: t.title, url: t.url.replace(/^(.{0,140}).*$/, '$1') })) };
    try {
      out.page = await this.withSession((ctx) => ctx.page({ op: 'outline' }));
    } catch (err) {
      out.pageError = err.code || 'errore';
    }
    return out;
  }

  /** Stato del questionario visibile (o null). */
  readTray() {
    return this.withSession((ctx) => ctx.readTray());
  }

  async #openChat(ctx, composerId) {
    const previous = await ctx.page({ op: 'selectedKey' }).catch(() => null);
    const loc = await ctx.locate({ target: 'row', id: composerId });
    if (!loc.found) throw new UiError('row_not_found', 'chat non trovata nella sidebar di Cursor');
    if (previous && previous === loc.key) return previous; // gia' aperta: niente da fare
    await ctx.clickTarget({ target: 'row', id: composerId });
    // [DA VERIFICARE] il marcatore di riga selezionata; se non esiste, si attende un tempo breve.
    const selected = await waitFor(async () => (await ctx.page({ op: 'selectedKey' }).catch(() => null)) === loc.key, { timeoutMs: 1500, sleep: this.sleep });
    if (!selected) await this.sleep(500);
    return previous;
  }

  async #restore(ctx, previous, composerId) {
    if (!this.restoreSelection || !previous || previous === `row:${composerId}`) return;
    try {
      const loc = await ctx.locate({ target: 'selectedRow' });
      if (loc.found && loc.key === previous) return;
      const id = previous.replace(/^row:/, '');
      await ctx.clickTarget({ target: 'row', id });
    } catch {
      // ripristino best-effort: non deve mai far fallire l'azione
    }
  }

  async #waitTray(ctx, timeoutMs = 3500) {
    return waitFor(() => ctx.readTray(), { timeoutMs, sleep: this.sleep });
  }

  /**
   * Risponde al questionario di una chat.
   * @param {{ composerId: string, question: {questions: object[]}, answers: {optionIds: string[], freeform?: string}[] }} p
   *   `answers` e' allineato a `question.questions`; `freeform` non vuoto = voce "Other..." con quel testo.
   */
  async answer({ composerId, question, answers }) {
    const qs = question.questions;
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        let view = await this.#waitTray(ctx);
        if (!view) throw new UiError('no_tray', 'questionario non visibile');
        if (!qs.some((q) => promptMatches(view.text, q.prompt))) throw new UiError('mismatch', 'il questionario mostrato non e\' quello atteso');

        const done = new Array(qs.length).fill(false);
        for (let guard = 0; guard < qs.length * 4 + 6; guard++) {
          view = view ?? (await ctx.readTray());
          if (!view) {
            if (done.every(Boolean)) return { submitted: true };
            throw new UiError('tray_closed', 'il questionario e\' stato chiuso prima di completarlo');
          }
          const qi = currentQuestionIndex(view, qs);
          if (qi < 0) throw new UiError('mismatch', 'domanda mostrata non riconosciuta');

          if (!done[qi]) {
            await this.#applyAnswer(ctx, qs[qi], answers[qi]);
            done[qi] = true;
            await this.sleep(250); // lascia aggiornare l'interfaccia (avanzamento automatico, stato del pulsante)
            view = null;
            continue;
          }

          // La domanda corrente e' a posto ma siamo ancora qui: si preme il pulsante primario ("Next" o "Continue").
          const enabled = await waitFor(
            async () => {
              const v = await ctx.readTray();
              return v === null ? 'gone' : v.primary && !v.primary.disabled ? v : null;
            },
            { timeoutMs: 2500, sleep: this.sleep },
          );
          if (enabled === 'gone') {
            view = null;
            continue;
          }
          if (!enabled) throw new UiError('primary_disabled', 'pulsante di avanzamento non disponibile');
          await ctx.clickTarget({ target: 'primary' });
          await this.sleep(400);
          view = null;
        }
        throw new UiError('tray_still_open', 'il questionario e\' ancora aperto');
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }

  async #applyAnswer(ctx, q, ans) {
    const free = typeof ans.freeform === 'string' ? ans.freeform : '';
    const wantFree = free.trim().length > 0;
    const wanted = new Set(ans.optionIds.filter((id) => id !== FREEFORM_ID).map((id) => q.options.findIndex((o) => o.id === id)));
    if ([...wanted].some((i) => i < 0)) throw new UiError('bad_answer', 'opzione sconosciuta');

    const regular = async () => {
      const v = await ctx.readTray();
      if (!v) throw new UiError('tray_closed', 'questionario chiuso');
      return v;
    };
    const clickOption = async (i) => {
      await ctx.clickTarget({ target: 'option', index: i });
      await this.sleep(150);
    };

    if (!q.allowMultiple) {
      if (wantFree) {
        // Scelta singola con testo libero: prima si toglie un'opzione eventualmente selezionata (un clic su quella
        // gia' selezionata la deseleziona), poi si sceglie "Other...".
        const v = await regular();
        const sel = v.options.findIndex((o) => o.selected);
        if (sel >= 0) await clickOption(sel);
      } else {
        const i = [...wanted][0];
        const v = await regular();
        const dom = v.options[i];
        if (!dom) throw new UiError('mismatch', 'opzione non presente nel questionario');
        if (!dom.selected) await clickOption(i); // se e' gia' selezionata NON si clicca: la deselezionerebbe
        return;
      }
    } else {
      for (let i = 0; i < q.options.length; i++) {
        const v = await regular();
        const dom = v.options[i];
        if (!dom) throw new UiError('mismatch', 'opzione non presente nel questionario');
        if (dom.selected !== wanted.has(i)) await clickOption(i);
      }
    }

    // Voce "Other..." con il campo libero.
    const v = await regular();
    if (wantFree) {
      if (!v.freeform.present) throw new UiError('mismatch', 'campo libero non presente');
      if (!v.freeform.selected || !v.freeform.editorVisible) {
        await ctx.clickTarget({ target: 'freeform' });
        await waitFor(async () => (await regular()).freeform.editorVisible, { timeoutMs: 1500, sleep: this.sleep });
      }
      await ctx.clickTarget({ target: 'freeformEditor' });
      const focus = await ctx.focusState('freeformEditor');
      if (!focus.found || !focus.focused) throw new UiError('focus_failed', 'campo libero senza focus');
      if (focus.text && norm(focus.text) !== norm(free)) {
        // c'e' gia' una bozza diversa nel campo: la si sostituisce (Cmd+A poi si riscrive)
        await ctx.s.pressKey({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }, { modifiers: MODIFIER.meta });
      }
      if (norm(focus.text) !== norm(free)) await ctx.typeText(free);
      const typed = await waitFor(async () => norm((await ctx.focusState('freeformEditor')).text) === norm(free), { timeoutMs: 2000, sleep: this.sleep });
      if (!typed) throw new UiError('type_failed', 'testo non inserito nel campo libero');
    } else if (v.freeform.present && v.freeform.selected && q.allowMultiple) {
      await ctx.clickTarget({ target: 'freeform' }); // multipla: si toglie "Other..." se non richiesta
    }
  }

  /** Salta il questionario (pulsante "Skip" di Cursor). */
  async skip({ composerId, question }) {
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        const view = await this.#waitTray(ctx);
        if (!view) throw new UiError('no_tray', 'questionario non visibile');
        if (!question.questions.some((q) => promptMatches(view.text, q.prompt))) throw new UiError('mismatch', 'il questionario mostrato non e\' quello atteso');
        if (!view.secondary) throw new UiError('not_found', 'pulsante Salta non trovato');
        await ctx.clickTarget({ target: 'secondary' });
        const gone = await waitFor(async () => (await ctx.readTray()) === null, { timeoutMs: 4000, sleep: this.sleep });
        if (!gone) throw new UiError('tray_still_open', 'il questionario e\' ancora aperto');
        return { skipped: true };
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }

  /**
   * Approva ("Run") o rifiuta ("Skip") il comando in attesa. Si agisce solo sulla carta il cui `data-message-id` e'
   * il bubble che il daemon ha letto dal database: se non c'e' o non ha i due pulsanti, nessun clic.
   * @param {{ composerId: string, bubbleId: string, decision: 'approve' | 'reject' }} p
   */
  async approval({ composerId, bubbleId, decision }) {
    if (decision !== 'approve' && decision !== 'reject') throw new UiError('bad_decision', 'decisione non valida');
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        const state = await waitFor(
          async () => {
            const st = await ctx.page({ op: 'approvalState', messageId: bubbleId });
            return st.found && st.approve && st.reject ? st : null;
          },
          { timeoutMs: 4000, sleep: this.sleep },
        );
        if (!state) throw new UiError('no_approval', 'richiesta di approvazione non visibile in Cursor');
        await ctx.clickTarget({ target: decision, messageId: bubbleId });
        // La carta perde i pulsanti appena la decisione e' registrata.
        const gone = await waitFor(
          async () => {
            const st = await ctx.page({ op: 'approvalState', messageId: bubbleId });
            return !st.found || !st.approve ? true : null;
          },
          { timeoutMs: 4000, sleep: this.sleep },
        );
        return { clicked: true, settled: Boolean(gone) };
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }

  /**
   * Ferma l'agente della chat: clic su "Stop generation" nel pannello della chat. Il pulsante sparisce (torna "Send" o
   * "voice") quando Cursor ha fermato la generazione.
   * @returns {Promise<{ clicked: boolean, settled: boolean }>}
   */
  async stop({ composerId }) {
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        const info = await waitFor(
          async () => {
            const i = await ctx.page({ op: 'composerInfo' });
            return i.stop ? i : null;
          },
          { timeoutMs: 3000, sleep: this.sleep },
        );
        if (!info) throw new UiError('not_running', 'la chat non sta lavorando in Cursor');
        await ctx.clickTarget({ target: 'stop' });
        const gone = await waitFor(
          async () => {
            const i = await ctx.page({ op: 'composerInfo' });
            return !i.stop ? true : null;
          },
          { timeoutMs: 6000, sleep: this.sleep },
        );
        return { clicked: true, settled: Boolean(gone) };
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }


  /** Tasto destro sulla riga e clic sulla voce `label` del menu (regex). */
  async #rowMenu(ctx, composerId, label) {
    const loc = await ctx.locate({ target: 'row', id: composerId });
    if (!loc.found) throw new UiError('row_not_found', 'chat non trovata nella sidebar di Cursor');
    await ctx.rightClick({ target: 'row', id: composerId });
    const item = await waitFor(async () => {
      const l = await ctx.locate({ target: 'menuitem', label });
      return l.found ? l : null;
    }, { timeoutMs: 2500, sleep: this.sleep });
    if (!item) {
      await ctx.s.pressKey(KEYS.escape).catch(() => {});
      throw new UiError('no_menu_item', 'voce di menu non trovata in Cursor');
    }
    await ctx.clickTarget({ target: 'menuitem', label });
  }

  /** Rinomina una chat dalla sidebar (menu "Rename", scrittura in linea, Invio). */
  async rename({ composerId, name }) {
    if (typeof name !== 'string' || !name.trim()) throw new UiError('bad_name', 'nome non valido');
    return this.withSession(async (ctx) => {
      await this.#rowMenu(ctx, composerId, MENU.rename);
      const editing = await waitFor(async () => {
        const st = await ctx.page({ op: 'renameState' });
        return st.editing ? st : null;
      }, { timeoutMs: 2500, sleep: this.sleep });
      if (!editing) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('no_rename_field', 'campo del nome non apparso');
      }
      // Il campo deve avere il focus (e il testo selezionato), altrimenti quello che si scrive va perso: se serve lo si forza.
      const focused = await waitFor(async () => {
        const st = await ctx.page({ op: 'renameState' });
        if (st.focused) return st;
        const f = await ctx.page({ op: 'focusRename' });
        return f.focused ? f : null;
      }, { timeoutMs: 2000, sleep: this.sleep });
      if (!focused) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('no_rename_field', 'campo del nome senza focus');
      }
      // Il testo e' gia' selezionato all'apertura: scrivere lo sostituisce. Si controlla prima di confermare.
      await ctx.typeText(name);
      const typed = await waitFor(async () => {
        const st = await ctx.page({ op: 'renameState' });
        return st.editing && norm(st.value) === norm(name) ? st : null;
      }, { timeoutMs: 2500, sleep: this.sleep });
      if (!typed) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('type_failed', 'nome non inserito');
      }
      await ctx.s.pressKey(KEYS.enter);
      const done = await waitFor(async () => (!(await ctx.page({ op: 'renameState' })).editing ? true : null), { timeoutMs: 3000, sleep: this.sleep });
      if (!done) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('rename_failed', 'rinomina non confermata');
      }
      return { clicked: true };
    });
  }

  /** Archivia una chat (menu della riga, voce "Archive"). */
  async archive({ composerId }) {
    return this.withSession(async (ctx) => {
      await this.#rowMenu(ctx, composerId, MENU.archive);
      return { clicked: true };
    });
  }

  /**
   * Ripristina una chat archiviata: accende per un attimo il filtro "Archived" della sidebar (le righe archiviate non ci sono
   * altrimenti), usa "Unarchive" dal menu della riga e rimette SEMPRE il filtro com'era.
   */
  async unarchive({ composerId }) {
    return this.withSession(async (ctx) => {
      const filterIs = async () => {
        await ctx.clickTarget({ target: 'customize' });
        const st = await waitFor(async () => {
          const x = await ctx.page({ op: 'menuState', label: MENU.archivedFilter });
          return x.checked !== null ? x : null;
        }, { timeoutMs: 2500, sleep: this.sleep });
        if (!st) {
          await ctx.s.pressKey(KEYS.escape).catch(() => {});
          throw new UiError('no_menu_item', 'filtro delle archiviate non trovato in Cursor');
        }
        return st.checked === 'true';
      };
      const toggle = async () => {
        await ctx.clickTarget({ target: 'menuitem', label: MENU.archivedFilter });
        await this.sleep(300);
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        await this.sleep(300);
      };
      const wasOn = await filterIs();
      if (!wasOn) await toggle();
      else {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        await this.sleep(200);
      }
      try {
        const shown = await waitFor(async () => ((await ctx.locate({ target: 'row', id: composerId })).found ? true : null), { timeoutMs: 3500, sleep: this.sleep });
        if (!shown) throw new UiError('row_not_found', 'chat archiviata non trovata nella sidebar di Cursor');
        await this.#rowMenu(ctx, composerId, MENU.unarchive);
        await this.sleep(400);
        return { clicked: true };
      } finally {
        if (!wasOn) {
          try {
            if (await filterIs()) await toggle();
            else await ctx.s.pressKey(KEYS.escape).catch(() => {});
          } catch {
            // ripristino del filtro best-effort: un errore qui non deve nascondere l'esito
          }
        }
      }
    });
  }

  /** Scrive un messaggio nel composer della chat e lo invia (come Invio in Cursor). */
  async sendMessage({ composerId, text }) {
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        const info = await waitFor(async () => {
          const i = await ctx.page({ op: 'composerInfo' });
          return i.composer ? i : null;
        }, { timeoutMs: 3500, sleep: this.sleep });
        if (!info) throw new UiError('no_composer', 'campo di scrittura non trovato');
        if (info.tray) throw new UiError('question_pending', 'la chat ha una domanda in attesa');
        // Non si mescola mai il messaggio con una bozza scritta dall'utente sul Mac.
        if (!info.composer.empty) throw new UiError('draft_not_empty', 'nel campo di scrittura c\'e\' gia\' una bozza');

        await ctx.clickTarget({ target: 'composer' });
        const focus = await ctx.focusState('composer');
        if (!focus.found || !focus.focused) throw new UiError('focus_failed', 'campo di scrittura senza focus');
        await ctx.typeText(text);
        const typed = await waitFor(async () => {
          const f = await ctx.focusState('composer');
          return f.found && norm(f.text).startsWith(norm(text).slice(0, 40)) ? f : null;
        }, { timeoutMs: 3000, sleep: this.sleep });
        if (!typed) throw new UiError('type_failed', 'testo non inserito nel campo di scrittura');

        const enabled = await waitFor(async () => {
          const i = await ctx.page({ op: 'composerInfo' });
          return i.send && !i.send.disabled ? i : null;
        }, { timeoutMs: 3000, sleep: this.sleep });
        if (!enabled) throw new UiError('send_disabled', 'pulsante di invio non disponibile');
        await ctx.clickTarget({ target: 'send' });

        // Invio avvenuto = il campo si svuota.
        const cleared = await waitFor(async () => {
          const f = await ctx.focusState('composer');
          return !f.found || f.empty ? true : null;
        }, { timeoutMs: 5000, sleep: this.sleep });
        if (!cleared) throw new UiError('send_failed', 'il messaggio non risulta inviato');
        return { sent: true };
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }
}
