// Pure PWA logic for phase 2 (no DOM): answer state, error messages, iOS viewport.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeActionError,
  describeAnswerResult,
  describeMessageResult,
  shouldRefreshAfter,
} from '../../pwa/js/action-errors.js';
import { AnswerState, FREEFORM_MAX, optionBadge } from '../../pwa/js/answers.js';
import { initI18n } from '../../pwa/js/i18n/index.js';
import { bottomShift, classifyTap, keyboardHeight } from '../../pwa/js/viewport.js';

await initI18n({ preference: 'en', browserLanguages: [] });

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

test('AnswerState: single choice, tapping selected option again does not clear; another replaces it', () => {
  const s = new AnswerState(single);
  assert.equal(s.isComplete(), false);
  assert.equal(s.missing(), 1);
  assert.equal(s.toggle('q1', 'b'), true);
  assert.equal(s.toggle('q1', 'b'), true);
  assert.equal(s.isSelected('q1', 'b'), true, 'unlike Cursor, a second tap here does not deselect');
  s.toggle('q1', 'c');
  assert.equal(s.isSelected('q1', 'b'), false);
  assert.equal(s.isSelected('q1', 'c'), true);
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: ['c'], freeform: '' }]);
  assert.equal(s.isComplete(), true);
});

test('AnswerState: "Other" in single choice clears options, and vice versa', () => {
  const s = new AnswerState(single);
  s.toggle('q1', 'a');
  assert.equal(s.toggleOther('q1'), true);
  assert.equal(s.isSelected('q1', 'a'), false);
  assert.equal(s.isComplete(), false, 'without "Other" text it is not a complete answer');
  s.setText('q1', '   ');
  assert.equal(s.isComplete(), false, 'whitespace alone does not count');
  s.setText('q1', '  la mia idea  ');
  assert.equal(s.isComplete(), true);
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: [], freeform: 'la mia idea' }]);
  s.toggle('q1', 'b');
  assert.equal(s.isOther('q1'), false, 'choosing an option closes "Other"');
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: ['b'], freeform: '' }], 'text omitted when "Other" is closed');
});

test('AnswerState: multiple choice, options in question order and "Other" in addition', () => {
  const s = new AnswerState(multi);
  s.toggle('q1', 'c');
  s.toggle('q1', 'a');
  assert.deepEqual(s.payload()[0].optionIds, ['a', 'c'], 'order follows question, not tap order');
  s.toggle('q1', 'c');
  assert.deepEqual(s.payload()[0].optionIds, ['a'], 'in multiple choice second tap removes');
  s.toggle('q1', 'a');
  assert.equal(s.isComplete(), false, 'no selection');
  s.toggle('q1', 'b');
  assert.equal(s.toggleOther('q1'), true);
  assert.equal(s.isComplete(), false, 'open empty "Other" blocks send even with options selected');
  s.setText('q1', 'altro ancora');
  assert.deepEqual(s.payload(), [{ questionId: 'q1', optionIds: ['b'], freeform: 'altro ancora' }]);
  assert.equal(s.toggleOther('q1'), false, 'second tap closes "Other"');
  assert.equal(s.payload()[0].freeform, '');
});

test('AnswerState: multiple questions, missing count', () => {
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

test('AnswerState: unknown ids and empty questions do not break', () => {
  const s = new AnswerState(single);
  assert.equal(s.toggle('nope', 'a'), false);
  assert.equal(s.toggle('q1', 'zzz'), false);
  assert.equal(s.toggleOther('nope'), false);
  s.setText('nope', 'x');
  assert.equal(s.text('nope'), '');
  assert.equal(s.isSelected('nope', 'a'), false);
  const empty = new AnswerState({ questions: [] });
  assert.equal(empty.isComplete(), false, 'no questions means nothing to send');
  assert.equal(new AnswerState(null).missing(), 0);
});

test('AnswerState: freeform text capped like in the daemon', () => {
  const s = new AnswerState(single);
  s.toggleOther('q1');
  s.setText('q1', 'x'.repeat(FREEFORM_MAX + 500));
  assert.equal(s.text('q1').length, FREEFORM_MAX);
  s.setText('q1', null);
  assert.equal(s.text('q1'), '');
});

test('optionBadge: letters like Cursor, then numbers', () => {
  assert.equal(optionBadge(0), 'A');
  assert.equal(optionBadge(3), 'D');
  assert.equal(optionBadge(25), 'Z');
  assert.equal(optionBadge(26), '27');
});

// ---------------------------------------------------------------- error messages

test('describeActionError: own copy, daemon text, fallback', async () => {
  const { initI18n } = await import('../../pwa/js/i18n/index.js');
  await initI18n({ preference: 'en', browserLanguages: [] });
  assert.match(describeActionError({ code: 'network' }), /unreachable/i);
  assert.match(describeActionError({ code: 'stale', message: 'ignored' }), /refresh and try again/i);
  await initI18n({ preference: 'it', browserLanguages: [] });
  assert.match(describeActionError({ code: 'actions_unavailable', detail: 'unavailable' }), /debug/i);
  assert.match(describeActionError({}), /riprova|retry/i);
  assert.match(describeActionError(null), /riprova|retry/i);
  await initI18n({ preference: 'en', browserLanguages: [] });
});

test('shouldRefreshAfter: only when Mac state changed', () => {
  for (const code of ['stale', 'no_question', 'mismatch', 'already_sent', 'not_found', 'timeout']) {
    assert.equal(shouldRefreshAfter({ code }), true, code);
  }
  for (const code of ['network', 'unavailable', 'ui_failed', undefined]) {
    assert.equal(shouldRefreshAfter({ code }), false, String(code));
  }
  assert.equal(shouldRefreshAfter(undefined), false);
});

test('describeAnswerResult and describeMessageResult: confirmed, unconfirmed, queued', () => {
  assert.equal(describeAnswerResult({ ok: true, verified: true }), 'Answer sent.');
  assert.match(describeAnswerResult({ ok: true, verified: false }), /cannot confirm yet/i);
  assert.match(describeAnswerResult({ ok: true, verified: true, warning: 'differs' }), /different choice/);
  assert.equal(describeMessageResult({ ok: true, verified: true }), 'Message sent.');
  assert.match(describeMessageResult({ ok: true, verified: true, queued: true }), /queued/);
  assert.match(describeMessageResult({ ok: true, verified: false }), /cannot confirm yet/i);
});

// ---------------------------------------------------------------- viewport

const tap = (over = {}) => ({ x: 100, y: 200, t: 1000, moved: 0, duration: 80, ...over });

test('classifyTap: first tap passes and is remembered', () => {
  const t = tap();
  assert.deepEqual(classifyTap(null, t), { double: false, remember: t });
});

test('classifyTap: second nearby tap is double tap and clears memory', () => {
  const first = tap();
  const r = classifyTap(first, tap({ t: 1250, x: 110, y: 205 }));
  assert.deepEqual(r, { double: true, remember: null });
  // next tap starts fresh: not a second double
  const third = tap({ t: 1400 });
  assert.deepEqual(classifyTap(r.remember, third), { double: false, remember: third });
});

test('classifyTap: too late or too far is not double tap', () => {
  const first = tap();
  const late = tap({ t: 1000 + 351 });
  assert.deepEqual(classifyTap(first, late), { double: false, remember: late });
  const far = tap({ t: 1100, x: 100 + 60 });
  assert.deepEqual(classifyTap(first, far), { double: false, remember: far });
  const edge = tap({ t: 1350, x: 100 + 36 });
  assert.equal(classifyTap(first, edge).double, true, 'limits are inclusive');
});

test('classifyTap: drags and long presses are not taps and break the sequence', () => {
  const first = tap();
  assert.deepEqual(classifyTap(first, tap({ t: 1100, moved: 40 })), { double: false, remember: null });
  assert.deepEqual(classifyTap(first, tap({ t: 1100, duration: 700 })), { double: false, remember: null });
});

test('keyboardHeight: keyboard, browser bar and pinch', () => {
  const base = { innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, vvScale: 1 };
  assert.equal(keyboardHeight(base), 0);
  assert.equal(keyboardHeight({ ...base, vvHeight: 509 }), 291, 'keyboard open');
  assert.equal(keyboardHeight({ ...base, vvHeight: 750 }), 0, 'browser bar only (50 px)');
  assert.equal(keyboardHeight({ ...base, vvHeight: 400, vvScale: 2 }), 0, 'pinch-zoom: not the keyboard');
  assert.equal(keyboardHeight({ ...base, vvHeight: 509, vvOffsetTop: 100 }), 191, 'with page offset subtract offset');
  assert.equal(keyboardHeight({ innerHeight: 800, vvHeight: 509, vvOffsetTop: 0 }), 291, 'scale defaults to 1');
});

test('bottomShift: bottom bar sticks to visible bottom only when visual viewport moved', () => {
  const base = { innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, vvScale: 1 };
  assert.equal(bottomShift(base), 0, 'aligned: no shift');
  assert.equal(bottomShift({ ...base, vvOffsetTop: 1 }), 0, '1 px tolerance');
  assert.equal(bottomShift({ ...base, vvHeight: 700 }), -100, 'visual viewport ends early: bar moves up');
  assert.equal(bottomShift({ ...base, vvOffsetTop: 40, vvHeight: 800 }), 40, 'visual viewport below layout: bar moves down');
  assert.equal(bottomShift({ ...base, vvHeight: 400, vvScale: 2 }), 0, 'pinch-zoom: no shift');
});

import { isQuiet, normalizeQuiet } from '../src/push/quiet.js';

test('quiet hours: normal window, crossing midnight, empty and invalid values', () => {
  const at = (h, m = 0) => new Date(2026, 9, 15, h, m);
  const night = { enabled: true, from: '22:00', to: '07:00' };
  assert.equal(isQuiet(night, at(23)), true);
  assert.equal(isQuiet(night, at(3)), true);
  assert.equal(isQuiet(night, at(7)), false, 'end is exclusive');
  assert.equal(isQuiet(night, at(21, 59)), false);
  assert.equal(isQuiet(night, at(22)), true, 'start is inclusive');
  const day = { enabled: true, from: '09:00', to: '12:30' };
  assert.equal(isQuiet(day, at(10)), true);
  assert.equal(isQuiet(day, at(12, 30)), false);
  assert.equal(isQuiet({ enabled: true, from: '08:00', to: '08:00' }, at(8)), false, 'start = end: no window');
  assert.equal(isQuiet({ ...night, enabled: false }, at(23)), false);
  assert.equal(isQuiet(null, at(23)), false);
  assert.deepEqual(normalizeQuiet({ enabled: true, from: '22:00', to: '07:00' }), night);
  assert.deepEqual(normalizeQuiet({ enabled: false }), { enabled: false, from: '22:00', to: '07:00' });
  assert.equal(normalizeQuiet({ enabled: true, from: '7:00', to: '07:00' }), null);
  assert.equal(normalizeQuiet({ enabled: 1 }), null);
  assert.equal(normalizeQuiet('x'), null);
});
