// HTTP security headers and checks.

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  // No inline scripts or styles: everything comes from the same origin.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

function hostOnly(hostHeader) {
  return String(hostHeader || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
}

/**
 * DNS rebinding defense: accept only loopback Host, Tailscale (*.ts.net), or explicitly configured hosts.
 */
export function isAllowedHost(hostHeader, extraHosts = []) {
  if (!hostHeader) return false;
  const host = hostOnly(hostHeader);
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.ts.net')) return true;
  return extraHosts.some((h) => h.toLowerCase() === host);
}

/** True if the request arrived over HTTPS (Tailscale Serve terminates TLS and forwards HTTP on loopback). */
export function isSecureRequest(req) {
  if (String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') return true;
  return hostOnly(req.headers.host).endsWith('.ts.net');
}

/** If Origin is present it must match the request host (extra CSRF protection). */
export function originMatchesHost(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** "Safe" URL path: must start with a single slash (no absolute or protocol-relative URLs). */
export function splitUrl(rawUrl) {
  const s = String(rawUrl || '');
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  const q = s.indexOf('?');
  return { pathname: q < 0 ? s : s.slice(0, q), search: q < 0 ? '' : s.slice(q + 1) };
}
