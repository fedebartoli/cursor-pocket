// Immagini caricate dal telefono in attesa di essere allegate a un messaggio. Restano su disco (solo l'utente puo' leggerle),
// con un nome casuale, il tempo necessario; si cancellano dopo l'invio, dopo TTL e a ogni avvio.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UPLOAD_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, perMessage: 4, pending: 12, ttlMs: 30 * 60_000 });
const ID_RE = /^[a-f0-9]{32}$/;

/** Tipo reale dal contenuto (non ci si fida del Content-Type dichiarato). */
export function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export class Uploads {
  constructor({ dir, now = Date.now }) {
    this.dir = dir;
    this.now = now;
    this.files = new Map(); // id -> { path, at }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); // residui di un avvio precedente
  }

  sweep() {
    const t = this.now();
    for (const [id, f] of this.files) if (t - f.at > UPLOAD_LIMITS.ttlMs) this.remove([id]);
  }

  /** @returns {{ id: string, size: number } | { error: 'too_large' | 'not_image' | 'too_many' | 'empty' }} */
  save(buf) {
    this.sweep();
    if (!buf.length) return { error: 'empty' };
    if (buf.length > UPLOAD_LIMITS.bytes) return { error: 'too_large' };
    const ext = sniffImage(buf);
    if (!ext) return { error: 'not_image' };
    if (this.files.size >= UPLOAD_LIMITS.pending) return { error: 'too_many' };
    const id = crypto.randomBytes(16).toString('hex');
    const p = path.join(this.dir, `${id}.${ext}`);
    fs.writeFileSync(p, buf, { mode: 0o600 });
    this.files.set(id, { path: p, at: this.now() });
    return { id, size: buf.length };
  }

  /** Percorsi dei file per gli id dati, oppure null se uno manca o e' scaduto. */
  paths(ids) {
    this.sweep();
    const out = [];
    for (const id of ids) {
      const f = typeof id === 'string' && ID_RE.test(id) ? this.files.get(id) : null;
      if (!f || !fs.existsSync(f.path)) return null;
      out.push(f.path);
    }
    return out;
  }

  remove(ids) {
    for (const id of ids) {
      const f = this.files.get(id);
      if (!f) continue;
      fs.rmSync(f.path, { force: true });
      this.files.delete(id);
    }
  }

  close() {
    this.remove([...this.files.keys()]);
  }
}
