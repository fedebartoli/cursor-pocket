// Prepare images to attach to a message: resize (max long side) and re-encode as JPEG, so a
// HEIC or 12 MP photo becomes a light file, readable by Cursor and without original photo metadata (location).
import { t } from './i18n/index.js';

export const MAX_IMAGES = 4; // same as daemon UPLOAD_LIMITS.perMessage
const MAX_SIDE = 2048;
const QUALITY = 0.85;
const PASS_THROUGH = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // fall back to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** @returns {Promise<Blob>} an image/jpeg Blob (or the original file if decode fails and it is already supported) */
export async function prepareImage(file) {
  try {
    const src = await decode(file);
    const w = src.naturalWidth || src.width;
    const hgt = src.naturalHeight || src.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, hgt));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hgt * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs: white background, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    src.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (blob && blob.size <= MAX_BYTES) return blob;
  } catch {
    // fallback below
  }
  if (PASS_THROUGH.has(file.type) && file.size <= MAX_BYTES) return file;
  throw new Error(t('images.unsupportedFormat'));
}
