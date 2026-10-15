import { MESSAGES } from './i18n-messages.js';

export const LANGUAGES = Object.freeze(['en', 'it', 'es', 'fr', 'de', 'pt', 'ja', 'zh']);
export const DEFAULT_LANGUAGE = 'en';

/** Map a BCP47-ish tag to a supported language code, or null. */
export function normalizeLanguage(x) {
  if (x == null || typeof x !== 'string') return null;
  const raw = x.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (LANGUAGES.includes(lower)) return lower;
  const primary = lower.split(/[-_]/)[0];
  if (LANGUAGES.includes(primary)) return primary;
  return null;
}

/** Resolved language for a stored subscription value (NULL -> English). */
export function effectiveLanguage(stored) {
  return normalizeLanguage(stored) ?? DEFAULT_LANGUAGE;
}

/**
 * @param {string|null|undefined} lang
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function tm(lang, key, params = {}) {
  const code = effectiveLanguage(lang);
  let text = MESSAGES[code]?.[key] ?? MESSAGES[DEFAULT_LANGUAGE]?.[key] ?? key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/** i18n key for an approval tool TYPE (never parameters). */
export function toolActionKey(toolName) {
  switch (toolName) {
    case 'run_terminal_command_v2':
      return 'push.tool.command';
    case 'edit_file':
    case 'edit_file_v2':
      return 'push.tool.edit';
    case 'mcp':
    case 'call_mcp_tool':
    case 'read_mcp_resource':
      return 'push.tool.mcp';
    case 'web_fetch':
      return 'push.tool.web';
    default:
      return 'push.tool.generic';
  }
}
