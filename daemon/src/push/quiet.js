// "Quiet hours": a daily window (e.g. 22:00 - 07:00, including across midnight) when the daemon
// does not send push. Requests stay visible in the app; nothing is queued for later.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DEFAULT_QUIET = Object.freeze({ enabled: false, from: '22:00', to: '07:00' });

/** Validate and normalize `{enabled, from, to}` (null if invalid). */
export function normalizeQuiet(v) {
  if (!v || typeof v !== 'object' || typeof v.enabled !== 'boolean') return null;
  const from = typeof v.from === 'string' ? v.from : DEFAULT_QUIET.from;
  const to = typeof v.to === 'string' ? v.to : DEFAULT_QUIET.to;
  if (!HHMM.test(from) || !HHMM.test(to)) return null;
  return { enabled: v.enabled, from, to };
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** True if `date` (Mac local time) falls in the window. If start equals end, the window is empty. */
export function isQuiet(q, date) {
  if (!q?.enabled) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const a = minutes(q.from);
  const b = minutes(q.to);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}
