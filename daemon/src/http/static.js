// PWA static files, with path traversal protection, ETag, and `sw.js` with build id.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolves a URL path under `root`; null if it escapes the folder or is a hidden file. */
export function resolveStatic(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? '/index.html' : decoded;
  const abs = path.resolve(root, `.${path.posix.normalize(rel)}`);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  if (path.relative(rootAbs, abs).split(path.sep).some((seg) => seg.startsWith('.'))) return null;
  return abs;
}

function listFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** Build id: changes when any PWA file changes (dev files excluded). */
export function buildId(root) {
  const h = crypto.createHash('sha1');
  for (const f of listFiles(root).sort()) {
    if (f.endsWith('.map')) continue;
    try {
      const st = fs.statSync(f);
      h.update(`${path.relative(root, f)}:${st.size}:${Math.floor(st.mtimeMs)};`);
    } catch {
      // file disappeared during scan
    }
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * URL paths of files to cache for offline startup: entire PWA except the worker, license (.txt) files, and
 * files with unusual names (the list ends up inside a JavaScript literal).
 */
export function precacheList(root) {
  const urls = [];
  let hasIndex = false;
  for (const f of listFiles(root).sort()) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (rel === 'sw.js' || rel.endsWith('.map') || rel.endsWith('.txt') || !/^[\w.\-/@]+$/.test(rel)) continue;
    if (rel === 'index.html') hasIndex = true;
    else urls.push(`/${rel}`);
  }
  return hasIndex ? ['/', ...urls] : urls;
}

/**
 * Serves a static file. Returns true if it handled the response (including 404/304).
 * `sw.js` is served with `__BUILD_ID__` (so the service worker updates on every change) and `__PRECACHE__`
 * (list of files to cache) substituted.
 */
export function serveStatic({ root, req, res, urlPath, headers }) {
  const abs = resolveStatic(root, urlPath);
  if (!abs) return notFound(res, headers);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return notFound(res, headers);
  }
  if (!st.isFile()) return notFound(res, headers);

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const isSw = path.relative(root, abs) === 'sw.js';
  let body = null;
  let etag;
  if (isSw) {
    body = Buffer.from(
      fs
        .readFileSync(abs, 'utf8')
        .replaceAll('__BUILD_ID__', buildId(root))
        .replaceAll('__PRECACHE__', JSON.stringify(precacheList(root))),
    );
    etag = `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  } else {
    etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  }
  const h = {
    ...headers,
    'Content-Type': type,
    ETag: etag,
    // PWA is local and small: always revalidate (ETag) so updates arrive quickly.
    'Cache-Control': 'no-cache',
  };
  if (isSw) h['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, h);
    res.end();
    return true;
  }
  h['Content-Length'] = body ? body.length : st.size;
  res.writeHead(200, h);
  if (req.method === 'HEAD') {
    res.end();
  } else if (body) {
    res.end(body);
  } else {
    fs.createReadStream(abs).pipe(res);
  }
  return true;
}

function notFound(res, headers) {
  res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
  return true;
}
