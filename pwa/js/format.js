// Formattazione di orari e conteggi in italiano.
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const dayStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "adesso", "3 min fa", "2 h fa", "ieri", "4 giorni fa", poi la data ("12 ott"). */
export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '';
  const diff = now - ms;
  if (diff < 45_000) return 'adesso';
  if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MIN))} min fa`;
  if (diff < DAY && dayStart(now) === dayStart(ms)) return `${Math.floor(diff / HOUR)} h fa`;
  const days = Math.round((dayStart(now) - dayStart(ms)) / DAY);
  if (days <= 1) return 'ieri';
  if (days < 7) return `${days} giorni fa`;
  const opts = new Date(ms).getFullYear() === new Date(now).getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('it-IT', opts).format(ms);
}

export function fullDate(ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
