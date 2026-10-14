import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../../pwa/js/i18n/locales/en.js';
import it from '../../pwa/js/i18n/locales/it.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function collectErrorKeys() {
  const keys = new Set();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) keysFromFile(fs.readFileSync(p, 'utf8'), keys);
    }
  };
  walk(SRC);
  return [...keys].sort();
}

function keysFromFile(text, keys) {
  for (const m of text.matchAll(/new ActionError\(\s*\d+\s*,\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of text.matchAll(/new HttpError\(\s*\d+\s*,\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of text.matchAll(/detail:\s*'([^']+)'/g)) keys.add(m[1]);
  const ui = text.match(/const UI_ERRORS = \{([\s\S]*?)\n\};/);
  if (ui) for (const m of ui[1].matchAll(/^\s+(\w+):/gm)) keys.add(m[1]);
}

test('daemon error codes and details have error.* keys in en and it', () => {
  const needed = collectErrorKeys();
  assert.ok(needed.length > 20, 'expected many keys from daemon/src');
  for (const key of needed) {
    const id = `error.${key}`;
    assert.ok(en[id], `missing en ${id}`);
    assert.ok(it[id], `missing it ${id}`);
  }
});
