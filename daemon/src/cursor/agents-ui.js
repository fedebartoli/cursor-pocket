// Agents Window UI actions in Cursor via CDP (Phase 2): open a chat, answer the `ask_question` questionnaire,
// skip it, send a message.
//
// THIS is the only file that knows Cursor's page structure: selectors in `SEL`, in-page scripts in `pageKit`/`pageDo`.
// If a Cursor update breaks them, fix here (see FINDINGS sec. 10).
//
// Selector sources: Cursor 3.24 bundle `out/vs/workbench/workbench.glass.main.js` (read-only, never modified):
//  - questionnaire: component `kVC` (class `glass-questionnaire-tray`), options `ui-tray-option`, freeform field
//    `questionnaire-freeform-option` ("Other..."), footer with primary action ("Next"/"Continue") and "Skip";
//  - clicking an option on a SINGLE-choice question that is already selected DESELECTS it (function `Weg`); with single
//    choice, selecting an option advances to the next step on its own (`Jnl`); final submit is always the primary button;
//  - composer: Lexical editor `aislash-editor-input` and button with aria-label "Send message";
//  - sidebar: rows with attribute `data-sidebar-item-key` (shape `row:<id>`).
// Anything not yet verified on a real instance is marked [TO VERIFY] and covered by diagnostics (`inspect`).
//
// Safety rules: no chat content in logs or errors; page scripts write nothing except via input events (click, text, keys)
// identical to a user's.
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
  // Real Cursor 3.24: tiptap/ProseMirror editor; Lexical selectors remain for older versions.
  composer: '.ui-prompt-input-editor__input[contenteditable="true"], .aislash-editor-input[contenteditable="true"], [data-lexical-editor="true"][contenteditable="true"]',
  composerReadonly: '.aislash-editor-input-readonly, .ui-prompt-input-tiptap-readonly',
  // Cursor keeps multiple chat panels alive: each has `data-glass-agent-id` = composerId; off-screen ones carry
  // `data-keep-alive-hidden`. Composer, tray, and send are searched ONLY in the foreground panel.
  panel: '[data-agent-panel-conversation-shell]',
  panelAgentAttr: 'data-glass-agent-id',
  panelHidden: '[data-keep-alive-hidden]',
  send: 'button[aria-label="Send message"]',
  // While the agent runs and the field is empty, the send button becomes "Stop generation".
  stop: 'button[aria-label="Stop generation"]',
  // Terminal command approval (Cursor 3.24): card `.ui-shell-tool-call` sits inside the transcript row, which carries
  // `data-message-id` = bubble id from the database. At the bottom: "Skip" and "Run" (plus the options menu and auto-run
  // mode button, which we do NOT touch).
  shellCard: '.ui-shell-tool-call',
  // Row context menu (right-click) and inline rename: `role=menuitem` entries; the name field is a `ui-text-editable`
  // input inside the row, with text already selected.
  menuItem: '[role="menuitem"],[role="menuitemcheckbox"]',
  renameInput: 'input.ui-text-editable',
  customize: 'button[aria-label="Customize Sidebar"]',
  // Sidebar toggle: while hidden the rows stay in the DOM but have no size.
  showSidebar: 'button[aria-label="Show Sidebar"]',
  hideSidebar: 'button[aria-label="Hide Sidebar"]',
  // Composer attachments: file input (accepts image/*) is in the composer bar; each image preview has its own
  // "Remove image" button. Search only in the foreground panel.
  fileInput: 'input[type="file"]',
  imagePreview: '.ui-prompt-input-image-preview',
  imageRemove: '.ui-prompt-input-image-preview button[aria-label="Remove image"]',
  fileMark: 'data-cp-file-target',
  // Sidebar group (project) header: contains "New Agent" to open a new chat already on that project.
  sectionHead: '[data-section-head]',
  newAgent: 'button[aria-label="New Agent"]',
  selectTrigger: '.ui-select-trigger',
  // Branch menu (searchable list): each row has the name in data-branch-name and aria-selected.
  branchOption: '[role="option"][data-component="search-menu-row"]',
  branchName: '[data-branch-name]',
  messageIdAttr: 'data-message-id',
});

// Labels for the card's two buttons (English; Italian for localized UIs). "Run Everything (...)" is the auto-run mode
// selector: the pattern is anchored on purpose so we do NOT match it.
const APPROVE_LABEL = '^(run|esegui)\\s*(\\u23ce|\\u21b5|enter)?$';
const REJECT_LABEL = '^(skip|salta)$';
// Model menu entries that are NOT models.
const NOT_A_MODEL = /^(context|effort|model|max mode|add models)\b/i;
const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Row menu entries (English; Italian for localized UIs).
const MENU = Object.freeze({
  rename: '^(rename|rinomina)$',
  pin: '^(pin|fissa)$',
  unpin: '^(unpin|rimuovi.*fissat.*|togli.*fissat.*)$',
  archive: '^(archive|archivia)$',
  unarchive: '^(unarchive|restore|ripristina|dearchivia)$',
  modelSub: '^model\\b',
  archivedFilter: '^(archived|archiviat[eio])$',
});

// ---------------------------------------------------------------------------------------------------------------
// Code run IN Cursor's page. Both functions are self-contained (no module variables): sent as text via
// Function.prototype.toString.
// ---------------------------------------------------------------------------------------------------------------

/* eslint-disable no-undef */
function pageKit(SEL, APPROVE_LABEL, REJECT_LABEL) {
  const K = { SEL };
  // On real Cursor 3.24 the questionnaire's `innerText` is EMPTY even when visible (verified live): fall back to
  // `textContent`.
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
  K.sidebarButton = (sel) => [...document.querySelectorAll(sel)].find(K.visible) || null;
  K.customize = () => [...document.querySelectorAll(SEL.customize)].find(K.visible) || null;
  K.stop = () => [...K.scope().querySelectorAll(SEL.stop)].find(K.visible) || null;
  K.sectionHeads = (name) => [...document.querySelectorAll(SEL.sectionHead)].filter((e) => K.text(e).trim() === name);
  K.newAgent = (name) => {
    const heads = K.sectionHeads(name);
    return heads.length === 1 ? heads[0].querySelector(SEL.newAgent) : null;
  };
  K.selectTriggers = () => [...document.querySelectorAll(SEL.selectTrigger)].filter(K.visible);
  // The model button is in the composer bar: the only one with text and no aria-label.
  K.modelButton = () => {
    const c = K.composer();
    let root = c;
    for (let i = 0; i < 8 && root; i++) {
      root = root.parentElement;
      if (root && root.querySelectorAll('button').length >= 3) break;
    }
    if (!root) return null;
    return [...root.querySelectorAll('button')].find((b) => !b.getAttribute('aria-label') && K.text(b) && !b.matches(SEL.selectTrigger) && K.visible(b)) || null;
  };
  K.branchOptions = () => [...document.querySelectorAll(SEL.branchOption)].filter(K.visible);
  K.branchOptionName = (o) => {
    const n = o.querySelector(SEL.branchName);
    return n ? n.getAttribute('data-branch-name') || K.text(n) : K.text(o);
  };
  K.fileInput = () => K.scope().querySelector(SEL.fileInput);
  K.previews = () => [...K.scope().querySelectorAll(SEL.imagePreview + ' img')];
  K.imageRemove = () => [...K.scope().querySelectorAll(SEL.imageRemove)].find(K.visible) || null;
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
        // Click the label (not the center: when expanded the editor is in the center and does not toggle selection).
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
      case 'showSidebar':
        return K.sidebarButton(SEL.showSidebar);
      case 'hideSidebar':
        return K.sidebarButton(SEL.hideSidebar);
      case 'removeImage':
        return K.imageRemove();
      case 'newAgent':
        return K.newAgent(a.name);
      case 'branchTrigger':
        return K.selectTriggers()[1] || null;
      case 'branchOption':
        return K.branchOptions().find((o) => K.branchOptionName(o) === a.name) || null;
      case 'modelButton':
        return K.modelButton();
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
      // No selected-row marker in Cursor 3.24: the open chat is inferred from the foreground panel.
      const agent = K.panelAgent();
      return agent ? `row:${agent}` : null;
    }
    case 'sidebarState': {
      const rows = K.rows();
      return { rows: rows.length, visible: rows.filter(K.visible).length, canShow: !!K.sidebarButton(SEL.showSidebar) };
    }
    case 'composerInfo': {
      const c = K.composer();
      const s = K.send();
      return {
        panel: K.panelAgent(),
        composer: c ? { text: K.editorText(c), empty: K.editorText(c) === '' } : null,
        send: s ? { disabled: K.isDisabled(s) } : null,
        stop: !!K.stop(),
        tray: !!K.tray(),
        images: K.previews().length,
      };
    }
    case 'sectionCount':
      return K.sectionHeads(a.name).length;
    case 'pinState': {
      // Pinned chats sit at the top of the sidebar, BEFORE the first project header.
      const row = K.findRow(a.id);
      if (!row) return { found: false, pinned: false };
      const head = document.querySelector(SEL.sectionHead);
      return { found: true, pinned: !!head && !!(row.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING) };
    }
    case 'rowKeys':
      return K.rows().map((r) => K.rowKey(r));
    case 'newChatState': {
      // "New chat" screen: no conversation panel, three selectors (project, branch, environment) and the composer.
      const triggers = [...document.querySelectorAll(SEL.selectTrigger)].filter(K.visible).map((e) => K.text(e).trim());
      return { composer: !!K.composer(), triggers };
    }
    case 'overlayOpen':
      return [...document.querySelectorAll('[role="menu"],[role="listbox"]')].some((e) => K.visible(e) && !e.closest(SEL.sidebarRow));
    case 'branchState': {
      const t = K.selectTriggers()[1];
      return { current: t ? K.text(t) : null, options: K.branchOptions().map((o) => ({ name: K.branchOptionName(o), selected: o.getAttribute('aria-selected') === 'true' })) };
    }
    case 'modelState': {
      const b = K.modelButton();
      return { current: b ? K.text(b) : null, items: K.menuItems().map((m) => K.text(m)) };
    }
    case 'attachState':
      return { input: !!K.fileInput(), previews: K.previews().length };
    case 'markFileInput': {
      const i = K.fileInput();
      if (!i) return false;
      i.setAttribute(SEL.fileMark, '1');
      return true;
    }
    case 'unmarkFileInput':
      for (const e of document.querySelectorAll('[' + SEL.fileMark + ']')) e.removeAttribute(SEL.fileMark);
      return true;
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
      // Structure only: attribute and class names, never text content.
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
      throw new Error(`unknown operation: ${a.op}`);
  }
}
/* eslint-enable no-undef */

function expressionFor(args) {
  return `(${pageDo.toString()})(${JSON.stringify(args)}, (${pageKit.toString()})(${JSON.stringify(SEL)}, ${JSON.stringify(APPROVE_LABEL)}, ${JSON.stringify(REJECT_LABEL)}))`;
}

// ---------------------------------------------------------------------------------------------------------------
// Node side: high-level operations
// ---------------------------------------------------------------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s) => (String(s ?? '').toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]{4,}/gu) || []).slice(0, 14);

/** Does visible questionnaire text contain this question? (prompt is Markdown: compare tolerantly) */
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

/** Index of the question currently shown in the tray (-1 if none or ambiguous). */
export function currentQuestionIndex(view, questions) {
  const hits = [];
  questions.forEach((q, i) => {
    if (promptMatches(view.text, q.prompt)) hits.push(i);
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // multiple similar prompts: pick whoever has more option labels present in visible text
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

/** CDP session context: convenient wrappers for page scripts. */
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

  /** Real click on the element (falls back to element.click() if covered or zero-sized). */
  async clickTarget(args) {
    const loc = await this.locate(args);
    if (!loc.found) throw new UiError('not_found', `element not found: ${args.target}`);
    if (loc.disabled) throw new UiError('disabled', `element disabled: ${args.target}`);
    if (loc.covered || loc.w < 2 || loc.h < 2) {
      if (await this.page({ op: 'jsclick', ...args })) return;
      throw new UiError('click_failed', `click failed: ${args.target}`);
    }
    await this.s.click(loc.x, loc.y);
  }

  /** Move the mouse over the element (row buttons appear only on hover). */
  async hover(args) {
    const loc = await this.locate(args);
    if (!loc.found) throw new UiError('not_found', `element not found: ${args.target}`);
    await this.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
    await realSleep(200);
  }

  /** Right-click at the element center (context menu). */
  async rightClick(args) {
    const loc = await this.locate(args);
    if (!loc.found) throw new UiError('not_found', `element not found: ${args.target}`);
    const base = { x: loc.x, y: loc.y, button: 'right', clickCount: 1 };
    await this.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
    await this.s.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 2 });
    await this.s.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }

  /** Attach local files to the foreground composer file input (as if chosen from the file picker). */
  async setFiles(files) {
    if (!(await this.page({ op: 'markFileInput' }))) throw new UiError('no_file_input', 'attachment field not found');
    try {
      const { root } = await this.s.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await this.s.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[${'data-cp-file-target'}]` });
      if (!nodeId) throw new UiError('no_file_input', 'attachment field not found');
      await this.s.send('DOM.setFileInputFiles', { files, nodeId });
    } finally {
      await this.page({ op: 'unmarkFileInput' }).catch(() => {});
    }
  }

  /** Remove all attached images from the composer ("Remove image" buttons). */
  async clearImages() {
    for (let i = 0; i < 12; i++) {
      const loc = await this.locate({ target: 'removeImage' });
      if (!loc.found) return;
      await this.clickTarget({ target: 'removeImage' }).catch(() => {});
      await realSleep(250);
    }
  }

  /**
   * If Cursor's sidebar is hidden (rows exist but have no size), show it so rows can be found and clicked.
   * `restoreSidebar()` hides it again at the end of the session, leaving the Mac as it was.
   */
  async ensureSidebar() {
    const st = await this.page({ op: 'sidebarState' });
    if (st.visible > 0 || !st.canShow) return false;
    await this.clickTarget({ target: 'showSidebar' });
    const shown = await waitFor(async () => ((await this.page({ op: 'sidebarState' })).visible > 0 ? true : null), { timeoutMs: 2500, sleep: this.sleep });
    if (!shown) return false;
    this.sidebarOpenedByUs = true;
    // Let the sidebar finish its animation before clicking rows: wait until the number of visible rows stops changing.
    let last = -1;
    await waitFor(async () => {
      const n = (await this.page({ op: 'sidebarState' })).visible;
      const stable = n === last;
      last = n;
      return stable ? true : null;
    }, { timeoutMs: 1500, intervalMs: 150, sleep: this.sleep });
    return true;
  }

  async restoreSidebar() {
    if (!this.sidebarOpenedByUs) return;
    this.sidebarOpenedByUs = false;
    try {
      await this.clickTarget({ target: 'hideSidebar' });
    } catch {
      // best-effort: must never fail the action
    }
  }

  /** Type text with focus already on the element; `\n` becomes Shift+Enter (newline without sending). */
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
  // composerId -> normalized text this daemon typed in that chat's composer and has not seen sent. Memory only.
  #typed = new Map();

  /**
   * @param {{ port: number, restoreSelection?: boolean, sleep?: Function, WebSocketImpl?: Function }} opts
   */
  constructor({ port, restoreSelection = true, sleep = realSleep, WebSocketImpl } = {}) {
    this.port = port;
    this.restoreSelection = restoreSelection;
    this.sleep = sleep;
    this.WebSocketImpl = WebSocketImpl;
  }

  /** Lightweight state (HTTP only): does the port respond? */
  probe() {
    return probeCdp(this.port);
  }

  /** Is the Agents window reachable? HTTP only, never throws. */
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
    if (!t) throw new UiError('no_window', 'Agents window not found');
    return t;
  }

  /** Open a session on the Agents window, run `fn(ctx)`, always close. */
  async withSession(fn) {
    const target = await this.#target();
    const session = await CdpSession.open(target.wsUrl, { WebSocketImpl: this.WebSocketImpl });
    try {
      // Page behaves as if focused even when Cursor is in the background (this session only).
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      const ctx = new Ctx(session, { sleep: this.sleep });
      try {
        return await fn(ctx);
      } finally {
        await ctx.restoreSidebar();
      }
    } finally {
      session.close();
    }
  }

  /** Diagnostics for `npm run cdp -- inspect`: port, windows, and page STRUCTURE (never text). */
  async inspect() {
    const p = await this.probe();
    if (!p.up) return { up: false };
    const targets = await listPageTargets(this.port).catch(() => []);
    const out = { up: true, browser: p.browser, targets: targets.map((t) => ({ title: t.title, url: t.url.replace(/^(.{0,140}).*$/, '$1') })) };
    try {
      out.page = await this.withSession((ctx) => ctx.page({ op: 'outline' }));
    } catch (err) {
      out.pageError = err.code || 'error';
    }
    return out;
  }

  /** Visible questionnaire state (or null). */
  readTray() {
    return this.withSession((ctx) => ctx.readTray());
  }

  async #openChat(ctx, composerId) {
    await ctx.ensureSidebar();
    const previous = await ctx.page({ op: 'selectedKey' }).catch(() => null);
    const loc = await ctx.locate({ target: 'row', id: composerId });
    if (!loc.found) throw new UiError('row_not_found', 'chat not found in Cursor sidebar');
    if (previous && previous === loc.key) return previous; // already open: nothing to do
    // Never go on with the wrong chat open: a message typed there would end up in a different conversation.
    for (let attempt = 0; attempt < 2; attempt++) {
      await ctx.clickTarget({ target: 'row', id: composerId });
      const selected = await waitFor(async () => (await ctx.page({ op: 'selectedKey' }).catch(() => null)) === loc.key, { timeoutMs: 1500, sleep: this.sleep });
      if (selected) return previous;
    }
    throw new UiError('chat_not_open', 'Cursor did not open the chat');
  }

  async #restore(ctx, previous, composerId) {
    if (!this.restoreSelection || !previous || previous === `row:${composerId}`) return;
    try {
      const loc = await ctx.locate({ target: 'selectedRow' });
      if (loc.found && loc.key === previous) return;
      const id = previous.replace(/^row:/, '');
      await ctx.clickTarget({ target: 'row', id });
    } catch {
      // best-effort restore: must never fail the action
    }
  }

  async #waitTray(ctx, timeoutMs = 3500) {
    return waitFor(() => ctx.readTray(), { timeoutMs, sleep: this.sleep });
  }

  /**
   * Answer a chat questionnaire.
   * @param {{ composerId: string, question: {questions: object[]}, answers: {optionIds: string[], freeform?: string}[] }} p
   *   `answers` aligns with `question.questions`; non-empty `freeform` = "Other..." entry with that text.
   */
  async answer({ composerId, question, answers }) {
    const qs = question.questions;
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        let view = await this.#waitTray(ctx);
        if (!view) throw new UiError('no_tray', 'questionnaire not visible');
        if (!qs.some((q) => promptMatches(view.text, q.prompt))) throw new UiError('mismatch', 'questionnaire on screen is not the expected one');

        const done = new Array(qs.length).fill(false);
        for (let guard = 0; guard < qs.length * 4 + 6; guard++) {
          view = view ?? (await ctx.readTray());
          if (!view) {
            if (done.every(Boolean)) return { submitted: true };
            throw new UiError('tray_closed', 'questionnaire closed before completion');
          }
          const qi = currentQuestionIndex(view, qs);
          if (qi < 0) throw new UiError('mismatch', 'question on screen not recognized');

          if (!done[qi]) {
            await this.#applyAnswer(ctx, qs[qi], answers[qi]);
            done[qi] = true;
            await this.sleep(250); // let UI update (auto-advance, button state)
            view = null;
            continue;
          }

          // Current question is done but tray still open: press primary ("Next" or "Continue").
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
          if (!enabled) throw new UiError('primary_disabled', 'continue button not available');
          await ctx.clickTarget({ target: 'primary' });
          await this.sleep(400);
          view = null;
        }
        throw new UiError('tray_still_open', 'questionnaire is still open');
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }

  async #applyAnswer(ctx, q, ans) {
    const free = typeof ans.freeform === 'string' ? ans.freeform : '';
    const wantFree = free.trim().length > 0;
    const wanted = new Set(ans.optionIds.filter((id) => id !== FREEFORM_ID).map((id) => q.options.findIndex((o) => o.id === id)));
    if ([...wanted].some((i) => i < 0)) throw new UiError('bad_answer', 'unknown option');

    const regular = async () => {
      const v = await ctx.readTray();
      if (!v) throw new UiError('tray_closed', 'questionnaire closed');
      return v;
    };
    const clickOption = async (i) => {
      await ctx.clickTarget({ target: 'option', index: i });
      await this.sleep(150);
    };

    if (!q.allowMultiple) {
      if (wantFree) {
        // Single choice with freeform: first deselect any selected option (clicking an already selected one
        // deselects it), then choose "Other...".
        const v = await regular();
        const sel = v.options.findIndex((o) => o.selected);
        if (sel >= 0) await clickOption(sel);
      } else {
        const i = [...wanted][0];
        const v = await regular();
        const dom = v.options[i];
        if (!dom) throw new UiError('mismatch', 'option not present in questionnaire');
        if (!dom.selected) await clickOption(i); // if already selected do NOT click: would deselect
        return;
      }
    } else {
      for (let i = 0; i < q.options.length; i++) {
        const v = await regular();
        const dom = v.options[i];
        if (!dom) throw new UiError('mismatch', 'option not present in questionnaire');
        if (dom.selected !== wanted.has(i)) await clickOption(i);
      }
    }

    // "Other..." entry with freeform field.
    const v = await regular();
    if (wantFree) {
      if (!v.freeform.present) throw new UiError('mismatch', 'freeform field not present');
      if (!v.freeform.selected || !v.freeform.editorVisible) {
        await ctx.clickTarget({ target: 'freeform' });
        await waitFor(async () => (await regular()).freeform.editorVisible, { timeoutMs: 1500, sleep: this.sleep });
      }
      await ctx.clickTarget({ target: 'freeformEditor' });
      const focus = await ctx.focusState('freeformEditor');
      if (!focus.found || !focus.focused) throw new UiError('focus_failed', 'freeform field not focused');
      if (focus.text && norm(focus.text) !== norm(free)) {
        // different draft already in the field: replace it (Cmd+A then retype)
        await ctx.s.pressKey({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }, { modifiers: MODIFIER.meta });
      }
      if (norm(focus.text) !== norm(free)) await ctx.typeText(free);
      const typed = await waitFor(async () => norm((await ctx.focusState('freeformEditor')).text) === norm(free), { timeoutMs: 2000, sleep: this.sleep });
      if (!typed) throw new UiError('type_failed', 'text not entered in freeform field');
    } else if (v.freeform.present && v.freeform.selected && q.allowMultiple) {
      await ctx.clickTarget({ target: 'freeform' }); // multiple: turn off "Other..." if not wanted
    }
  }

  /** Skip the questionnaire (Cursor "Skip" button). */
  async skip({ composerId, question }) {
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        const view = await this.#waitTray(ctx);
        if (!view) throw new UiError('no_tray', 'questionnaire not visible');
        if (!question.questions.some((q) => promptMatches(view.text, q.prompt))) throw new UiError('mismatch', 'questionnaire on screen is not the expected one');
        if (!view.secondary) throw new UiError('not_found', 'Skip button not found');
        await ctx.clickTarget({ target: 'secondary' });
        const gone = await waitFor(async () => (await ctx.readTray()) === null, { timeoutMs: 4000, sleep: this.sleep });
        if (!gone) throw new UiError('tray_still_open', 'questionnaire is still open');
        return { skipped: true };
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }

  /**
   * Approve ("Run") or reject ("Skip") the pending command. Only act on the card whose `data-message-id` is the bubble
   * the daemon read from the database: if missing or without both buttons, no click.
   * @param {{ composerId: string, bubbleId: string, decision: 'approve' | 'reject' }} p
   */
  async approval({ composerId, bubbleId, decision }) {
    if (decision !== 'approve' && decision !== 'reject') throw new UiError('bad_decision', 'invalid decision');
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
        if (!state) throw new UiError('no_approval', 'approval request not visible in Cursor');
        await ctx.clickTarget({ target: decision, messageId: bubbleId });
        // Card loses buttons as soon as the decision is recorded.
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
   * Stop the chat agent: click "Stop generation" in the chat panel. Button disappears (back to "Send" or "voice") when
   * Cursor has stopped generation.
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
        if (!info) throw new UiError('not_running', 'chat is not running in Cursor');
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


  /** Right-click the row and click menu entry `label` (regex). */
  async #rowMenu(ctx, composerId, label) {
    await ctx.ensureSidebar();
    const loc = await ctx.locate({ target: 'row', id: composerId });
    if (!loc.found) throw new UiError('row_not_found', 'chat not found in Cursor sidebar');
    await ctx.rightClick({ target: 'row', id: composerId });
    const item = await waitFor(async () => {
      const l = await ctx.locate({ target: 'menuitem', label });
      return l.found ? l : null;
    }, { timeoutMs: 2500, sleep: this.sleep });
    if (!item) {
      await ctx.s.pressKey(KEYS.escape).catch(() => {});
      throw new UiError('no_menu_item', 'menu item not found in Cursor');
    }
    await ctx.clickTarget({ target: 'menuitem', label });
  }

  /** Rename a chat from the sidebar ("Rename" menu, inline edit, Enter). */
  async rename({ composerId, name }) {
    if (typeof name !== 'string' || !name.trim()) throw new UiError('bad_name', 'invalid name');
    return this.withSession(async (ctx) => {
      await this.#rowMenu(ctx, composerId, MENU.rename);
      const editing = await waitFor(async () => {
        const st = await ctx.page({ op: 'renameState' });
        return st.editing ? st : null;
      }, { timeoutMs: 2500, sleep: this.sleep });
      if (!editing) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('no_rename_field', 'name field did not appear');
      }
      // Field must have focus (and selected text) or typing is lost: force focus if needed.
      const focused = await waitFor(async () => {
        const st = await ctx.page({ op: 'renameState' });
        if (st.focused) return st;
        const f = await ctx.page({ op: 'focusRename' });
        return f.focused ? f : null;
      }, { timeoutMs: 2000, sleep: this.sleep });
      if (!focused) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('no_rename_field', 'name field not focused');
      }
      // Text is already selected on open: typing replaces it. Verify before confirming.
      await ctx.typeText(name);
      const typed = await waitFor(async () => {
        const st = await ctx.page({ op: 'renameState' });
        return st.editing && norm(st.value) === norm(name) ? st : null;
      }, { timeoutMs: 2500, sleep: this.sleep });
      if (!typed) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('type_failed', 'name not entered');
      }
      await ctx.s.pressKey(KEYS.enter);
      const done = await waitFor(async () => (!(await ctx.page({ op: 'renameState' })).editing ? true : null), { timeoutMs: 3000, sleep: this.sleep });
      if (!done) {
        await ctx.s.pressKey(KEYS.escape).catch(() => {});
        throw new UiError('rename_failed', 'rename not confirmed');
      }
      return { clicked: true };
    });
  }

  /** Is the chat pinned at the top of the sidebar? (read-only page probe). */
  async pinState({ composerId }) {
    return this.withSession(async (ctx) => {
      // Read-only probe run often from the phone: it never opens the sidebar (would flicker the Mac window).
      const st = await ctx.page({ op: 'pinState', id: composerId });
      if (!st.found) throw new UiError('row_not_found', 'chat not found in Cursor sidebar');
      return { pinned: st.pinned };
    });
  }

  /** Pin or unpin (row menu, "Pin"/"Unpin"). No-op if the chat is already in the requested state. */
  async setPinned({ composerId, pinned }) {
    if (typeof pinned !== 'boolean') throw new UiError('bad_pin', 'invalid value');
    return this.withSession(async (ctx) => {
      await ctx.ensureSidebar();
      const before = await ctx.page({ op: 'pinState', id: composerId });
      if (!before.found) throw new UiError('row_not_found', 'chat not found in Cursor sidebar');
      if (before.pinned === pinned) return { pinned, changed: false };
      // Look ONLY for the desired-state entry: if the menu shows the opposite, click nothing (never flip by mistake).
      await this.#rowMenu(ctx, composerId, pinned ? MENU.pin : MENU.unpin);
      const now = await waitFor(async () => {
        const st = await ctx.page({ op: 'pinState', id: composerId });
        return st.found && st.pinned === pinned ? st : null;
      }, { timeoutMs: 3000, sleep: this.sleep });
      if (!now) throw new UiError('pin_failed', 'Cursor did not change pin state');
      return { pinned, changed: true };
    });
  }

  /** Archive a chat (row menu, "Archive" entry). */
  async archive({ composerId }) {
    return this.withSession(async (ctx) => {
      await this.#rowMenu(ctx, composerId, MENU.archive);
      return { clicked: true };
    });
  }

  /**
   * Restore an archived chat: briefly enable sidebar "Archived" filter (archived rows are hidden otherwise), use row menu
   * "Unarchive", and ALWAYS restore the filter to how it was.
   */
  async unarchive({ composerId }) {
    return this.withSession(async (ctx) => {
      await ctx.ensureSidebar();
      const filterIs = async () => {
        await ctx.clickTarget({ target: 'customize' });
        const st = await waitFor(async () => {
          const x = await ctx.page({ op: 'menuState', label: MENU.archivedFilter });
          return x.checked !== null ? x : null;
        }, { timeoutMs: 2500, sleep: this.sleep });
        if (!st) {
          await ctx.s.pressKey(KEYS.escape).catch(() => {});
          throw new UiError('no_menu_item', 'Archived filter not found in Cursor');
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
        if (!shown) throw new UiError('row_not_found', 'archived chat not found in Cursor sidebar');
        await this.#rowMenu(ctx, composerId, MENU.unarchive);
        await this.sleep(400);
        return { clicked: true };
      } finally {
        if (!wasOn) {
          try {
            if (await filterIs()) await toggle();
            else await ctx.s.pressKey(KEYS.escape).catch(() => {});
          } catch {
            // best-effort filter restore: error here must not hide the outcome
          }
        }
      }
    });
  }

  /** Select everything in the (foreground) composer and delete it. Used only on text that this daemon typed itself. */
  async #clearComposer(ctx) {
    await ctx.clickTarget({ target: 'composer' });
    const f = await ctx.focusState('composer');
    if (!f.found || !f.focused) return false;
    // `commands` makes the editing command run even where the synthesized shortcut would not (e.g. headless).
    await ctx.s.pressKey({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll'] }, { modifiers: MODIFIER.meta });
    await ctx.s.pressKey({ ...KEYS.backspace, commands: ['deleteBackward'] });
    return Boolean(await waitFor(async () => ((await ctx.focusState('composer')).empty ? true : null), { timeoutMs: 1500, sleep: this.sleep }));
  }

  /**
   * After a failed send: if the composer still holds exactly the text WE typed, remove it, so no stray draft is left
   * behind (and the next attempt does not trip over it). Anything else in the field is the user's own: never touched.
   */
  async #discardOwnText(ctx, composerId, text) {
    try {
      const f = await ctx.focusState('composer');
      if (f.found && !f.empty && norm(f.text) === norm(text)) await this.#clearComposer(ctx);
      const after = await ctx.focusState('composer');
      if (!after.found || after.empty) this.#typed.delete(composerId);
    } catch {
      // best-effort: the original error is what the caller needs to see
    }
  }

  /** Type a message in the chat composer and send (like Enter in Cursor). */
  async sendMessage({ composerId, text, files = [] }) {
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        const info = await waitFor(async () => {
          const i = await ctx.page({ op: 'composerInfo' });
          return i.composer ? i : null;
        }, { timeoutMs: 3500, sleep: this.sleep });
        if (!info) throw new UiError('no_composer', 'composer field not found');
        if (info.tray) throw new UiError('question_pending', 'chat has a pending question');
        // The composer on screen must belong to the requested chat: never type into another conversation.
        if (info.panel && info.panel !== composerId) throw new UiError('chat_not_open', 'the open chat is not the requested one');
        // Never mix the message with a draft the user typed on the Mac. A draft that is exactly what this daemon typed
        // earlier (a failed attempt) or the very same text being sent is ours: clear it and carry on.
        let draftText = info.composer.text;
        if (!info.composer.empty) {
          const mine = this.#typed.get(composerId);
          if (info.images === 0 && (norm(draftText) === norm(text) || (mine && norm(draftText) === mine))) {
            if (!(await this.#clearComposer(ctx))) throw new UiError('draft_not_empty', 'the composer already has a draft');
            this.#typed.delete(composerId);
            draftText = '';
          } else {
            throw new UiError('draft_not_empty', 'the composer already has a draft');
          }
        }
        if (info.images > 0) throw new UiError('draft_not_empty', 'the composer already has a draft');

        let attached = false;
        try {
          if (files.length) {
            await this.#attach(ctx, files);
            attached = true;
          }
          if (text) {
            await ctx.clickTarget({ target: 'composer' });
            const focus = await ctx.focusState('composer');
            if (!focus.found || !focus.focused) throw new UiError('focus_failed', 'composer field not focused');
            this.#typed.set(composerId, norm(text));
            await ctx.typeText(text);
            const typed = await waitFor(async () => {
              const f = await ctx.focusState('composer');
              return f.found && norm(f.text).startsWith(norm(text).slice(0, 40)) ? f : null;
            }, { timeoutMs: 3000, sleep: this.sleep });
            if (!typed) throw new UiError('type_failed', 'text not entered in composer');
          }
        } catch (e) {
          if (attached) await ctx.clearImages().catch(() => {});
          if (text) await this.#discardOwnText(ctx, composerId, text);
          throw e;
        }

        const enabled = await waitFor(async () => {
          const i = await ctx.page({ op: 'composerInfo' });
          return i.send && !i.send.disabled ? i : null;
        }, { timeoutMs: 3000, sleep: this.sleep });
        if (!enabled) {
          if (attached) await ctx.clearImages().catch(() => {});
          if (text) await this.#discardOwnText(ctx, composerId, text);
          throw new UiError('send_disabled', 'send button not available');
        }
        await ctx.clickTarget({ target: 'send' });

        // Send succeeded = field clears (and image previews disappear).
        const cleared = await waitFor(async () => {
          const f = await ctx.focusState('composer');
          const i = await ctx.page({ op: 'composerInfo' });
          return (!f.found || f.empty) && !(i.images > 0) ? true : null;
        }, { timeoutMs: 5000, sleep: this.sleep });
        if (!cleared) {
          if (text) await this.#discardOwnText(ctx, composerId, text);
          throw new UiError('send_failed', 'message does not appear sent');
        }
        this.#typed.delete(composerId);
        return { sent: true };
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }

  /** Attach images to the composer and verify previews appear. */
  async #attach(ctx, files) {
    const before = (await ctx.page({ op: 'attachState' })).previews;
    await ctx.setFiles(files);
    const ok = await waitFor(async () => {
      const st = await ctx.page({ op: 'attachState' });
      return st.previews >= before + files.length ? st : null;
    }, { timeoutMs: 6000, sleep: this.sleep });
    if (!ok) {
      await ctx.clearImages().catch(() => {});
      throw new UiError('attach_failed', 'Cursor did not show attached images');
    }
  }

  /** Tests only: attach, count previews, remove all without sending. */
  async attachImages({ composerId, files }) {
    return this.withSession(async (ctx) => {
      const previous = await this.#openChat(ctx, composerId);
      try {
        await this.#attach(ctx, files);
        const n = (await ctx.page({ op: 'attachState' })).previews;
        await ctx.clearImages();
        const left = (await ctx.page({ op: 'attachState' })).previews;
        return { attached: n, left };
      } finally {
        await this.#restore(ctx, previous, composerId);
      }
    });
  }

  async #closeMenus(ctx) {
    for (let i = 0; i < 4; i++) {
      if (!(await ctx.page({ op: 'overlayOpen' }).catch(() => false))) return;
      await ctx.s.pressKey(KEYS.escape).catch(() => {});
      await this.sleep(250);
    }
  }

  /** Open the branch menu and read entries (menu stays open). */
  async #readBranches(ctx) {
    await ctx.clickTarget({ target: 'branchTrigger' });
    const st = await waitFor(async () => {
      const x = await ctx.page({ op: 'branchState' });
      return x.options.length ? x : null;
    }, { timeoutMs: 2500, sleep: this.sleep });
    if (!st) {
      await this.#closeMenus(ctx);
      throw new UiError('no_branch_menu', 'branch menu not found in Cursor');
    }
    return st;
  }

  async #pickBranch(ctx, name) {
    const st = await this.#readBranches(ctx);
    if (!st.options.some((o) => o.name === name)) {
      await this.#closeMenus(ctx);
      throw new UiError('branch_not_found', 'branch not in Cursor list');
    }
    await ctx.clickTarget({ target: 'branchOption', name });
    await this.sleep(300);
    await this.#closeMenus(ctx);
    const now = await waitFor(async () => {
      const x = await ctx.page({ op: 'branchState' });
      return norm(x.current ?? '') === norm(name) ? x : null;
    }, { timeoutMs: 2500, sleep: this.sleep });
    if (!now) throw new UiError('branch_failed', 'Cursor did not change branch');
  }

  /** Open model menu (Context / Effort / Model) and "Model" submenu: return current model and entries (menu stays open). */
  async #readModels(ctx) {
    await ctx.clickTarget({ target: 'modelButton' });
    const first = await waitFor(async () => {
      const m = await ctx.locate({ target: 'menuitem', label: MENU.modelSub });
      return m.found ? m : null;
    }, { timeoutMs: 2500, sleep: this.sleep });
    if (!first) {
      await this.#closeMenus(ctx);
      throw new UiError('no_model_menu', 'model menu not found in Cursor');
    }
    await ctx.hover({ target: 'menuitem', label: MENU.modelSub });
    const st = await waitFor(async () => {
      const x = await ctx.page({ op: 'modelState' });
      const items = x.items.filter((t) => t && !NOT_A_MODEL.test(t));
      return items.length ? { current: x.current, items } : null;
    }, { timeoutMs: 2500, sleep: this.sleep });
    if (!st) {
      await this.#closeMenus(ctx);
      throw new UiError('no_model_menu', 'model list not found in Cursor');
    }
    return st;
  }

  async #pickModel(ctx, label) {
    const st = await this.#readModels(ctx);
    if (!st.items.includes(label)) {
      await this.#closeMenus(ctx);
      throw new UiError('model_not_found', 'model not in Cursor list');
    }
    await ctx.clickTarget({ target: 'menuitem', label: `^${escapeRe(label)}$` });
    await this.sleep(300);
    await this.#closeMenus(ctx);
    const now = await waitFor(async () => {
      const x = await ctx.page({ op: 'modelState' });
      return norm(x.current ?? '') === norm(label) ? x : null;
    }, { timeoutMs: 2500, sleep: this.sleep });
    if (!now) throw new UiError('model_failed', 'Cursor did not change model');
  }

  /**
   * Apply requested branch and/or model on the "new chat" screen (only if different from current).
   * Returns before and after values: Cursor remembers the last choice as default, so callers must restore `before`.
   */
  async #applyChoices(ctx, { branch, model }) {
    const read = async () => ({ branch: (await ctx.page({ op: 'branchState' })).current, model: (await ctx.page({ op: 'modelState' })).current });
    const before = await read();
    if (branch && norm(branch) !== norm(before.branch ?? '')) await this.#pickBranch(ctx, branch);
    if (model && norm(model) !== norm(before.model ?? '')) await this.#pickModel(ctx, model);
    return { before, after: await read() };
  }

  /**
   * Read current branch and model from Cursor and new-chat choices for the project. READ-ONLY: opens menus and closes them
   * without selecting, then reopens the previously selected chat.
   */
  async newChatOptions({ project }) {
    if (typeof project !== 'string' || !project.trim()) throw new UiError('bad_project', 'invalid project');
    return this.withSession(async (ctx) => {
      const st = {};
      try {
        await this.#openNewChat(ctx, project, st);
        const b = await this.#readBranches(ctx);
        await this.#closeMenus(ctx);
        const m = await this.#readModels(ctx);
        await this.#closeMenus(ctx);
        await this.#restore(ctx, st.previous, '');
        return { branch: { current: b.current, options: b.options.map((o) => o.name) }, model: { current: m.current, options: m.items } };
      } catch (e) {
        await this.#closeMenus(ctx).catch(() => {});
        await this.#restore(ctx, st.previous, '').catch(() => {});
        throw e;
      }
    });
  }

  /**
   * Open the project's "new chat" screen (group "New Agent" button) and verify project, local environment, and empty draft.
   * `st` receives prior selection and row keys: caller restores them on error.
   */
  async #openNewChat(ctx, project, st) {
      await ctx.ensureSidebar();
      st.previous = await ctx.page({ op: 'selectedKey' }).catch(() => null);
      st.before = new Set(await ctx.page({ op: 'rowKeys' }));
      const count = await ctx.page({ op: 'sectionCount', name: project });
      if (count === 0) throw new UiError('project_not_found', 'project not found in Cursor sidebar');
      if (count > 1) throw new UiError('project_ambiguous', 'multiple projects with the same name in sidebar');
      await ctx.hover({ target: 'newAgent', name: project });
      await ctx.clickTarget({ target: 'newAgent', name: project });
    // Wait until the screen really shows the requested project (if a "new chat" screen was already open, the composer is
    // already there and the project changes only after the click).
    let last = null;
    const screen = await waitFor(async () => {
      const st = await ctx.page({ op: 'newChatState' });
      last = st;
      return st.composer && st.triggers.length >= 3 && norm(st.triggers[0]) === norm(project) ? st : null;
    }, { timeoutMs: 4000, sleep: this.sleep });
    if (!screen) {
      if (last?.composer && last.triggers.length >= 3) throw new UiError('wrong_project', 'Cursor selected a different project');
      throw new UiError('no_new_chat', 'new chat screen did not appear');
    }
    if (norm(screen.triggers[screen.triggers.length - 1]) !== 'thismac') throw new UiError('not_local', 'new chat is not local (This Mac)');
    const info = await ctx.page({ op: 'composerInfo' });
    if (!info.composer?.empty || info.images > 0) throw new UiError('draft_not_empty', 'the composer already has a draft');
    return screen;
  }

  /**
   * Open a NEW chat on `project` (sidebar group "New Agent"), type the first message, and send.
   * Verify the correct project and "This Mac" (local) environment: never cloud or worktree chats.
   * Returns the created chat id (new sidebar row).
   */
  async newChat({ project, text, files = [], dryRun = false, branch, model }) {
    if (typeof project !== 'string' || !project.trim()) throw new UiError('bad_project', 'invalid project');
    return this.withSession(async (ctx) => {
      const st = {};
      // Any error leaves Cursor on the new-chat screen: reopen the previously selected chat.
      try {
        const screen = await this.#openNewChat(ctx, project, st);
        const { previous, before } = st;
        let chosen = null;
        if (branch || model) {
          const r = await this.#applyChoices(ctx, { branch, model });
          chosen = r.after;
          st.revert = r.before; // Cursor's default changes with the pick: restore at the end
        }
        if (dryRun) {
          // Tests only: reach here (screen, project, environment, empty draft), attach and remove images, do not send.
          let n = null;
          if (files.length) {
            await this.#attach(ctx, files);
            n = (await ctx.page({ op: 'attachState' })).previews;
            await ctx.clearImages();
          }
          if (st.revert) await this.#applyChoices(ctx, { branch: st.revert.branch, model: st.revert.model }).catch(() => {});
          await this.#restore(ctx, previous, '');
          return { dryRun: true, project: screen.triggers[0], env: screen.triggers[screen.triggers.length - 1], attached: n, chosen };
        }

        let attached = false;
        try {
          if (files.length) {
            await this.#attach(ctx, files);
            attached = true;
          }
          if (text) {
            await ctx.clickTarget({ target: 'composer' });
            const focus = await ctx.focusState('composer');
            if (!focus.found || !focus.focused) throw new UiError('focus_failed', 'composer field not focused');
            await ctx.typeText(text);
            const typed = await waitFor(async () => {
              const f = await ctx.focusState('composer');
              return f.found && norm(f.text).startsWith(norm(text).slice(0, 40)) ? f : null;
            }, { timeoutMs: 3000, sleep: this.sleep });
            if (!typed) throw new UiError('type_failed', 'text not entered in composer');
          }
          const enabled = await waitFor(async () => {
            const i = await ctx.page({ op: 'composerInfo' });
            return i.send && !i.send.disabled ? i : null;
          }, { timeoutMs: 3000, sleep: this.sleep });
          if (!enabled) throw new UiError('send_disabled', 'send button not available');
        } catch (e) {
          if (attached) await ctx.clearImages().catch(() => {});
          throw e;
        }
        await ctx.clickTarget({ target: 'send' });
        // Cursor first creates a "draft" row and, after send, replaces it with the real chat (different id): take the new row
        // only when the list of new rows is stable and exactly one remains.
        let lastSig = null;
        let since = 0;
        const created = await waitFor(async () => {
          const keys = await ctx.page({ op: 'rowKeys' });
          const fresh = keys.filter((k) => !before.has(k));
          const sig = fresh.join('|');
          if (sig !== lastSig) {
            lastSig = sig;
            since = Date.now();
            return null;
          }
          return fresh.length === 1 && Date.now() - since >= 1200 ? fresh[0] : null;
        }, { timeoutMs: 15_000, intervalMs: 250, sleep: this.sleep });
        if (!created) throw new UiError('send_failed', 'new chat not visible in Cursor');
        if (st.revert) {
          // Reopen "new chat" only to restore branch and model defaults as they were.
          try {
            await this.#openNewChat(ctx, project, {});
            await this.#applyChoices(ctx, { branch: st.revert.branch, model: st.revert.model });
          } catch {
            // best-effort: chat already started, do not turn into failure
          }
        }
        await this.#restore(ctx, previous, created.replace(/^row:/, ''));
        return { composerId: created.replace(/^row:/, '') };
      } catch (e) {
        if (st.revert) await this.#applyChoices(ctx, { branch: st.revert.branch, model: st.revert.model }).catch(() => {});
        await this.#restore(ctx, st.previous, '').catch(() => {});
        throw e;
      }
    });
  }
}

