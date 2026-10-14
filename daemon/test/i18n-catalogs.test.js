import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../../pwa/js/i18n/locales/en.js';

const LOCALES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../pwa/js/i18n/locales');

function placeholders(s) {
  return [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

test('locale catalogs: same keys and placeholders as en (non-empty locales only)', async () => {
  const enKeys = Object.keys(en).sort();
  for (const file of fs.readdirSync(LOCALES).filter((f) => f.endsWith('.js') && f !== 'en.js')) {
    const mod = await import(path.join(LOCALES, file));
    const cat = mod.default;
    const keys = Object.keys(cat);
    if (!keys.length) continue;
    assert.deepEqual(keys.sort(), enKeys, `${file} key set`);
    for (const k of enKeys) {
      assert.equal(placeholders(cat[k]), placeholders(en[k]), `${file} placeholders for ${k}`);
    }
  }
});
