// Normalizes Cursor `ask_question` tool call params (JSON string) into a stable shape for the PWA.
//
// Cursor internal format (verified in Phase 0/1): {title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}
// Internal detail: kept in `daemon/src/cursor/`.
import { clampStr, safeJsonParse } from '../util.js';

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;

/** Id Cursor uses to record freeform ("Other...") answer for a question (bundle: `questionnaireUtils.js`). */
export const FREEFORM_ID = '__freeform_other__';

/**
 * Cursor hides options whose label is "other", "other: ...", "other - ...", or "other (...)": at the bottom it always
 * adds its own "Other..." entry with the freeform field (bundle: function `Ylk`). The PWA does the same.
 */
export function isOtherLabel(label) {
  const s = String(label ?? '').toLowerCase().trim();
  return s === 'other' || s.startsWith('other:') || s.startsWith('other -') || s.startsWith('other (');
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

export function normalizeQuestionParams(rawParams) {
  const p = typeof rawParams === 'string' ? safeJsonParse(rawParams, null) : rawParams;
  if (!p || typeof p !== 'object') return null;
  const questions = Array.isArray(p.questions) ? p.questions : [];
  const out = [];
  for (const q of questions.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object') continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .slice(0, MAX_OPTIONS)
      .filter((o) => o && typeof o === 'object')
      .map((o) => ({ id: str(o.id), label: clampStr(str(o.label), 200) }))
      .filter((o) => !isOtherLabel(o.label));
    out.push({
      id: str(q.id),
      prompt: clampStr(str(q.prompt), 1500),
      options,
      allowMultiple: q.allowMultiple === true,
    });
  }
  if (!out.length && !str(p.title)) return null;
  return { title: clampStr(str(p.title), 200), questions: out };
}

// ---------------------------------------------------------------------------------------------------------------
// Decode `toolFormerData.toolCallBinary`.
//
// Cursor writes the question bubble as soon as the agent asks, with `status: loading` and WITHOUT `params`: plain text
// arrives only at end of turn (seconds to over a minute later, FINDINGS 10.4c). At creation time, though, the bubble
// already contains `toolCallBinary`: the tool call serialized as Protocol Buffers (base64), with the same question.
// Observed structure (no official schema, derived and compared with `params` on real questions):
//   field 23 { field 1 { field 1: title, field 2 (repeated): question { 1: id, 2: text, 3 (repeated): option { 1: id, 2: label }, 4: multiple choice } } }
//   field 57: toolCallId, field 59: creation timestamp.
// Decoder is intentionally strict: on any doubt (truncated data, unexpected fields, non-UTF-8 text) returns null and
// the question is read from `params` when available, as before.
// ---------------------------------------------------------------------------------------------------------------

const MAX_BINARY_CHARS = 64_000;

function readVarint(buf, start) {
  let value = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    if (i >= buf.length || shift > 42) return null;
    const byte = buf[i++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, i];
    shift += 7;
  }
}

/** Fields of a protobuf message: `[{field, varint}]` or `[{field, bytes}]`; null if data is malformed. */
function readFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag) return null;
    i = tag[1];
    const field = Math.floor(tag[0] / 8);
    const wire = tag[0] % 8;
    if (field < 1) return null;
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return null;
      i = v[1];
      out.push({ field, varint: v[0] });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      i = len[1];
      if (len[0] > buf.length - i) return null;
      out.push({ field, bytes: buf.subarray(i, i + len[0]) });
      i += len[0];
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      i += 4;
    } else {
      return null;
    }
  }
  return out;
}

function utf8(bytes) {
  const s = bytes.toString('utf8');
  return s.includes('\ufffd') ? null : s;
}

const bytesOf = (fields, n) => fields.find((e) => e.field === n && e.bytes)?.bytes ?? null;

/** Question from `toolCallBinary` (base64) in the same shape as `params`; null if not a readable question. */
export function decodeQuestionBinary(base64) {
  if (typeof base64 !== 'string' || !base64 || base64.length > MAX_BINARY_CHARS) return null;
  const top = readFields(Buffer.from(base64, 'base64'));
  const call = top && bytesOf(top, 23);
  const form = call && readFields(call);
  const body = form && bytesOf(form, 1);
  const items = body && readFields(body);
  if (!items) return null;
  const titleBytes = bytesOf(items, 1);
  const title = titleBytes ? utf8(titleBytes) : '';
  if (title === null) return null;
  const questions = [];
  for (const e of items.filter((x) => x.field === 2 && x.bytes)) {
    const q = readFields(e.bytes);
    if (!q) return null;
    const idB = bytesOf(q, 1);
    const promptB = bytesOf(q, 2);
    if (!idB || !promptB) return null;
    const options = [];
    for (const o of q.filter((x) => x.field === 3 && x.bytes)) {
      const of = readFields(o.bytes);
      const oid = of && bytesOf(of, 1);
      const label = of && bytesOf(of, 2);
      if (!oid || !label) return null;
      options.push({ id: utf8(oid), label: utf8(label) });
    }
    const qid = utf8(idB);
    const prompt = utf8(promptB);
    if (qid === null || prompt === null || options.some((o) => o.id === null || o.label === null)) return null;
    questions.push({ id: qid, prompt, options, allowMultiple: q.some((x) => x.field === 4 && x.varint === 1) });
  }
  if (!questions.length) return null;
  return { title, questions };
}
