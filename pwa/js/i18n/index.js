// Minimal internationalization: one flat catalog per language, English as the fallback.
//
//   t('chat.send')                          -> "Send"
//   t('home.count', { count: 3 })           -> uses 'home.count.one' / 'home.count.other' (Intl.PluralRules), then 'home.count'
//   t('login.hint', { minutes: 15 })        -> "Code valid for {minutes} min" with {minutes} replaced
//
// Rules for callers: never call t() at module top level (the language is loaded before the first screen is mounted,
// but modules are evaluated earlier); always call it inside functions. Changing the language reloads the page.
export const LANGUAGES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'it', name: 'Italiano' },
  { code: 'es', name: 'Espa\u00f1ol' },
  { code: 'fr', name: 'Fran\u00e7ais' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Portugu\u00eas' },
  { code: 'ja', name: '\u65e5\u672c\u8a9e' },
  { code: 'zh', name: '\u7b80\u4f53\u4e2d\u6587' },
]);
export const DEFAULT_LANGUAGE = 'en';
export const STORAGE_KEY = 'cp.lang';
const CODES = new Set(LANGUAGES.map((l) => l.code));

/** Primary subtag of a BCP 47 tag, if it is a supported language ('pt-BR' -> 'pt', 'zh-Hans-CN' -> 'zh'). Pure. */
export function languageOf(tag) {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return CODES.has(primary) ? primary : null;
}

/**
 * Picks the language to use. `preference` is a supported code or 'auto'; with 'auto' the first browser language we support
 * wins, otherwise English. Pure.
 */
export function pickLanguage(preference, browserLanguages = []) {
  const chosen = languageOf(preference);
  if (chosen && preference !== 'auto') return chosen;
  for (const tag of browserLanguages ?? []) {
    const l = languageOf(tag);
    if (l) return l;
  }
  return DEFAULT_LANGUAGE;
}

/** Looks up `key` (with plural variants when `params.count` is a number) and fills in {placeholders}. Pure. */
export function translate(lang, messages, fallback, key, params) {
  let template;
  if (params && typeof params.count === 'number') {
    let category = 'other';
    try {
      category = new Intl.PluralRules(lang).select(params.count);
    } catch {
      // unknown language tag: use "other"
    }
    template = messages[`${key}.${category}`] ?? messages[`${key}.other`] ?? fallback[`${key}.${category}`] ?? fallback[`${key}.other`];
  }
  template ??= messages[key] ?? fallback[key];
  if (typeof template !== 'string') return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

let state = { lang: DEFAULT_LANGUAGE, messages: {}, fallback: {} };

async function loadCatalog(lang) {
  return (await import(`./locales/${lang}.js`)).default;
}

/**
 * Loads the catalogs. `preference` defaults to what the user saved ('auto' if nothing); `browserLanguages` defaults to
 * navigator.languages. Safe to call again (tests).
 */
export async function initI18n({ preference, browserLanguages } = {}) {
  const saved = preference ?? readPreference();
  const langs = browserLanguages ?? (typeof navigator !== 'undefined' ? [...(navigator.languages ?? [navigator.language])] : []);
  const lang = pickLanguage(saved, langs);
  const fallback = await loadCatalog(DEFAULT_LANGUAGE);
  const messages = lang === DEFAULT_LANGUAGE ? fallback : await loadCatalog(lang);
  state = { lang, messages, fallback };
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return lang;
}

export const t = (key, params) => translate(state.lang, state.messages, state.fallback, key, params);
export const getLanguage = () => state.lang;
/** Whether a key exists in the current catalog or in the English fallback. */
export const hasMessage = (key) => typeof (state.messages[key] ?? state.fallback[key]) === 'string';

function readPreference() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}
export const getLanguagePreference = () => readPreference();

/** Saves the choice ('auto' or a code); the caller reloads the page to apply it. */
export function setLanguagePreference(preference) {
  try {
    if (preference === 'auto') globalThis.localStorage?.removeItem(STORAGE_KEY);
    else if (CODES.has(preference)) globalThis.localStorage?.setItem(STORAGE_KEY, preference);
  } catch {
    // storage unavailable (private mode): the choice is not saved
  }
}
