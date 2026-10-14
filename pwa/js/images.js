// Preparazione delle immagini da allegare a un messaggio: ridimensiona (lato lungo massimo) e ricodifica in JPEG, cosi' un
// HEIC o una foto da 12 MP diventa un file leggero, leggibile da Cursor e senza i metadati (posizione) della foto originale.
export const MAX_IMAGES = 4; // come UPLOAD_LIMITS.perMessage del daemon
const MAX_SIDE = 2048;
const QUALITY = 0.85;
const PASS_THROUGH = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // si prova con <img>
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

/** @returns {Promise<Blob>} un Blob image/jpeg (oppure il file originale se non si riesce a decodificarlo ed e' gia' supportato) */
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
    ctx.fillStyle = '#fff'; // PNG trasparenti: sfondo bianco, non nero
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    src.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (blob && blob.size <= MAX_BYTES) return blob;
  } catch {
    // ripiego sotto
  }
  if (PASS_THROUGH.has(file.type) && file.size <= MAX_BYTES) return file;
  throw new Error('Formato immagine non supportato.');
}
