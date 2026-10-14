// JSON line logger that must NOT write chat contents, keys, or tokens.
//
// Safe by construction (see AGENTS.md):
//  - numbers and booleans always pass through;
//  - STRINGS pass only for allow-listed keys (short non-sensitive values, e.g. `reason`, `kind`);
//    any other string, object, or array becomes a placeholder: a miswritten log cannot leak data;
//  - errors are never logged with the message (may contain JSON fragments or paths): name and code only.

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

/** Safe fields from an error: name and code only (never `message`). */
export function errorFields(err) {
  return { error: String(err?.name ?? 'Error'), errcode: String(err?.code ?? err?.errstr ?? '') };
}

export function createLogger({ level = 'info', stream = process.stdout, now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  function write(lvl, event, fields) {
    if (LEVELS[lvl] < min) return;
    // t/lvl/event come first and fields cannot overwrite them.
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
