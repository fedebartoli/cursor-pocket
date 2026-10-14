// Push notifications: compose the message, send to all subscriptions, dedupe and prune expired ones.
//
// Logs NEVER contain chat text, endpoints, or keys: counts only (see src/log.js).
import { sendPush, generateVapidKeys } from './webpush.js';
import { effectiveLanguage, tm, toolActionKey } from '../i18n.js';
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
   * @param {Function} [p.send]   injectable in tests (default: sendPush)
   * @param {() => number} [p.badge] number of chats needing attention (for icon badge)
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

  /** VAPID keys: generated on first run and stored (mode 0600). */
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

  #where(chat, lang) {
    const name = oneLine(chat.name, 70) || tm(lang, 'push.untitled');
    const ws = oneLine(chat.workspaceName, 40) || tm(lang, 'push.noFolder');
    return `${name} - ${ws}`;
  }

  /** Build title/body/destination for a watcher event. */
  compose(event, lang = 'en') {
    const chat = event.chat;
    const where = this.#where(chat, lang);
    const base = { tag: `chat-${chat.id}`, url: `/#/chat/${encodeURIComponent(chat.id)}`, badge: this.#badge() };
    if (event.type === 'attention') {
      const a = event.attention;
      if (a.kind === 'question') {
        const prompt = oneLine(a.title || a.prompt, 120);
        return { ...base, kind: 'question', title: tm(lang, 'push.title.question'), body: prompt ? `${where}\n${prompt}` : where };
      }
      if (a.kind === 'approval') {
        // Action TYPE only (command, edit, MCP...): never the raw command on the lock screen.
        return {
          ...base,
          kind: 'approval',
          title: tm(lang, 'push.title.approval'),
          body: `${where}\n${tm(lang, toolActionKey(a.toolName))}`,
        };
      }
      // The watcher notifies questions and approvals only (FINDINGS 9.1, 11); unknown types get a generic message.
      return { ...base, kind: 'attention', title: tm(lang, 'push.title.attention'), body: where };
    }
    if (event.type === 'done') return { ...base, kind: 'done', title: tm(lang, 'push.title.done'), body: where };
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
        if (attempt >= RETRY_DELAYS_MS.length) return { outcome: 'failed', status: 0, error: err?.name || 'error' };
      }
      await this.#sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  async #broadcast(messageForLang, label, extra = {}) {
    const started = this.#now();
    const subs = this.#store.listSubscriptions();
    if (!subs.length) {
      this.#log.info('push_skipped', { reason: 'no subscriptions', kind: label });
      return { sent: 0, failed: 0, removed: 0 };
    }
    const byLang = new Map();
    for (const s of subs) {
      const lang = effectiveLanguage(s.lang);
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push(s);
    }
    let sent = 0;
    let failed = 0;
    let removed = 0;
    for (const [lang, group] of byLang) {
      const message = messageForLang(lang);
      const payload = JSON.stringify(message);
      const topic = message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      const results = await Promise.all(group.map((s) => this.#deliver(s, payload, topic)));
      results.forEach((r, i) => {
        if (r.outcome === 'ok') {
          sent++;
          this.#store.markSubscriptionOk(group[i].endpoint, this.#now());
        } else if (r.outcome === 'gone') {
          removed++;
          this.#store.removeSubscription(group[i].endpoint);
        } else {
          failed++;
          this.#store.markSubscriptionFailed(group[i].endpoint);
        }
      });
    }
    this.#log.info('push_sent', { kind: label, sent, failed, removed, ...extra, sendMs: this.#now() - started });
    return { sent, failed, removed };
  }

  /** Quiet hours (stored in the daemon store). */
  get quiet() {
    return normalizeQuiet(safeJsonParse(this.#store.getMeta('quiet_hours'), null)) ?? { ...DEFAULT_QUIET };
  }
  set quiet(v) {
    const q = normalizeQuiet(v);
    if (!q) throw new Error('invalid quiet hours');
    this.#store.setMeta('quiet_hours', JSON.stringify(q));
  }

  /** Why this event is not notified (muted chat/project, quiet hours), or null. */
  #silencedReason(event) {
    const prefs = this.#store.chatPrefs();
    if (prefs.get(event.chat.id)?.muted) return 'chat silenziata';
    if (event.chat.sectionId && prefs.get(`ws:${event.chat.sectionId}`)?.muted) return 'progetto silenziato';
    if (isQuiet(this.quiet, new Date(this.#now()))) return 'orario senza notifiche';
    return null;
  }

  /** Send the notification for an event (once per `dedupeKey`). */
  async notify(event) {
    const now = this.#now();
    if (this.#store.hasNotified(event.dedupeKey)) return { skipped: 'duplicato' };
    this.#store.markNotified(event.dedupeKey, now);
    // Marked notified even when silenced: unmuting must not trigger a burst of old notifications.
    const silenced = this.#silencedReason(event);
    if (silenced) {
      this.#log.info('push_skipped', { reason: silenced, kind: event.type });
      return { skipped: silenced };
    }
    const sample = this.compose(event, 'en');
    // Log the TYPE (domanda, approvazione, finita), never content: shows what was sent and when.
    // `detectMs`: from bubble start until the daemon notified; `sendMs`: send duration.
    const detectMs = Number.isFinite(event.since) ? Math.max(0, event.at - event.since) : undefined;
    return this.#broadcast((lang) => this.compose(event, lang), sample.kind, { detectMs });
  }

  /** Test notification (not deduplicated); each subscription receives text in its stored language. */
  async sendTest() {
    return this.#broadcast(
      (lang) => ({
        kind: 'info',
        title: tm(lang, 'push.test.title'),
        body: tm(lang, 'push.test.body'),
        tag: 'test',
        url: '/#/',
        badge: this.#badge(),
      }),
      'test',
    );
  }
}
