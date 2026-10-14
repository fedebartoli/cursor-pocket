import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage, tm, toolActionKey } from '../src/i18n.js';
import { MESSAGES } from '../src/i18n-messages.js';

test('normalizeLanguage maps BCP47 tags and rejects unknown', () => {
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('pt-BR'), 'pt');
  assert.equal(normalizeLanguage('zh-Hans'), 'zh');
  assert.equal(normalizeLanguage('  DE-de  '), 'de');
  assert.equal(normalizeLanguage('xx'), null);
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage(null), null);
});

test('tm: fallback to English then key; placeholders', () => {
  assert.equal(tm('de', 'push.title.question'), MESSAGES.de['push.title.question']);
  assert.equal(tm('xx', 'push.title.question'), MESSAGES.en['push.title.question']);
  assert.equal(tm('en', 'missing.key'), 'missing.key');
  assert.equal(tm(null, 'push.title.done'), MESSAGES.en['push.title.done']);
  assert.equal(tm('en', 'push.test.body', { name: 'x' }), MESSAGES.en['push.test.body']);
});

test('catalog parity: same keys and placeholders in every language', () => {
  const enKeys = Object.keys(MESSAGES.en).sort();
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const lang of LANGUAGES) {
    assert.equal(lang, lang.toLowerCase());
    const keys = Object.keys(MESSAGES[lang]).sort();
    assert.deepEqual(keys, enKeys, `${lang} keys differ from en`);
    for (const key of enKeys) {
      assert.equal(placeholders(MESSAGES[lang][key]), placeholders(MESSAGES.en[key]), `${lang} ${key} placeholders`);
    }
  }
  assert.equal(DEFAULT_LANGUAGE, 'en');
});

test('toolActionKey maps known tools', () => {
  assert.equal(tm('it', toolActionKey('run_terminal_command_v2')), 'Comando da eseguire');
  assert.equal(tm('it', toolActionKey('edit_file_v2')), 'Modifica di un file');
  assert.equal(tm('it', toolActionKey('call_mcp_tool')), 'Strumento MCP');
  assert.equal(tm('it', toolActionKey('web_fetch')), 'Richiesta web');
  assert.equal(tm('it', toolActionKey('unknown_tool')), 'Azione da approvare');
});
