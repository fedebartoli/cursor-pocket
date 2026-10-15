#!/usr/bin/env node
// Generate Home screen icons (PNG for iOS and the manifest) from the `pwa/icons/cursor-logo.svg` logo,
// with no dependencies: reads background and polygons from the SVG (straight segments only: M L H V and lowercase, Z) and
// rasterizes with multisampling (anti-alias). PNGs are full-bleed, no rounded corners: iOS applies those itself.
//
// The mark is owned by Anysphere (see docs/SETUP.md, "Cursor branding"). To use another image, replace
// `cursor-logo.svg` with an SVG of the same kind (one background <rect>, a <g transform="translate/scale"> with
// straight-line <path>s with hex fill/stroke) and run this script again.
//
// Usage:  node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'pwa', 'icons');
const logoFile = path.join(outDir, 'cursor-logo.svg');

// --- logo read ---------------------------------------------------------------------------------------------------

const fail = (msg) => {
  console.error(`make-icons: ${msg}`);
  process.exit(1);
};

const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const hexColor = (v, what) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v ?? '');
  if (!m) fail(`unsupported color in ${what}: ${v} (expected #rgb or #rrggbb)`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

/** Straight-segment SVG path -> list of points. */
function parsePath(d) {
  const tokens = [...d.matchAll(/([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi)].map((m) => (m[1] ? m[1] : Number(m[2])));
  const pts = [];
  let cmd = null;
  let x = 0;
  let y = 0;
  let i = 0;
  const num = () => {
    if (typeof tokens[i] !== 'number') fail(`invalid SVG path: ${d}`);
    return tokens[i++];
  };
  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') cmd = tokens[i++];
    else if (cmd === 'M') cmd = 'L'; // pairs after M are lines
    else if (cmd === 'm') cmd = 'l';
    if (cmd === 'Z' || cmd === 'z') continue;
    switch (cmd) {
      case 'M':
      case 'L':
        x = num();
        y = num();
        break;
      case 'm':
      case 'l':
        x += num();
        y += num();
        break;
      case 'H':
        x = num();
        break;
      case 'h':
        x += num();
        break;
      case 'V':
        y = num();
        break;
      case 'v':
        y += num();
        break;
      default:
        fail(`unsupported SVG command: ${cmd} (straight lines only)`);
    }
    pts.push([x, y]);
  }
  return pts;
}

/** "translate(a b) scale(s) translate(c d)" -> affine matrix [a, b, c, d, e, f] (translate and scale only). */
function parseTransform(t) {
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (n) => {
    m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  };
  for (const [, fn, args] of (t ?? '').matchAll(/(\w+)\(([^)]*)\)/g)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === 'translate') mul([1, 0, 0, 1, v[0], v[1] ?? 0]);
    else if (fn === 'scale') mul([v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else fail(`unsupported SVG transform: ${fn}`);
  }
  return m;
}

function readLogo(file) {
  const svg = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(/[\s,]+/).map(Number);
  if (vb?.length !== 4 || vb.some(Number.isNaN)) fail('missing or invalid viewBox');
  const rect = /<rect\b[^>]*>/.exec(svg)?.[0];
  if (!rect) fail('missing background <rect>');
  const group = /<g\b[^>]*>/.exec(svg)?.[0];
  if (!group) fail('missing <g> with shapes');
  const g = attrsOf(group);
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => {
    const a = attrsOf(m[0]);
    return { pts: parsePath(a.d ?? ''), fill: a.fill ? hexColor(a.fill, 'fill') : null, stroke: a.stroke ? hexColor(a.stroke, 'stroke') : null };
  });
  if (!paths.length) fail('no <path> found');
  const m = parseTransform(g.transform);
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) fail('non-invertible transform');
  return {
    viewBox: vb,
    background: hexColor(attrsOf(rect).fill, 'background'),
    paths,
    strokeHalf: Number(g['stroke-width'] ?? 0) / 2,
    matrix: m,
    det,
  };
}

// --- rasterization -----------------------------------------------------------------------------------------------

function insidePolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToEdges(x, y, pts) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** Color at a point in viewBox space: last shape that covers it, else background. */
function colorAt(logo, vx, vy) {
  const [a, b, c, d, e, f] = logo.matrix;
  // point in the group's local space (inverse of the matrix)
  const px = vx - e;
  const py = vy - f;
  const x = (d * px - c * py) / logo.det;
  const y = (-b * px + a * py) / logo.det;
  for (let k = logo.paths.length - 1; k >= 0; k--) {
    const p = logo.paths[k];
    if (p.fill && insidePolygon(x, y, p.pts)) return p.fill;
    if (p.stroke && logo.strokeHalf > 0 && distToEdges(x, y, p.pts) <= logo.strokeHalf) return p.stroke;
  }
  return logo.background;
}

const SAMPLES = 5; // 5x5 samples per pixel

function render(logo, size) {
  const [vx0, vy0, vw, vh] = logo.viewBox;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1); // first byte of each row is the PNG filter (0 = none)
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const col = colorAt(logo, vx0 + ((x + (i + 0.5) / SAMPLES) / size) * vw, vy0 + ((y + (j + 0.5) / SAMPLES) / size) * vh);
          sum[0] += col[0];
          sum[1] += col[1];
          sum[2] += col[2];
        }
      }
      const n = SAMPLES * SAMPLES;
      raw.set([Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)], row + 1 + x * 3);
    }
  }
  return raw;
}

// --- PNG ---------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- output ------------------------------------------------------------------------------------------------------

const logo = readLogo(logoFile);
const targets = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };
for (const [name, size] of Object.entries(targets)) {
  fs.writeFileSync(path.join(outDir, name), png(size, render(logo, size)));
}
console.log('Icons written to pwa/icons/ from cursor-logo.svg:', Object.keys(targets).join(', '));
