import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MAX_PAYLOAD_BYTES,
  encryptPayload,
  generateVapidKeys,
  isAllowedPushEndpoint,
  sendPush,
  vapidAuthorization,
} from '../src/push/webpush.js';
import { b64u } from '../src/util.js';

// Test vector from RFC 8291, appendix A.
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEq' +
    'KK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function ecdhFromPrivate(privB64) {
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(b64u.decode(privB64));
  return e;
}

/** Independent decryption (RFC 8188 + 8291) on the user-agent side, for round-trip. */
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey();
  const secret = uaEcdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 0x02, 'last record delimiter');
  return plain.subarray(0, plain.length - 1);
}

test('RFC 8291: vector keys are consistent and ECDH secret matches', () => {
  const as = ecdhFromPrivate(V.asPrivate);
  assert.equal(b64u.encode(as.getPublicKey()), V.asPublic);
  assert.equal(b64u.encode(as.computeSecret(b64u.decode(V.uaPublic))), V.ecdhSecret);
  const ua = ecdhFromPrivate(V.uaPrivate);
  assert.equal(b64u.encode(ua.getPublicKey()), V.uaPublic);
});

test('RFC 8291: encryption reproduces the vector message byte for byte', () => {
  const body = encryptPayload({
    payload: Buffer.from(V.plaintext),
    uaPublic: b64u.decode(V.uaPublic),
    authSecret: b64u.decode(V.authSecret),
    salt: b64u.decode(V.salt),
    asEcdh: ecdhFromPrivate(V.asPrivate),
  });
  assert.equal(b64u.encode(body), V.body);
});

test('round-trip: independent decryption with random keys', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  for (const text of ['', 'a', 'Domanda in attesa \u2013 progetto', 'x'.repeat(MAX_PAYLOAD_BYTES)]) {
    const body = encryptPayload({ payload: Buffer.from(text), uaPublic: ua.getPublicKey(), authSecret: auth });
    assert.ok(body.length <= 4096, 'total ciphertext body does not exceed 4096 bytes');
    assert.equal(decrypt(body, ua, auth).toString(), text);
  }
});

test('oversized payload or invalid keys are rejected', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  assert.throws(() => encryptPayload({ payload: Buffer.alloc(MAX_PAYLOAD_BYTES + 1), uaPublic: ua.getPublicKey(), authSecret: auth }), RangeError);
  assert.throws(() => encryptPayload({ payload: Buffer.from('x'), uaPublic: Buffer.alloc(65), authSecret: auth }), TypeError);
  assert.throws(() => encryptPayload({ payload: Buffer.from('x'), uaPublic: ua.getPublicKey(), authSecret: Buffer.alloc(8) }), TypeError);
});

test('VAPID: JWT is valid ES256 and verifiable with public key', () => {
  const keys = generateVapidKeys();
  assert.equal(b64u.decode(keys.publicKey).length, 65);
  const now = 1_700_000_000_000;
  const header = vapidAuthorization({
    endpoint: 'https://web.push.apple.com/abc123',
    subject: 'mailto:me@example.com',
    publicKey: keys.publicKey,
    privateJwk: keys.privateJwk,
    now,
  });
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, 'format `vapid t=<jwt>, k=<key>`');
  const [, h, c, s, k] = m;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(b64u.decode(h).toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b64u.decode(c).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:me@example.com');
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: keys.privateJwk.x, y: keys.privateJwk.y }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64u.decode(s));
  assert.equal(ok, true);
});

test('endpoint: only known push services over HTTPS', () => {
  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/x'), true);
  assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'), true);
  assert.equal(isAllowedPushEndpoint('http://web.push.apple.com/x'), false);
  assert.equal(isAllowedPushEndpoint('https://evil.example.com/x'), false);
  assert.equal(isAllowedPushEndpoint('https://web.push.apple.com.evil.example/x'), false);
  assert.equal(isAllowedPushEndpoint('https://user:pw@web.push.apple.com/x'), false);
  assert.equal(isAllowedPushEndpoint('https://127.0.0.1/x'), false);
  assert.equal(isAllowedPushEndpoint('not a url'), false);
});

test('sendPush: correct headers, 410 = expired subscription, disallowed endpoint never called', async () => {
  const keys = generateVapidKeys();
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/tok', p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(auth) };

  let seen;
  const fetchOk = async (url, init) => {
    seen = { url, init };
    return new Response(null, { status: 201 });
  };
  const r = await sendPush({ subscription: sub, payload: 'ciao', vapid: keys, subject: 'mailto:me@example.com', topic: 'chat-abc', fetchImpl: fetchOk });
  assert.deepEqual({ ok: r.ok, status: r.status, gone: r.gone }, { ok: true, status: 201, gone: false });
  assert.equal(seen.url, sub.endpoint);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.TTL, '3600');
  assert.equal(seen.init.headers.Topic, 'chat-abc');
  assert.match(seen.init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.equal(decrypt(seen.init.body, ua, auth).toString(), 'ciao');

  const gone = await sendPush({ subscription: sub, payload: 'x', vapid: keys, subject: 'mailto:me@example.com', fetchImpl: async () => new Response(null, { status: 410 }) });
  assert.equal(gone.gone, true);

  let called = false;
  const blocked = await sendPush({
    subscription: { ...sub, endpoint: 'https://evil.example.com/x' },
    payload: 'x',
    vapid: keys,
    subject: 'mailto:me@example.com',
    fetchImpl: async () => {
      called = true;
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(called, false);
});
