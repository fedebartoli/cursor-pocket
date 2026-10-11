// Logger a righe JSON che NON puo' scrivere contenuti di chat, chiavi o token.
//
// Sicuro per costruzione (vedi AGENTS.md):
//  - numeri e booleani passano sempre;
//  - le STRINGHE passano solo per chiavi in allow-list (valori brevi e non sensibili, es. `reason`, `kind`);
//    qualunque altra stringa, oggetto o array diventa un segnaposto: un log scritto male non puo' far trapelare dati;
//  - gli errori non si loggano mai col messaggio (puo' contenere frammenti di JSON o percorsi): solo nome e codice.

const STRING_KEYS = new Set(['reason', 'kind', 'signal', 'error', 'errcode', 'host', 'state']);
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const OMITTED = '[omesso]';

function sanitizeValue(key, v) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string' && STRING_KEYS.has(key)) return v.length > 80 ? `${v.slice(0, 79)}\u2026` : v;
  return OMITTED;
}

export function sanitizeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = sanitizeValue(k, v);
  return out;
}

/** Campi sicuri da un errore: solo nome e codice (mai `message`). */
export function errorFields(err) {
  return { error: String(err?.name ?? 'Error'), errcode: String(err?.code ?? err?.errstr ?? '') };
}

export function createLogger({ level = 'info', stream = process.stdout, now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  function write(lvl, event, fields) {
    if (LEVELS[lvl] < min) return;
    // t/lvl/event vengono prima e i campi non possono sovrascriverli.
    const rec = { t: now().toISOString(), lvl, event };
    for (const [k, v] of Object.entries(sanitizeFields(fields))) {
      if (!(k in rec)) rec[k] = v;
    }
    stream.write(`${JSON.stringify(rec)}\n`);
  }
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };
