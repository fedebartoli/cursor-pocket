// Logica pura della PWA per la fase 2 (nessun DOM): stato delle risposte, messaggi d'errore, viewport su iOS.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeActionError,
  describeAnswerResult,
  describeMessageResult,
  shouldRefreshAfter,
} from '../../pwa/js/action-errors.js';
import { AnswerState, FREEFORM_MAX, optionBadge } from '../../pwa/js/answers.js';
import { bottomShift, classifyTap, keyboardHeight } from '../../pwa/js/viewport.js';

const opts = (...ids) => ids.map((id) => ({ id, label: id }));
const single = { questions: [{ id: 'q1', prompt: 'Scelta?', options: opts('a', 'b', 'c'), allowMultiple: false }] };
const multi = { questions: [{ id: 'q1', prompt: 'Molte?', options: opts('a', 'b', 'c'), allowMultiple: true }] };
const two = {
  questions: [
    { id: 'q1', prompt: 'Una', options: opts('a', 'b'), allowMultiple: false },
    { id: 'q2', prompt: 'Molte', options: opts('x', 'y', 'z'), allowMultiple: true },
  ],
};

// ---------------------------------------------------------------- AnswerState

test('AnswerState: scelta singola, ritoccare l\u2019opzione scelta non la toglie e un\u2019altra la sostituisce', () => {
  const s = new AnswerState(single);
  assert.equal(s.isComplete(), false);
  assert.equal(s.missing(), 1);
  assert.equal(s.toggle('q1', 'b'), true);
  assert.equal(s.toggle('q1', 'b'), true);
  assert.equal(s.isSelected('q1', 'b'), true, 'a differenza di Cursor, qui un secondo tocco non deseleziona');
  s.toggle('q1', 'c');
  assert.equal(s.isSelected('q1', 'b'), false);
  assert.equal(s.isSelected('q1', 'c'), true);
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: ['c'], freeform: '' }]);
  assert.equal(s.isComplete(), true);
});

test('AnswerState: "Altro" nella scelta singola toglie le opzioni, e viceversa', () => {
  const s = new AnswerState(single);
  s.toggle('q1', 'a');
  assert.equal(s.toggleOther('q1'), true);
  assert.equal(s.isSelected('q1', 'a'), false);
  assert.equal(s.isComplete(), false, 'senza testo "Altro" non e\u2019 una risposta');
  s.setText('q1', '   ');
  assert.equal(s.isComplete(), false, 'il solo spazio non conta');
  s.setText('q1', '  la mia idea  ');
  assert.equal(s.isComplete(), true);
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: [], freeform: 'la mia idea' }]);
  s.toggle('q1', 'b');
  assert.equal(s.isOther('q1'), false, 'tornando a un\u2019opzione "Altro" si chiude');
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: ['b'], freeform: '' }], 'il testo non parte se "Altro" e\u2019 chiuso');
});

test('AnswerState: scelta multipla, opzioni in ordine della domanda e "Altro" in aggiunta', () => {
  const s = new AnswerState(multi);
  s.toggle('q1', 'c');
  s.toggle('q1', 'a');
  assert.deepEqual(s.payload()[0].optionIds, ['a', 'c'], 'l\u2019ordine segue la domanda, non i tocchi');
  s.toggle('q1', 'c');
  assert.deepEqual(s.payload()[0].optionIds, ['a'], 'in multipla un secondo tocco toglie');
  s.toggle('q1', 'a');
  assert.equal(s.isComplete(), false, 'nessuna scelta');
  s.toggle('q1', 'b');
  assert.equal(s.toggleOther('q1'), true);
  assert.equal(s.isComplete(), false, '"Altro" aperto ma vuoto blocca l\u2019invio anche con opzioni scelte');
  s.setText('q1', 'altro ancora');
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: ['b'], freeform: 'altro ancora' }]);
  assert.equal(s.toggleOther('q1'), false, 'secondo tocco chiude "Altro"');
  assert.equal(s.payload()[0].freeform, '');
});

test('AnswerState: piu\u2019 domande, conteggio di quelle mancanti', () => {
  const s = new AnswerState(two);
  assert.equal(s.missing(), 2);
  s.toggle('q2', 'y');
  assert.equal(s.missing(), 1);
  assert.equal(s.isComplete(), false);
  s.toggle('q1', 'a');
  assert.equal(s.missing(), 0);
  assert.equal(s.isComplete(), true);
  assert.deepEqual(
    s.payload().map((p) => p.questionId),
    ['q1', 'q2'],
  );
});

test('AnswerState: id inesistenti e domande vuote non rompono nulla', () => {
  const s = new AnswerState(single);
  assert.equal(s.toggle('nope', 'a'), false);
  assert.equal(s.toggle('q1', 'zzz'), false);
  assert.equal(s.toggleOther('nope'), false);
  s.setText('nope', 'x');
  assert.equal(s.text('nope'), '');
  assert.equal(s.isSelected('nope', 'a'), false);
  const empty = new AnswerState({ questions: [] });
  assert.equal(empty.isComplete(), false, 'senza domande non c\u2019e\u2019 nulla da inviare');
  assert.equal(new AnswerState(null).missing(), 0);
});

test('AnswerState: il testo libero e\u2019 limitato come nel daemon', () => {
  const s = new AnswerState(single);
  s.toggleOther('q1');
  s.setText('q1', 'x'.repeat(FREEFORM_MAX + 500));
  assert.equal(s.text('q1').length, FREEFORM_MAX);
  s.setText('q1', null);
  assert.equal(s.text('q1'), '');
});

test('optionBadge: lettere come in Cursor, poi numeri', () => {
  assert.equal(optionBadge(0), 'A');
  assert.equal(optionBadge(3), 'D');
  assert.equal(optionBadge(25), 'Z');
  assert.equal(optionBadge(26), '27');
});

// ---------------------------------------------------------------- messaggi d'errore

test('describeActionError: testi propri, testo del daemon, ripiego', () => {
  assert.match(describeActionError({ code: 'network' }), /non raggiungibile/i);
  assert.match(describeActionError({ code: 'stale', message: 'ignorato' }), /ho aggiornato la vista/);
  assert.equal(describeActionError({ code: 'unavailable', message: ' Cursor non e\u2019 raggiungibile. ' }), 'Cursor non e\u2019 raggiungibile.');
  assert.match(describeActionError({}), /riprova/i);
  assert.match(describeActionError(null), /riprova/i);
});

test('shouldRefreshAfter: solo quando lo stato sul Mac e\u2019 cambiato', () => {
  for (const code of ['stale', 'no_question', 'mismatch', 'already_sent', 'not_found', 'timeout']) {
    assert.equal(shouldRefreshAfter({ code }), true, code);
  }
  for (const code of ['network', 'unavailable', 'ui_failed', undefined]) {
    assert.equal(shouldRefreshAfter({ code }), false, String(code));
  }
  assert.equal(shouldRefreshAfter(undefined), false);
});

test('describeAnswerResult e describeMessageResult: distinguono confermato, non confermato, accodato', () => {
  assert.equal(describeAnswerResult({ ok: true, verified: true }), 'Risposta inviata.');
  assert.match(describeAnswerResult({ ok: true, verified: false }), /non riesco ancora a confermare/i);
  assert.match(describeAnswerResult({ ok: true, verified: true, warning: 'differs' }), /scelta diversa/);
  assert.equal(describeMessageResult({ ok: true, verified: true }), 'Messaggio inviato.');
  assert.match(describeMessageResult({ ok: true, verified: true, queued: true }), /in coda/);
  assert.match(describeMessageResult({ ok: true, verified: false }), /non riesco ancora a confermare/i);
});

// ---------------------------------------------------------------- viewport

const tap = (over = {}) => ({ x: 100, y: 200, t: 1000, moved: 0, duration: 80, ...over });

test('classifyTap: il primo tocco passa e viene ricordato', () => {
  const t = tap();
  assert.deepEqual(classifyTap(null, t), { double: false, remember: t });
});

test('classifyTap: il secondo tocco ravvicinato e\u2019 un doppio tocco e azzera la memoria', () => {
  const first = tap();
  const r = classifyTap(first, tap({ t: 1250, x: 110, y: 205 }));
  assert.deepEqual(r, { double: true, remember: null });
  // il tocco successivo riparte da zero: non e\u2019 un secondo doppio tocco
  const third = tap({ t: 1400 });
  assert.deepEqual(classifyTap(r.remember, third), { double: false, remember: third });
});

test('classifyTap: troppo tardi o troppo lontano non e\u2019 un doppio tocco', () => {
  const first = tap();
  const late = tap({ t: 1000 + 351 });
  assert.deepEqual(classifyTap(first, late), { double: false, remember: late });
  const far = tap({ t: 1100, x: 100 + 60 });
  assert.deepEqual(classifyTap(first, far), { double: false, remember: far });
  const edge = tap({ t: 1350, x: 100 + 36 });
  assert.equal(classifyTap(first, edge).double, true, 'i limiti sono inclusi');
});

test('classifyTap: trascinamenti e pressioni lunghe non sono tocchi e interrompono la sequenza', () => {
  const first = tap();
  assert.deepEqual(classifyTap(first, tap({ t: 1100, moved: 40 })), { double: false, remember: null });
  assert.deepEqual(classifyTap(first, tap({ t: 1100, duration: 700 })), { double: false, remember: null });
});

test('keyboardHeight: tastiera, barra del browser e pinch', () => {
  const base = { innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, vvScale: 1 };
  assert.equal(keyboardHeight(base), 0);
  assert.equal(keyboardHeight({ ...base, vvHeight: 509 }), 291, 'tastiera aperta');
  assert.equal(keyboardHeight({ ...base, vvHeight: 750 }), 0, 'solo la barra del browser (50 px)');
  assert.equal(keyboardHeight({ ...base, vvHeight: 400, vvScale: 2 }), 0, 'pinch-zoom: non e\u2019 la tastiera');
  assert.equal(keyboardHeight({ ...base, vvHeight: 509, vvOffsetTop: 100 }), 191, 'con la pagina spostata si sottrae lo scostamento');
  assert.equal(keyboardHeight({ innerHeight: 800, vvHeight: 509, vvOffsetTop: 0 }), 291, 'senza scala si assume 1');
});

test('bottomShift: barra in basso incollata al fondo visibile solo se il visual viewport si e\' spostato', () => {
  const base = { innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, vvScale: 1 };
  assert.equal(bottomShift(base), 0, 'allineato: nessuno spostamento');
  assert.equal(bottomShift({ ...base, vvOffsetTop: 1 }), 0, 'tolleranza di 1 px');
  assert.equal(bottomShift({ ...base, vvHeight: 700 }), -100, 'il visual viewport finisce prima: la barra sale');
  assert.equal(bottomShift({ ...base, vvOffsetTop: 40, vvHeight: 800 }), 40, 'visual viewport oltre il layout: la barra scende');
  assert.equal(bottomShift({ ...base, vvHeight: 400, vvScale: 2 }), 0, 'pinch-zoom: non si tocca');
});

import { isQuiet, normalizeQuiet } from '../src/push/quiet.js';

test('orari senza notifiche: fascia normale, a cavallo della mezzanotte, vuota e valori non validi', () => {
  const at = (h, m = 0) => new Date(2026, 9, 15, h, m);
  const night = { enabled: true, from: '22:00', to: '07:00' };
  assert.equal(isQuiet(night, at(23)), true);
  assert.equal(isQuiet(night, at(3)), true);
  assert.equal(isQuiet(night, at(7)), false, 'la fine e\' esclusa');
  assert.equal(isQuiet(night, at(21, 59)), false);
  assert.equal(isQuiet(night, at(22)), true, 'l\'inizio e\' incluso');
  const day = { enabled: true, from: '09:00', to: '12:30' };
  assert.equal(isQuiet(day, at(10)), true);
  assert.equal(isQuiet(day, at(12, 30)), false);
  assert.equal(isQuiet({ enabled: true, from: '08:00', to: '08:00' }, at(8)), false, 'inizio = fine: nessuna fascia');
  assert.equal(isQuiet({ ...night, enabled: false }, at(23)), false);
  assert.equal(isQuiet(null, at(23)), false);
  assert.deepEqual(normalizeQuiet({ enabled: true, from: '22:00', to: '07:00' }), night);
  assert.deepEqual(normalizeQuiet({ enabled: false }), { enabled: false, from: '22:00', to: '07:00' });
  assert.equal(normalizeQuiet({ enabled: true, from: '7:00', to: '07:00' }), null);
  assert.equal(normalizeQuiet({ enabled: 1 }), null);
  assert.equal(normalizeQuiet('x'), null);
});
