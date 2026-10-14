// Notifiche push: compone il messaggio, lo invia a tutte le sottoscrizioni, deduplica e ripulisce quelle scadute.
//
// I log NON contengono mai testi di chat, endpoint o chiavi: solo conteggi (vedi src/log.js).
import { sendPush, generateVapidKeys } from './webpush.js';
import { toolActionLabel } from '../state/present.js';
import { DEFAULT_QUIET, isQuiet, normalizeQuiet } from './quiet.js';
import { clampStr, safeJsonParse, sleep as realSleep } from '../util.js';

const RETRY_DELAYS_MS = [1000, 4000];

function oneLine(s, max) {
  return clampStr(String(s || '').replace(/\s+/g, ' ').trim(), max);
}

export class Notifier {
  #store;
  #cfg;
  #log;
  #send;
  #now;
  #sleep;
  #badge;
  #vapid = null;

  /**
   * @param {object} p
   * @param {import('../state/store.js').Store} p.store
   * @param {object} p.config
   * @param {object} p.logger
   * @param {Function} [p.send]   sostituibile nei test (default: sendPush)
   * @param {() => number} [p.badge] numero di chat che richiedono attenzione (per il badge dell'icona)
   */
  constructor({ store, config, logger, send = sendPush, now = Date.now, sleep = realSleep, badge = () => 0 }) {
    this.#store = store;
    this.#cfg = config;
    this.#log = logger;
    this.#send = send;
    this.#now = now;
    this.#sleep = sleep;
    this.#badge = badge;
  }

  /** Chiavi VAPID: generate al primo avvio e salvate nello store (permessi 0600). */
  get vapid() {
    if (this.#vapid) return this.#vapid;
    const pub = this.#store.getMeta('vapid_public');
    const priv = safeJsonParse(this.#store.getMeta('vapid_private_jwk'), null);
    if (pub && priv) {
      this.#vapid = { publicKey: pub, privateJwk: priv };
    } else {
      const k = generateVapidKeys();
      this.#store.setMeta('vapid_public', k.publicKey);
      this.#store.setMeta('vapid_private_jwk', JSON.stringify(k.privateJwk));
      this.#vapid = k;
      this.#log.info('vapid_generated');
    }
    return this.#vapid;
  }

  get publicKey() {
    return this.vapid.publicKey;
  }

  /** Compone titolo/testo/destinazione per un evento del watcher. */
  compose(event) {
    const chat = event.chat;
    const where = `${oneLine(chat.name, 70)} - ${oneLine(chat.workspaceName, 40)}`;
    const base = { tag: `chat-${chat.id}`, url: `/#/chat/${encodeURIComponent(chat.id)}`, badge: this.#badge() };
    if (event.type === 'attention') {
      const a = event.attention;
      if (a.kind === 'domanda') {
        const prompt = oneLine(a.title || a.prompt, 120);
        return { ...base, kind: 'domanda', title: 'Domanda in attesa', body: prompt ? `${where}\n${prompt}` : where };
      }
      if (a.kind === 'approvazione') {
        // Solo il TIPO di azione (comando, modifica, MCP...): mai il comando in chiaro sul blocco schermo.
        return { ...base, kind: 'approvazione', title: 'Approvazione richiesta', body: `${where}\n${toolActionLabel(a.toolName)}` };
      }
      // Il watcher notifica solo domande e approvazioni (FINDINGS 9.1, 11); un tipo sconosciuto riceve un messaggio generico.
      return { ...base, kind: 'attenzione', title: 'Richiede attenzione', body: where };
    }
    if (event.type === 'done') return { ...base, kind: 'finita', title: 'Chat finita', body: where };
    return { ...base, kind: 'info', title: 'Cursor Pocket', body: where };
  }

  async #deliver(sub, payload, topic) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.#send({
          subscription: sub,
          payload,
          vapid: this.vapid,
          subject: this.#cfg.vapidSubject,
          topic,
          now: this.#now(),
        });
        if (r.ok) return { outcome: 'ok' };
        if (r.gone) return { outcome: 'gone' };
        const transient = r.status === 429 || r.status >= 500;
        if (!transient || attempt >= RETRY_DELAYS_MS.length) return { outcome: 'failed', status: r.status };
      } catch (err) {
        if (attempt >= RETRY_DELAYS_MS.length) return { outcome: 'failed', status: 0, error: err?.name || 'errore' };
      }
      await this.#sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  async #broadcast(message, label, extra = {}) {
    const started = this.#now();
    const subs = this.#store.listSubscriptions();
    if (!subs.length) {
      this.#log.info('push_skipped', { reason: 'nessuna sottoscrizione', kind: label });
      return { sent: 0, failed: 0, removed: 0 };
    }
    const payload = JSON.stringify(message);
    const topic = message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const results = await Promise.all(subs.map((s) => this.#deliver(s, payload, topic)));
    let sent = 0;
    let failed = 0;
    let removed = 0;
    results.forEach((r, i) => {
      if (r.outcome === 'ok') {
        sent++;
        this.#store.markSubscriptionOk(subs[i].endpoint, this.#now());
      } else if (r.outcome === 'gone') {
        removed++;
        this.#store.removeSubscription(subs[i].endpoint);
      } else {
        failed++;
        this.#store.markSubscriptionFailed(subs[i].endpoint);
      }
    });
    this.#log.info('push_sent', { kind: label, sent, failed, removed, ...extra, sendMs: this.#now() - started });
    return { sent, failed, removed };
  }

  /** Orari senza notifiche (salvati nello store del daemon). */
  get quiet() {
    return normalizeQuiet(safeJsonParse(this.#store.getMeta('quiet_hours'), null)) ?? { ...DEFAULT_QUIET };
  }
  set quiet(v) {
    const q = normalizeQuiet(v);
    if (!q) throw new Error('orari non validi');
    this.#store.setMeta('quiet_hours', JSON.stringify(q));
  }

  /** Perche' questo evento non va notificato (chat o progetto silenziati, fascia oraria), o null. */
  #silencedReason(event) {
    const prefs = this.#store.chatPrefs();
    if (prefs.get(event.chat.id)?.muted) return 'chat silenziata';
    if (event.chat.sectionId && prefs.get(`ws:${event.chat.sectionId}`)?.muted) return 'progetto silenziato';
    if (isQuiet(this.quiet, new Date(this.#now()))) return 'orario senza notifiche';
    return null;
  }

  /** Invia la notifica di un evento (una sola volta per `dedupeKey`). */
  async notify(event) {
    const now = this.#now();
    if (this.#store.hasNotified(event.dedupeKey)) return { skipped: 'duplicato' };
    this.#store.markNotified(event.dedupeKey, now);
    // Segnato come gia' notificato anche se silenziato: togliendo il silenzio non arriva una raffica di notifiche vecchie.
    const silenced = this.#silencedReason(event);
    if (silenced) {
      this.#log.info('push_skipped', { reason: silenced, kind: event.type });
      return { skipped: silenced };
    }
    const message = this.compose(event);
    // Nel log va il TIPO (domanda, approvazione, finita), mai il contenuto: serve a capire cosa e' partito e quando.
    // `detectMs`: dall'inizio della richiesta (bubble) a quando il daemon l'ha notificata; `sendMs`: durata dell'invio.
    const detectMs = Number.isFinite(event.since) ? Math.max(0, event.at - event.since) : undefined;
    return this.#broadcast(message, message.kind, { detectMs });
  }

  /** Notifica di prova (non deduplicata). */
  async sendTest() {
    const message = {
      kind: 'info',
      title: 'Notifica di prova',
      body: 'Le notifiche di Cursor Pocket funzionano.',
      tag: 'test',
      url: '/#/',
      badge: this.#badge(),
    };
    return this.#broadcast(message, 'test');
  }
}
