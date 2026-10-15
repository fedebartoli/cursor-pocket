// HTTP server (loopback only) with JSON API, SSE stream, and PWA static files.
import http from 'node:http';
import { ActionError } from '../actions.js';
import { clearedCookie, sessionCookie } from '../auth.js';
import { errorFields } from '../log.js';
import { normalizeLanguage } from '../i18n.js';
import { isAllowedPushEndpoint } from '../push/webpush.js';
import { UPLOAD_LIMITS } from '../uploads.js';
import { b64u } from '../util.js';
import { SECURITY_HEADERS, isAllowedHost, isSecureRequest, originMatchesHost, splitUrl } from './security.js';
import { errorJson } from './error-json.js';
import { serveStatic } from './static.js';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_ACTION_BODY_BYTES = 64 * 1024; // free-form messages and answers can be long (non-ASCII: up to 3 bytes per character)
const MAX_SUBSCRIPTIONS = 10;
const CHAT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const KEY_MAX_LEN = 200;

function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

class HttpError extends Error {
  constructor(status, code, message, opts = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (opts.detail) this.detail = opts.detail;
    if (opts.params && Object.keys(opts.params).length) this.params = opts.params;
  }
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.', { detail: 'too_large_request' });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'bad_json', 'Invalid JSON.');
  }
}

function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !isAllowedPushEndpoint(endpoint)) return null;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  const p = b64u.decode(keys.p256dh);
  const a = b64u.decode(keys.auth);
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) return null;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/**
 * @param {object} deps
 * @returns {{server: http.Server, listen: () => Promise<void>, close: () => Promise<void>}}
 */
export function createHttpServer({ config, store, auth, hub, watcher, notifier, actions, awake, compat, uploads = null, logger, now = Date.now }) {
  let lastTestAt = 0;

  async function api(req, res, path, headers, secure) {
    const method = req.method;
    const cookieOpts = { secure };

    // --- public endpoints ---
    if (path === '/api/session' && method === 'GET') {
      return sendJson(res, 200, { authenticated: auth.authenticate(req.headers.cookie) !== null }, headers);
    }
    if (path === '/api/pair' && method === 'POST') {
      if (!originMatchesHost(req)) throw new HttpError(403, 'bad_origin', 'Origin not allowed.');
      const body = await readJson(req);
      const r = auth.pair(body.code, { label: typeof body.label === 'string' ? body.label.slice(0, 60) : null });
      if (!r.ok) {
        logger.warn('pair_failed', { reason: r.reason });
        if (r.reason === 'rate_limited') {
          const secs = Math.ceil((r.retryAfterMs || 0) / 1000);
          res.setHeader('Retry-After', String(secs));
          throw new HttpError(429, 'rate_limited', 'Too many attempts, try again later.');
        }
        throw new HttpError(401, 'invalid_code', 'Invalid or expired code.');
      }
      logger.info('paired');
      return sendJson(res, 200, { ok: true }, { ...headers, 'Set-Cookie': sessionCookie(r.token, cookieOpts) });
    }

    // --- session required from here ---
    const session = auth.authenticate(req.headers.cookie);
    if (!session) throw new HttpError(401, 'unauthorized', 'Invalid session.');
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && !originMatchesHost(req)) throw new HttpError(403, 'bad_origin', 'Origin not allowed.');

    if (path === '/api/state' && method === 'GET') {
      const cur = hub.current;
      return sendJson(res, 200, cur ?? { version: 0, state: null, status: { ok: false, error: 'starting' } }, headers);
    }
    if (path === '/api/events' && method === 'GET') {
      return hub.addClient(req, res, headers);
    }
    if (path === '/api/info' && method === 'GET') {
      return sendJson(
        res,
        200,
        {
          pendingAfterHours: Math.round(config.pendingAfterMs / 3_600_000),
          pollMs: config.pollMs,
          subscriptions: store.countSubscriptions(),
          lastScanAt: watcher.status.lastScanAt,
          actions: { ...actions.status, port: config.cdpPort },
          // Codes only (no content): why the database layout looks different, and which Cursor release is installed.
          compat: { reasons: compat.status.reasons, version: compat.status.version, versionStatus: compat.status.versionStatus },
        },
        headers,
      );
    }
    if (path === '/api/logout' && method === 'POST') {
      auth.logout(session.tokenHash);
      return sendJson(res, 200, { ok: true }, { ...headers, 'Set-Cookie': clearedCookie(cookieOpts) });
    }

    // --- paired devices ---
    if (path === '/api/devices' && method === 'GET') {
      return sendJson(res, 200, { devices: auth.devices(session.tokenHash) }, headers);
    }
    const dv = /^\/api\/devices\/([0-9a-f]{16})\/revoke$/.exec(path);
    if (dv && method === 'POST') {
      const r = auth.revokeDevice(dv[1], session.tokenHash);
      if (r === 'unknown') throw new HttpError(404, 'not_found', 'Device not found.', { detail: 'not_found_device' });
      if (r === 'current') {
        throw new HttpError(409, 'current_device', 'This is the device you are using: to disconnect it use "Sign out on this device".');
      }
      logger.info('device_revoked');
      return sendJson(res, 200, { ok: true }, headers);
    }

    // --- images to attach to a message (body = raw image bytes) ---
    if (path === '/api/uploads' && method === 'POST') {
      if (!uploads) throw new HttpError(404, 'not_found', 'Not available.', { detail: 'not_found_unavailable' });
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (!type.startsWith('image/')) throw new HttpError(415, 'unsupported_media_type', 'An image is required.', { detail: 'unsupported_media_type_image' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > UPLOAD_LIMITS.bytes) throw new HttpError(413, 'too_large', 'Image is too large (8 MB maximum).', { detail: 'too_large_image' });
        chunks.push(chunk);
      }
      const r = uploads.save(Buffer.concat(chunks));
      if (r.error === 'not_image' || r.error === 'empty') {
        throw new HttpError(415, 'not_image', 'Unsupported format: JPEG, PNG, GIF, or WebP required.');
      }
      if (r.error === 'too_large') throw new HttpError(413, 'too_large', 'Image is too large (8 MB maximum).', { detail: 'too_large_image' });
      if (r.error === 'too_many') throw new HttpError(429, 'too_many', 'Too many pending images: send one or try again shortly.', { detail: 'too_many_uploads' });
      return sendJson(res, 200, { id: r.id, size: r.size }, headers);
    }
    const up = /^\/api\/uploads\/([a-f0-9]{32})$/.exec(path);
    if (up && method === 'DELETE') {
      uploads?.remove([up[1]]);
      return sendJson(res, 200, { ok: true }, headers);
    }

    // --- new (local) chat on a project ---
    if (path === '/api/chats' && method === 'POST') {
      const body = await readJson(req, MAX_ACTION_BODY_BYTES);
      return sendJson(res, 200, await actions.newChat({ sectionId: body.sectionId, text: body.text, images: body.images, branch: body.branch, model: body.model }), headers);
    }

    // --- archived chats ---
    if (path === '/api/archived' && method === 'GET') {
      return sendJson(res, 200, { chats: watcher.archived({ limit: 60 }) }, headers);
    }
    const ar = /^\/api\/archived\/([^/]+)\/restore$/.exec(path);
    if (ar && method === 'POST') {
      if (!CHAT_ID_RE.test(ar[1])) throw new HttpError(400, 'bad_id', 'Invalid identifier.');
      await readJson(req, MAX_ACTION_BODY_BYTES);
      return sendJson(res, 200, await actions.restore(ar[1]), headers);
    }

    // --- chats ---
    const m = /^\/api\/chats\/([^/]+)(?:\/(ignore|answer|message|skip|approval|stop|rename|archive|pin|prefs|history))?$/.exec(path);
    if (m) {
      const id = m[1];
      const action = m[2];
      if (!CHAT_ID_RE.test(id)) throw new HttpError(400, 'bad_id', 'Invalid identifier.');
      const chat = watcher.last?.chats.find((c) => c.id === id);
      if (!chat) throw new HttpError(404, 'not_found', 'Chat not found.', { detail: 'not_found_chat' });

      if (!action && method === 'GET') {
        const card = hub.current?.state?.workspaces.flatMap((w) => w.chats).find((c) => c.id === id);
        watcher.boost(id, 15_000); // viewing this chat: rescan often while the page is open
        const extra = watcher.detail(id) ?? { lastMessage: null, question: null, activity: [], approval: null };
        return sendJson(res, 200, { chat: card ?? null, lastMessage: extra.lastMessage, question: extra.question, activity: extra.activity ?? [], approval: extra.approval ?? null }, headers);
      }
      // Full conversation, paged from the bottom: `?before=<index>&limit=<n>`. Read-only, by index only (never whole chat).
      if (action === 'history' && method === 'GET') {
        const num = (k, dflt, max) => {
          const raw = req.searchParams?.get(k);
          if (raw === null || raw === undefined || raw === '') return dflt;
          if (!/^\d{1,7}$/.test(raw)) throw new HttpError(400, 'bad_query', 'Invalid query parameter.');
          return Math.min(Number(raw), max);
        };
        const page = watcher.history(id, { before: num('before', null, 10_000_000), limit: Math.max(1, num('limit', 30, 60)) });
        if (!page) throw new HttpError(503, 'unavailable', 'The conversation cannot be read right now.', { detail: 'conversation_unreadable' });
        return sendJson(res, 200, page, headers);
      }
      if (action === 'pin' && method === 'GET') return sendJson(res, 200, await actions.pinState(id), headers);
      if (action === 'ignore' && (method === 'POST' || method === 'DELETE')) {
        const body = await readJson(req);
        const key = typeof body.key === 'string' ? body.key : '';
        if (!key || key.length > KEY_MAX_LEN) throw new HttpError(400, 'bad_key', 'Invalid key.');
        if (method === 'POST') {
          // Ignore only the request the user saw: if it changed in the meantime, ignore nothing.
          if (!chat.attention || chat.attention.key !== key) {
            throw new HttpError(409, 'stale', 'The request changed: refresh and try again.', { detail: 'stale_ignore' });
          }
          store.addIgnored(id, key, now());
        } else {
          store.removeIgnored(id, key);
        }
        watcher.recompute();
        return sendJson(res, 200, { ok: true, version: hub.current?.version ?? 0 }, headers);
      }
      // Local prefs (favorite, muted): do not touch Cursor.
      if (action === 'prefs' && method === 'POST') {
        const body = await readJson(req);
        const patch = {};
        for (const k of ['favorite', 'muted']) {
          if (body[k] === undefined) continue;
          if (typeof body[k] !== 'boolean') throw new HttpError(400, 'bad_prefs', 'Invalid preference.', { detail: 'bad_prefs_invalid' });
          patch[k] = body[k];
        }
        if (!Object.keys(patch).length) throw new HttpError(400, 'bad_prefs', 'No preference specified.', { detail: 'bad_prefs_none' });
        const prefs = store.setChatPrefs(id, patch, now());
        watcher.recompute();
        return sendJson(res, 200, { ok: true, ...prefs }, headers);
      }
      // Actions toward Cursor (Phase 2): answer, skip, send a message.
      if ((action === 'answer' || action === 'message' || action === 'skip' || action === 'approval' || action === 'stop' || action === 'rename' || action === 'archive' || action === 'pin') && method === 'POST') {
        const body = await readJson(req, MAX_ACTION_BODY_BYTES);
        let result;
        if (action === 'answer') result = await actions.answer(id, { key: body.key, answers: body.answers });
        else if (action === 'skip') result = await actions.skip(id, { key: body.key });
        else if (action === 'stop') result = await actions.stopAgent(id);
        else if (action === 'rename') result = await actions.rename(id, { name: body.name });
        else if (action === 'archive') result = await actions.archive(id);
        else if (action === 'pin') result = await actions.pin(id, { pinned: body.pinned });
        else if (action === 'approval') result = await actions.approval(id, { key: body.key, decision: body.decision });
        else result = await actions.sendMessage(id, { text: body.text, images: body.images });
        return sendJson(res, 200, result, headers);
      }
      throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    }

    // Options for a project's new chat (branch, model), read from Cursor.
    const nco = /^\/api\/projects\/([\w-]{1,80})\/newchat-options$/.exec(path);
    if (nco && method === 'GET') return sendJson(res, 200, await actions.newChatOptions(nco[1]), headers);

    // --- notification prefs ---
    const wsm = /^\/api\/workspaces\/([\w-]{1,80})\/prefs$/.exec(path);
    if (wsm && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.muted !== 'boolean') throw new HttpError(400, 'bad_prefs', 'Invalid preference.', { detail: 'bad_prefs_invalid' });
      const known = watcher.last?.chats.some((c) => c.sectionId === wsm[1]);
      if (!known) throw new HttpError(404, 'not_found', 'Project not found.', { detail: 'not_found_project' });
      const prefs = store.setChatPrefs(`ws:${wsm[1]}`, { muted: body.muted }, now());
      watcher.recompute();
      return sendJson(res, 200, { ok: true, muted: prefs.muted }, headers);
    }
    if (path === '/api/settings/quiet') {
      if (method === 'GET') return sendJson(res, 200, notifier.quiet, headers);
      if (method === 'POST') {
        const body = await readJson(req);
        try {
          notifier.quiet = body;
        } catch {
          throw new HttpError(400, 'bad_quiet', 'Invalid quiet hours (use HH:MM format).');
        }
        return sendJson(res, 200, notifier.quiet, headers);
      }
    }

    // --- keep Mac awake while an agent works ---
    if (path === '/api/settings/awake') {
      if (method === 'GET') return sendJson(res, 200, await awake.describe(), headers);
      if (method === 'POST') {
        const body = await readJson(req);
        const keys = ['enabled', 'closed', 'dim'].filter((k) => body[k] !== undefined);
        if (!keys.length || keys.some((k) => typeof body[k] !== 'boolean')) throw new HttpError(400, 'bad_awake', 'Invalid value.');
        const before = await awake.describe();
        if (!before.supported) throw new HttpError(409, 'awake_unsupported', 'This feature is not available on this computer.');
        if (body.closed === true && !before.closed.available) {
          throw new HttpError(
            409,
            'awake_closed_unavailable',
            'One-time setup on your Mac is required first (tools/mac/power-setup.sh, see How it works).',
          );
        }
        if (body.dim === true && !before.dim.available) {
          throw new HttpError(409, 'awake_dim_unavailable', 'The brightness helper is missing (tools/mac/build.sh, see How it works).');
        }
        if (body.enabled !== undefined) awake.enabled = body.enabled;
        if (body.closed !== undefined) awake.closedEnabled = body.closed;
        if (body.dim !== undefined) awake.dimEnabled = body.dim;
        logger.info('keep_awake_setting', Object.fromEntries(keys.map((k) => [k, body[k]])));
        return sendJson(res, 200, await awake.describe(), headers);
      }
    }

    // --- push ---
    if (path === '/api/push/public-key' && method === 'GET') {
      return sendJson(res, 200, { publicKey: notifier.publicKey }, headers);
    }
    if (path === '/api/push/subscribe' && method === 'POST') {
      const body = await readJson(req);
      const sub = validSubscription(body.subscription);
      if (!sub) throw new HttpError(400, 'bad_subscription', 'Invalid subscription.');
      const known = store.listSubscriptions().some((s) => s.endpoint === sub.endpoint);
      if (!known && store.countSubscriptions() >= MAX_SUBSCRIPTIONS) {
        throw new HttpError(409, 'too_many', 'Too many registered devices.', { detail: 'too_many_devices' });
      }
      const extra = {};
      if ('lang' in body) {
        const lang = normalizeLanguage(body.lang);
        if (lang) extra.lang = lang;
      }
      store.upsertSubscription(sub, session.tokenHash, now(), extra);
      logger.info('push_subscribed');
      return sendJson(res, 200, { ok: true }, headers);
    }
    if (path === '/api/push/unsubscribe' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.endpoint === 'string') store.removeSubscription(body.endpoint);
      return sendJson(res, 200, { ok: true }, headers);
    }
    if (path === '/api/push/status' && method === 'POST') {
      const body = await readJson(req);
      const subscribed = typeof body.endpoint === 'string' && store.listSubscriptions().some((s) => s.endpoint === body.endpoint);
      return sendJson(res, 200, { subscribed, total: store.countSubscriptions() }, headers);
    }
    if (path === '/api/push/test' && method === 'POST') {
      if (now() - lastTestAt < 5000) throw new HttpError(429, 'too_fast', 'Wait a few seconds.');
      lastTestAt = now();
      return sendJson(res, 200, await notifier.sendTest(), headers);
    }

    throw new HttpError(404, 'not_found', 'Path not found.', { detail: 'not_found_path' });
  }

  async function handler(req, res) {
    const secure = isSecureRequest(req);
    const headers = { ...SECURITY_HEADERS, ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) };
    try {
      const u = splitUrl(req.url);
      if (!u) return sendText(res, 400, 'Invalid request', headers);
      if (!isAllowedHost(req.headers.host, config.allowedHosts)) return sendText(res, 421, 'Host not allowed', headers);
      if (u.pathname === '/healthz') return sendJson(res, 200, { ok: true }, headers);

      if (config.allowedTailscaleLogins.length) {
        const login = String(req.headers['tailscale-user-login'] || '').toLowerCase();
        if (!config.allowedTailscaleLogins.map((l) => l.toLowerCase()).includes(login)) {
          return sendText(res, 403, 'Access denied', headers);
        }
      }
      req.searchParams = new URLSearchParams(u.search);
      if (u.pathname.startsWith('/api/')) return await api(req, res, u.pathname, headers, secure);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', headers);
      return serveStatic({ root: config.pwaDir, req, res, urlPath: u.pathname, headers });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return undefined;
      }
      if (err instanceof HttpError || err instanceof ActionError) {
        return sendJson(res, err.status, errorJson(err), headers);
      }
      logger.error('http_error', errorFields(err));
      return sendJson(res, 500, { error: 'internal', message: 'Internal error' }, headers);
    }
  }

  const server = http.createServer(handler);
  server.keepAliveTimeout = 65_000;

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        hub.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
