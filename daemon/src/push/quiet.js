// "Orari senza notifiche": una fascia giornaliera (es. 22:00 - 07:00, anche a cavallo della mezzanotte) in cui il daemon
// non invia push. Le richieste restano visibili nell'app; niente viene accodato e rinviato.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DEFAULT_QUIET = Object.freeze({ enabled: false, from: '22:00', to: '07:00' });

/** Valida e normalizza `{enabled, from, to}` (null se non valido). */
export function normalizeQuiet(v) {
  if (!v || typeof v !== 'object' || typeof v.enabled !== 'boolean') return null;
  const from = typeof v.from === 'string' ? v.from : DEFAULT_QUIET.from;
  const to = typeof v.to === 'string' ? v.to : DEFAULT_QUIET.to;
  if (!HHMM.test(from) || !HHMM.test(to)) return null;
  return { enabled: v.enabled, from, to };
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Vero se `date` (ora locale del Mac) cade nella fascia. Con inizio = fine la fascia e' vuota. */
export function isQuiet(q, date) {
  if (!q?.enabled) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const a = minutes(q.from);
  const b = minutes(q.to);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b;
}
