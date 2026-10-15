import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initI18n, languageOf, pickLanguage, t, translate } from '../../pwa/js/i18n/index.js';

test('languageOf: primary subtag of supported languages only', () => {
  assert.equal(languageOf('pt-BR'), 'pt');
  assert.equal(languageOf('zh-Hans-CN'), 'zh');
  assert.equal(languageOf('IT_it'), 'it');
  assert.equal(languageOf('ru'), null);
  assert.equal(languageOf(undefined), null);
});

test('pickLanguage: explicit choice wins, "auto" follows the browser, otherwise English', () => {
  assert.equal(pickLanguage('de', ['it-IT']), 'de');
  assert.equal(pickLanguage('auto', ['ru-RU', 'fr-CA', 'it']), 'fr');
  assert.equal(pickLanguage('auto', ['ru']), 'en');
  assert.equal(pickLanguage('klingon', []), 'en');
  assert.equal(pickLanguage(undefined, undefined), 'en');
});

test('translate: placeholders, plural categories, fallback to English, then to the key', () => {
  const en = { 'a.hello': 'Hello {name}', 'a.items.one': '{count} item', 'a.items.other': '{count} items', 'a.only': 'English only' };
  const it = { 'a.hello': 'Ciao {name}', 'a.items.one': '{count} elemento', 'a.items.other': '{count} elementi' };
  assert.equal(translate('it', it, en, 'a.hello', { name: 'Ada' }), 'Ciao Ada');
  assert.equal(translate('it', it, en, 'a.items', { count: 1 }), '1 elemento');
  assert.equal(translate('it', it, en, 'a.items', { count: 5 }), '5 elementi');
  assert.equal(translate('it', it, en, 'a.only'), 'English only');
  assert.equal(translate('it', it, en, 'a.missing'), 'a.missing');
  assert.equal(translate('en', en, en, 'a.hello', {}), 'Hello {name}', 'unknown placeholder is left untouched');
  const ja = { 'a.items.other': '{count}\u4ef6' };
  assert.equal(translate('ja', ja, en, 'a.items', { count: 1 }), '1\u4ef6', 'Japanese has no singular');
});

test('initI18n: loads the catalog of the chosen language and falls back to English', async () => {
  assert.equal(await initI18n({ preference: 'it', browserLanguages: [] }), 'it');
  assert.equal(typeof t('does.not.exist'), 'string');
  assert.equal(await initI18n({ preference: 'auto', browserLanguages: ['es-MX'] }), 'es');
  assert.equal(await initI18n({ preference: 'en', browserLanguages: [] }), 'en');
});
