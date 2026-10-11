// Formattazione del testo dell'agente nella PWA (parte pura: nessun DOM).
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlocks, parseInline } from '../../pwa/js/markdown.js';

test('parseInline: codice, grassetto, corsivo; marcatori non chiusi restano testo', () => {
  assert.deepEqual(parseInline('Usa `npm test` e **non** *saltare*'), [
    { t: 'text', text: 'Usa ' },
    { t: 'code', text: 'npm test' },
    { t: 'text', text: ' e ' },
    { t: 'strong', text: 'non' },
    { t: 'text', text: ' ' },
    { t: 'em', text: 'saltare' },
  ]);
  assert.deepEqual(parseInline('2 * 3 = 6 e `aperto'), [{ t: 'text', text: '2 * 3 = 6 e `aperto' }]);
  assert.deepEqual(parseInline('**aperto'), [{ t: 'text', text: '**aperto' }]);
  assert.deepEqual(parseInline(''), []);
});

test('parseInline: i link non vengono interpretati (nessun collegamento dal testo di una chat)', () => {
  const toks = parseInline('Vedi [guida](https://esempio.test/x)');
  assert.equal(toks.length, 1);
  assert.equal(toks[0].t, 'text');
  assert.ok(toks[0].text.includes('https://esempio.test/x'), 'l\'indirizzo resta visibile come testo');
});

test('parseBlocks: paragrafi, titoli, elenchi puntati e numerati', () => {
  const b = parseBlocks('## Esito\nTutto ok.\nSeconda riga.\n\n- uno\n- due\n  continua\n\n1. primo\n2) secondo');
  assert.deepEqual(b, [
    { type: 'h', level: 2, text: 'Esito' },
    { type: 'p', text: 'Tutto ok.\nSeconda riga.' },
    { type: 'ul', items: ['uno', 'due\ncontinua'] },
    { type: 'ol', items: ['primo', 'secondo'] },
  ]);
});

test('parseBlocks: codice recintato (anche non chiuso), tabelle e citazioni', () => {
  assert.deepEqual(parseBlocks('Prima\n```js\nconst a = 1;\n\nconst b = 2;\n```\nDopo'), [
    { type: 'p', text: 'Prima' },
    { type: 'code', lang: 'js', text: 'const a = 1;\n\nconst b = 2;' },
    { type: 'p', text: 'Dopo' },
  ]);
  assert.deepEqual(parseBlocks('```\nsenza fine\nancora'), [{ type: 'code', lang: '', text: 'senza fine\nancora' }]);
  assert.deepEqual(parseBlocks('| a | b |\n|---|---|\n| 1 | 2 |'), [{ type: 'table', text: '| a | b |\n|---|---|\n| 1 | 2 |' }]);
  assert.deepEqual(parseBlocks('> nota\n> seconda'), [{ type: 'quote', text: 'nota\nseconda' }]);
});

test('parseBlocks: il codice non viene interpretato come markdown e l\'HTML resta testo', () => {
  const b = parseBlocks('```\n# non un titolo\n- non un elenco\n```\n<script>alert(1)</script>');
  assert.equal(b[0].type, 'code');
  assert.equal(b[0].text, '# non un titolo\n- non un elenco');
  assert.deepEqual(b[1], { type: 'p', text: '<script>alert(1)</script>' });
});

test('parseBlocks: separatore e testo vuoto', () => {
  assert.deepEqual(parseBlocks('a\n\n---\n\nb'), [{ type: 'p', text: 'a' }, { type: 'hr' }, { type: 'p', text: 'b' }]);
  assert.deepEqual(parseBlocks(''), []);
  assert.deepEqual(parseBlocks(undefined), []);
});
