// Messaggi in italiano per gli errori delle azioni (risposta, salta, messaggio). Logica pura (si prova in Node).
//
// Il daemon risponde gia' con testi chiari per quasi tutti i codici; qui si sostituiscono solo quelli che dipendono
// da cio' che la schermata fa dopo (es. "ho aggiornato la vista") o che nascono nel client.
const CUSTOM = Object.freeze({
  network: 'Daemon non raggiungibile. Controlla la connessione e riprova.',
  stale: 'La richiesta \u00e8 cambiata o \u00e8 gi\u00e0 stata risolta: ho aggiornato la vista.',
  already_sent: 'Questa richiesta \u00e8 gi\u00e0 stata inviata: attendo che Cursor la registri.',
  too_large: 'Il testo \u00e8 troppo lungo.',
  too_long: 'Il messaggio \u00e8 troppo lungo.',
  http: 'Operazione non riuscita. Riprova.',
});

/** Codici dopo i quali conviene riscaricare lo stato (la situazione sul Mac e' cambiata). */
const REFRESH_AFTER = new Set(['stale', 'no_question', 'mismatch', 'already_sent', 'not_found', 'not_running']);

export function describeActionError(err) {
  const code = err?.code;
  if (code && CUSTOM[code]) return CUSTOM[code];
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';
  return msg || 'Operazione non riuscita. Riprova.';
}

export const shouldRefreshAfter = (err) => REFRESH_AFTER.has(err?.code);

/** Esito di un invio riuscito -> testo per l'utente. `res`: risposta del daemon. */
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
