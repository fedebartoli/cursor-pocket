import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeQuestionBinary, normalizeQuestionParams } from '../src/cursor/questions.js';

// Minimal protobuf encoder for tests only (structure observed in Cursor, see questions.js).
const varint = (n) => {
  const out = [];
  let v = n;
  while (v > 127) {
    out.push((v & 127) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
};
const tag = (f, w) => varint(f * 8 + w);
const bytes = (f, b) => Buffer.concat([tag(f, 2), varint(b.length), b]);
const str = (f, s) => bytes(f, Buffer.from(s, 'utf8'));
const num = (f, n) => Buffer.concat([tag(f, 0), varint(n)]);

function encode({ title, questions }) {
  const qs = questions.map((q) =>
    bytes(
      2,
      Buffer.concat([
        str(1, q.id),
        str(2, q.prompt),
        ...q.options.map((o) => bytes(3, Buffer.concat([str(1, o.id), str(2, o.label)]))),
        ...(q.allowMultiple ? [num(4, 1)] : []),
      ]),
    ),
  );
  const form = bytes(1, Buffer.concat([...(title ? [str(1, title)] : []), ...qs]));
  return Buffer.concat([bytes(23, form), str(57, 'tool_abc'), num(59, 1791974134692)]).toString('base64');
}

const SAMPLE = {
  title: 'Scelta del colore',
  questions: [
    { id: 'q1', prompt: 'Quale colore preferisci? \u00e8 una prova', options: [{ id: 'a', label: 'Rosso' }, { id: 'b', label: 'Blu' }] },
    { id: 'q2', prompt: 'Quali formati?', options: [{ id: 'x', label: 'PNG' }, { id: 'y', label: 'SVG' }, { id: 'z', label: 'WebP' }], allowMultiple: true },
  ],
};

test('toolCallBinary: decoded question matches params', () => {
  const decoded = decodeQuestionBinary(encode(SAMPLE));
  assert.deepEqual(normalizeQuestionParams(decoded), normalizeQuestionParams(SAMPLE));
  assert.equal(decoded.questions[1].allowMultiple, true);
  assert.equal(decoded.questions[0].allowMultiple, false);
});

test('toolCallBinary: without title title is empty; "Other" still filtered by normalization', () => {
  const d = decodeQuestionBinary(encode({ questions: [{ id: 'q', prompt: 'Ok?', options: [{ id: 'a', label: 'Si' }, { id: 'o', label: 'Other: altro' }] }] }));
  assert.equal(d.title, '');
  assert.deepEqual(normalizeQuestionParams(d).questions[0].options.map((o) => o.label), ['Si']);
});

test('toolCallBinary: empty, truncated, malformed or non-UTF-8 data yields null (never throws)', () => {
  const good = Buffer.from(encode(SAMPLE), 'base64');
  assert.equal(decodeQuestionBinary(null), null);
  assert.equal(decodeQuestionBinary(''), null);
  assert.equal(decodeQuestionBinary('!!non-base64!!'), null);
  // as live bubble with empty args still observed: empty field 23 + toolCallId
  assert.equal(decodeQuestionBinary(Buffer.concat([bytes(23, Buffer.alloc(0)), str(57, 'tool_abc')]).toString('base64')), null);
  for (const cut of [1, 5, 20, good.length - 3]) assert.equal(decodeQuestionBinary(good.subarray(0, cut).toString('base64')), null, `truncated at ${cut}`);
  const badUtf8 = Buffer.concat([bytes(23, bytes(1, bytes(2, Buffer.concat([bytes(1, Buffer.from('q')), bytes(2, Buffer.from([0xff, 0xfe, 0xfd]))]))))]);
  assert.equal(decodeQuestionBinary(badUtf8.toString('base64')), null);
  assert.equal(decodeQuestionBinary('A'.repeat(70_000)), null);
  const junk = Buffer.alloc(64);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) & 255;
  assert.doesNotThrow(() => decodeQuestionBinary(junk.toString('base64')));
});
