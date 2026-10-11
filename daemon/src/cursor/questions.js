// Normalizza i parametri della tool call `ask_question` di Cursor (stringa JSON) in una forma stabile per la PWA.
//
// Formato interno di Cursor (verificato in Fase 0/1): {title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}
// Dettaglio interno: tenuto in `daemon/src/cursor/`.
import { clampStr, safeJsonParse } from '../util.js';

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;

/** Id con cui Cursor registra la risposta libera ("Other...") di una domanda (bundle: `questionnaireUtils.js`). */
export const FREEFORM_ID = '__freeform_other__';

/**
 * Cursor non mostra le opzioni la cui etichetta e' "other", "other: ...", "other - ..." o "other (...)": in fondo mette
 * sempre la propria voce "Other..." con il campo libero (bundle: funzione `Ylk`). La PWA fa lo stesso.
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
// Decodifica di `toolFormerData.toolCallBinary`.
//
// Cursor scrive il bubble di una domanda appena l'agente la formula, con `status: loading` e SENZA `params`: il testo in
// chiaro arriva solo a fine turno (da pochi secondi ad oltre un minuto dopo, FINDINGS 10.4c). Gia' al momento della
// creazione, pero', il bubble contiene `toolCallBinary`: la tool call serializzata in Protocol Buffers (base64), con la
// stessa domanda. Struttura osservata (nessuno schema ufficiale, ricavata e confrontata con `params` su domande vere):
//   campo 23 { campo 1 { campo 1: titolo, campo 2 (ripetuto): domanda { 1: id, 2: testo, 3 (ripetuto): opzione { 1: id, 2: etichetta }, 4: scelta multipla } } }
//   campo 57: toolCallId, campo 59: istante di creazione.
// Il decodificatore e' volutamente rigido: a ogni dubbio (dati troncati, campi inattesi, testo non UTF-8) risponde null e
// la domanda si legge da `params` appena disponibile, come prima.
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

/** Campi di un messaggio protobuf: `[{field, varint}]` o `[{field, bytes}]`; null se i dati sono malformati. */
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

/** Domanda dal `toolCallBinary` (base64) nella stessa forma di `params`; null se non e' una domanda leggibile. */
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
