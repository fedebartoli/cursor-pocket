// Web Push senza dipendenze: cifratura RFC 8291 (aes128gcm, RFC 8188) + VAPID RFC 8292 (ES256), solo `node:crypto`.
//
// iOS (>= 16.4) richiede: PWA aggiunta alla schermata Home, HTTPS, e che OGNI push mostri una notifica
// (userVisibleOnly): il service worker deve sempre chiamare showNotification().
import crypto from 'node:crypto';
import { b64u } from '../util.js';

const RECORD_SIZE = 4096;
const TAG_LEN = 16;
const HEADER_LEN = 16 + 4 + 1 + 65; // salt + rs + idlen + keyid (chiave pubblica non compressa)
/** Dimensione massima del payload in chiaro: il body cifrato totale non deve superare 4096 byte. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_LEN - TAG_LEN - 1;

function hkdf(salt, ikm, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * Cifra un payload per un user agent (RFC 8291, sezione 3).
 * @param {object} p
 * @param {Buffer} p.payload     testo in chiaro
 * @param {Buffer} p.uaPublic    chiave pubblica P-256 del browser (65 byte, `p256dh`)
 * @param {Buffer} p.authSecret  segreto di autenticazione del browser (16 byte, `auth`)
 * @param {Buffer} [p.salt]      sale di 16 byte (solo per i test)
 * @param {crypto.ECDH} [p.asEcdh] coppia di chiavi effimera dell'application server (solo per i test)
 * @returns {Buffer} corpo della richiesta (`Content-Encoding: aes128gcm`)
 */
export function encryptPayload({ payload, uaPublic, authSecret, salt = crypto.randomBytes(16), asEcdh = null }) {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new RangeError('payload push troppo grande');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new TypeError('chiave p256dh non valida');
  if (authSecret.length !== 16) throw new TypeError('segreto auth non valido');
  if (salt.length !== 16) throw new TypeError('salt non valido');

  let ecdh = asEcdh;
  if (!ecdh) {
    ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0" || ua_public || as_public, L=32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  // RFC 8188: CEK e NONCE derivati dal sale del messaggio.
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

  // Un solo record: dati || 0x02 (delimitatore dell'ultimo record).
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** Genera una coppia di chiavi VAPID (ES256, P-256). `publicKey` e' la chiave grezza non compressa in base64url. */
export function generateVapidKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), b64u.decode(pub.x), b64u.decode(pub.y)]);
  return { privateJwk: priv, publicKey: b64u.encode(raw) };
}

/** Valore dell'intestazione `Authorization` (RFC 8292): `vapid t=<jwt>, k=<chiave pubblica>`. */
export function vapidAuthorization({ endpoint, subject, publicKey, privateJwk, now = Date.now(), lifetimeSeconds = 12 * 3600 }) {
  const aud = new URL(endpoint).origin;
  const head = b64u.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + lifetimeSeconds, sub: subject }));
  const input = `${head}.${claims}`;
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u.encode(sig)}, k=${publicKey}`;
}

// Servizi push noti: evita che un client autenticato faccia spedire richieste a host arbitrari (SSRF).
const PUSH_HOST_SUFFIXES = [
  '.push.apple.com',
  'fcm.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
];

export function isAllowedPushEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => (s.startsWith('.') ? host.endsWith(s) : host === s));
}

/**
 * Invia una notifica push. Non lancia per errori HTTP: restituisce {ok, status, gone, retryAfter}.
 * `gone` = la sottoscrizione non e' piu' valida (404/410) e va eliminata.
 */
export async function sendPush({
  subscription,
  payload,
  vapid,
  subject,
  ttl = 3600,
  urgency = 'high',
  topic = null,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = 15_000,
}) {
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    return { ok: false, status: 0, gone: false, retryAfter: null, error: 'endpoint non consentito' };
  }
  const body = encryptPayload({
    payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
    uaPublic: b64u.decode(subscription.p256dh),
    authSecret: b64u.decode(subscription.auth),
  });
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthorization({
      endpoint: subscription.endpoint,
      subject,
      publicKey: vapid.publicKey,
      privateJwk: vapid.privateJwk,
      now,
    }),
  };
  // `Topic` sostituisce una notifica ancora non consegnata con la stessa etichetta (max 32 caratteri base64url).
  if (topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.Topic = topic;

  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    await res.arrayBuffer();
  } catch {
    // corpo non necessario
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    retryAfter: res.headers.get('retry-after'),
  };
}
