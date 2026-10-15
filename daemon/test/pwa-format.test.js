// PWA time formatting (pure module, no DOM).
import assert from 'node:assert/strict';
import test from 'node:test';
import { fullDate, timeAgo } from '../../pwa/js/format.js';
import { initI18n } from '../../pwa/js/i18n/index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Noon on an arbitrary day (local time): far from day boundaries and DST shifts.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

await initI18n({ preference: 'en', browserLanguages: [] });

test('timeAgo: now, minutes and hours (always floored)', () => {
  assert.equal(timeAgo(NOW - 10_000, NOW), 'just now');
  assert.equal(timeAgo(NOW - 44_000, NOW), 'just now');
  assert.equal(timeAgo(NOW - 50_000, NOW), '1 min ago');
  assert.equal(timeAgo(NOW - 5 * MIN, NOW), '5 min ago');
  assert.equal(timeAgo(NOW - (59 * MIN + 40_000), NOW), '59 min ago', 'must not round up to 60 min');
  assert.equal(timeAgo(NOW - HOUR, NOW), '1 h ago');
  assert.equal(timeAgo(NOW - (3 * HOUR + 40 * MIN), NOW), '3 h ago');
});

test('timeAgo: yesterday, days, date', () => {
  assert.equal(timeAgo(new Date(2026, 5, 14, 23, 0).getTime(), NOW), 'yesterday');
  assert.equal(timeAgo(new Date(2026, 5, 14, 1, 0).getTime(), NOW), 'yesterday');
  assert.equal(timeAgo(new Date(2026, 5, 12, 9, 0).getTime(), NOW), '3 days ago');
  assert.equal(timeAgo(new Date(2026, 5, 9, 9, 0).getTime(), NOW), '6 days ago');
  assert.match(timeAgo(new Date(2026, 5, 1, 9, 0).getTime(), NOW), /^Jun 1/);
  assert.match(timeAgo(new Date(2025, 11, 20, 9, 0).getTime(), NOW), /2025/, 'different year: shown');
  assert.equal(timeAgo(0, NOW), '');
  assert.equal(timeAgo(undefined, NOW), '');
});

test('timeAgo: phone clock behind (future) does not produce odd text', () => {
  assert.equal(timeAgo(NOW + 5 * MIN, NOW), 'just now');
});

test('fullDate', () => {
  assert.equal(fullDate(0), '');
  assert.match(fullDate(NOW), /2026/);
});

test('timeAgo follows the selected language (Italian)', async () => {
  await initI18n({ preference: 'it', browserLanguages: [] });
  try {
    assert.equal(timeAgo(NOW - 10_000, NOW), 'adesso');
    assert.equal(timeAgo(NOW - 5 * MIN, NOW), '5 min fa');
    assert.equal(timeAgo(new Date(2026, 5, 14, 23, 0).getTime(), NOW), 'ieri');
    assert.equal(timeAgo(new Date(2026, 5, 12, 9, 0).getTime(), NOW), '3 giorni fa');
    assert.match(timeAgo(new Date(2026, 5, 1, 9, 0).getTime(), NOW), /^1 giu/);
  } finally {
    await initI18n({ preference: 'en', browserLanguages: [] });
  }
});
