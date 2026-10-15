// Relative times and full dates (locale-aware via i18n).
import { getLanguage, t } from './i18n/index.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const dayStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function intlLocale() {
  const lang = getLanguage();
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'en') return 'en-US';
  return lang;
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago", then a short date. */
export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '';
  const diff = now - ms;
  if (diff < 45_000) return t('format.now');
  if (diff < HOUR) return t('format.minutesAgo', { count: Math.max(1, Math.floor(diff / MIN)) });
  if (diff < DAY && dayStart(now) === dayStart(ms)) return t('format.hoursAgo', { count: Math.floor(diff / HOUR) });
  const days = Math.round((dayStart(now) - dayStart(ms)) / DAY);
  if (days <= 1) return t('format.yesterday');
  if (days < 7) return t('format.daysAgo', { count: days });
  const opts = new Date(ms).getFullYear() === new Date(now).getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(intlLocale(), opts).format(ms);
}

export function fullDate(ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}
