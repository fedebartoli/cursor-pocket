// Formattazione minimale e SICURA del testo dell'agente: paragrafi, elenchi, titoli, codice, citazioni.
// Costruisce solo nodi DOM con `h` (mai innerHTML) e NON interpreta i link: il testo di una chat non deve poter diventare
// un collegamento cliccabile. Cio' che non si riconosce resta testo normale, quindi nulla va perso.
import { h } from './dom.js';

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const BULLET = /^\s*[-*+\u2022]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|.*\|\s*$/;

/**
 * Elementi in linea: `codice`, **grassetto**, *corsivo*. Ritorna [{ t: 'text'|'code'|'strong'|'em', text }].
 * Un marcatore non chiuso resta testo.
 */
export function parseInline(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', text: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    } else if (c === '*' && s[i + 1] !== ' ' && s[i + 1] !== '*') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1 && s[end - 1] !== ' ') {
        flush();
        out.push({ t: 'em', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** Blocchi: p | h | ul | ol | code | quote | table | hr. */
export function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;
  let quote = null;
  let table = null;

  const endPara = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join('\n') });
    para = [];
  };
  const endList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const endQuote = () => {
    if (quote) blocks.push({ type: 'quote', text: quote.join('\n') });
    quote = null;
  };
  const endTable = () => {
    if (table) blocks.push({ type: 'table', text: table.join('\n') });
    table = null;
  };
  const endAll = () => {
    endPara();
    endList();
    endQuote();
    endTable();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      endAll();
      const body = [];
      i += 1;
      const closes = (l) => /^(`{3,}|~{3,})$/.test(l.trim()) && l.trim()[0] === fence[1][0];
      while (i < lines.length && !closes(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endAll();
      continue;
    }
    if (RULE.test(line) && !BULLET.test(line)) {
      endAll();
      blocks.push({ type: 'hr' });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endAll();
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
      continue;
    }
    if (TABLE.test(line)) {
      endPara();
      endList();
      endQuote();
      (table ??= []).push(line);
      continue;
    }
    endTable();
    const q = QUOTE.exec(line);
    if (q) {
      endPara();
      endList();
      (quote ??= []).push(q[1]);
      continue;
    }
    endQuote();
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      endPara();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) endList();
      list ??= { type, items: [] };
      list.items.push(bullet ? bullet[1] : ordered[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // riga di continuazione di una voce di elenco
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    endList();
    para.push(line);
  }
  endAll();
  return blocks;
}

function inlineNodes(text) {
  return parseInline(text).map((tok) => {
    if (tok.t === 'code') return h('code', { class: 'md-inline-code' }, tok.text);
    if (tok.t === 'strong') return h('strong', null, tok.text);
    if (tok.t === 'em') return h('em', null, tok.text);
    return tok.text;
  });
}

/** Nodi DOM per il testo (da inserire in un contenitore). */
export function renderMarkdown(text) {
  return parseBlocks(text).map((b) => {
    switch (b.type) {
      case 'h':
        return h('p', { class: `md-h md-h${Math.min(b.level, 3)}` }, inlineNodes(b.text));
      case 'ul':
      case 'ol':
        return h(`${b.type}.md-list`, null, b.items.map((it) => h('li', null, inlineNodes(it))));
      case 'code':
        return h('pre', { class: 'md-code', tabindex: '0' }, h('code', null, b.text));
      case 'table':
        return h('pre', { class: 'md-code', tabindex: '0' }, h('code', null, b.text));
      case 'quote':
        return h('blockquote', { class: 'md-quote' }, inlineNodes(b.text));
      case 'hr':
        return h('hr', { class: 'md-hr' });
      default:
        return h('p', { class: 'md-p' }, inlineNodes(b.text));
    }
  });
}
