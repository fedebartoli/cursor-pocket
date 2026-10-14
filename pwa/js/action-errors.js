// Italian messages for action errors (answer, skip, message). Pure logic (testable in Node).
//
// The daemon already returns clear text for almost all codes; here we only replace those that depend on
// what the screen does next (e.g. "I refreshed the view") or that originate in the client.
const CUSTOM = Object.freeze({
  network: 'Daemon non raggiungibile. Controlla la connessione e riprova.',
  stale: 'La richiesta \u00e8 cambiata o \u00e8 gi\u00e0 stata risolta: ho aggiornato la vista.',
  already_sent: 'Questa richiesta \u00e8 gi\u00e0 stata inviata: attendo che Cursor la registri.',
  too_large: 'Il testo \u00e8 troppo lungo.',
  too_long: 'Il messaggio \u00e8 troppo lungo.',
  not_image: 'Formato non supportato: servono JPEG, PNG, GIF o WebP.',
  bad_name: 'Scrivi un nome (massimo 100 caratteri).',
  http: 'Operazione non riuscita. Riprova.',
});

/** Codes after which reloading state is worthwhile (the situation on the Mac changed). */
const REFRESH_AFTER = new Set(['stale', 'no_question', 'mismatch', 'already_sent', 'not_found', 'not_running', 'timeout']);

export function describeActionError(err) {
  const code = err?.code;
  if (code && CUSTOM[code]) return CUSTOM[code];
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';
  return msg || 'Operazione non riuscita. Riprova.';
}

export const shouldRefreshAfter = (err) => REFRESH_AFTER.has(err?.code);

/** Successful send outcome -> user-facing text. `res`: daemon response. */
export function describeAnswerResult(res) {
  if (res?.warning === 'differs') return 'Risposta inviata, ma Cursor ha registrato una scelta diversa. Controlla sul Mac.';
  if (res?.verified === false) return 'Risposta inviata. Non riesco ancora a confermare che Cursor l\u2019abbia registrata.';
  return 'Risposta inviata.';
}

export function describeMessageResult(res) {
  if (res?.queued) return 'Messaggio messo in coda da Cursor: l\u2019agente lo legger\u00e0 al termine del lavoro in corso.';
  if (res?.verified === false) return 'Messaggio inviato. Non riesco ancora a confermare che Cursor lo abbia ricevuto.';
  return 'Messaggio inviato.';
}
