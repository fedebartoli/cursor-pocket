// PWA time formatting (pure module, no DOM).
import assert from 'node:assert/strict';
import test from 'node:test';
import { fullDate, plural, timeAgo } from '../../pwa/js/format.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Noon on an arbitrary day (local time): far from day boundaries and DST shifts.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

test('timeAgo: now, minutes and hours (always floored)', () => {
  assert.equal(timeAgo(NOW - 10_000, NOW), 'adesso');
  assert.equal(timeAgo(NOW - 44_000, NOW), 'adesso');
  assert.equal(timeAgo(NOW - 50_000, NOW), '1 min fa');
  assert.equal(timeAgo(NOW - 5 * MIN, NOW), '5 min fa');
  assert.equal(timeAgo(NOW - (59 * MIN + 40_000), NOW), '59 min fa', 'must not round up to 60 min');
  assert.equal(timeAgo(NOW - HOUR, NOW), '1 h fa');
  assert.equal(timeAgo(NOW - (3 * HOUR + 40 * MIN), NOW), '3 h fa');
});

test('timeAgo: yesterday, days, date', () => {
  assert.equal(timeAgo(new Date(2026, 5, 14, 23, 0).getTime(), NOW), 'ieri');
  assert.equal(timeAgo(new Date(2026, 5, 14, 1, 0).getTime(), NOW), 'ieri');
  assert.equal(timeAgo(new Date(2026, 5, 12, 9, 0).getTime(), NOW), '3 giorni fa');
  assert.equal(timeAgo(new Date(2026, 5, 9, 9, 0).getTime(), NOW), '6 giorni fa');
  assert.match(timeAgo(new Date(2026, 5, 1, 9, 0).getTime(), NOW), /^1 giu/);
  assert.match(timeAgo(new Date(2025, 11, 20, 9, 0).getTime(), NOW), /2025/, 'different year: shown');
  assert.equal(timeAgo(0, NOW), '');
  assert.equal(timeAgo(undefined, NOW), '');
});

test('timeAgo: phone clock behind (future) does not produce odd text', () => {
  assert.equal(timeAgo(NOW + 5 * MIN, NOW), 'adesso');
});

test('plural and fullDate', () => {
  assert.equal(plural(1, 'chat', 'chat'), '1 chat');
  assert.equal(plural(2, 'domanda', 'domande'), '2 domande');
  assert.equal(plural(1, 'domanda', 'domande'), '1 domanda');
  assert.equal(fullDate(0), '');
  assert.match(fullDate(NOW), /2026/);
});
