// User-facing messages for action errors (answer, skip, message). Pure logic (testable in Node).
//
// The daemon returns English defaults plus stable codes; the PWA translates via error.<detail> or error.<code>.
import { hasMessage, t } from './i18n/index.js';

const CUSTOM_CODES = Object.freeze(['network', 'stale', 'already_sent', 'too_large', 'too_long', 'not_image', 'bad_name', 'http']);

/** Codes after which reloading state is worthwhile (the situation on the Mac changed). */
const REFRESH_AFTER = new Set(['stale', 'no_question', 'mismatch', 'already_sent', 'not_found', 'not_running', 'timeout']);

export function describeActionError(err) {
  const detail = err?.detail;
  const code = err?.code;
  const params = err?.params ?? {};
  if (detail && hasMessage(`error.${detail}`)) return t(`error.${detail}`, params);
  if (code && hasMessage(`error.${code}`)) return t(`error.${code}`, params);
  if (code && CUSTOM_CODES.includes(code)) return t(`actionErrors.${code}`);
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';
  return msg || t('actionErrors.generic');
}

export const shouldRefreshAfter = (err) => REFRESH_AFTER.has(err?.code);

/** Successful send outcome -> user-facing text. `res`: daemon response. */
export function describeAnswerResult(res) {
  if (res?.warning === 'differs') return t('actionErrors.answerDiffers');
  if (res?.verified === false) return t('actionErrors.answerUnverified');
  return t('actionErrors.answerOk');
}

export function describeMessageResult(res) {
  if (res?.queued) return t('actionErrors.messageQueued');
  if (res?.verified === false) return t('actionErrors.messageUnverified');
  return t('actionErrors.messageOk');
}
