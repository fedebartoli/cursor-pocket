#!/usr/bin/env node
// Estrae un insieme ridotto di icone da un pacchetto `lucide-react` GIA' PRESENTE sul disco (licenza ISC)
// e genera `pwa/js/icons.js` (dati SVG, nessuna dipendenza a runtime) piu' la licenza in `pwa/icons/`.
//
// Uso:  node tools/vendor-icons.mjs <percorso>/node_modules/lucide-react
//
// Le icone non sono disegnate a mano: i path provengono dalla libreria. Per cambiare icona, modifica ICONS e rilancia.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('Uso: node tools/vendor-icons.mjs <percorso>/node_modules/lucide-react');
  process.exit(2);
}

// nome interno -> nome Lucide
const ICONS = {
  question: 'circle-question-mark',
  terminal: 'terminal',
  plan: 'clipboard-list',
  alert: 'triangle-alert',
  info: 'info',
  chevronRight: 'chevron-right',
  chevronDown: 'chevron-down',
  chevronUp: 'chevron-up',
  back: 'arrow-left',
  folder: 'folder',
  folderOpen: 'folder-open',
  bell: 'bell',
  bellOff: 'bell-off',
  stop: 'square',
  zap: 'zap',
  settings: 'settings',
  home: 'house',
  refresh: 'refresh-cw',
  spinner: 'loader-circle',
  check: 'check',
  checkCircle: 'circle-check',
  eyeOff: 'eye-off',
  restore: 'rotate-ccw',
  logout: 'log-out',
  offline: 'wifi-off',
  phone: 'smartphone',
  clock: 'clock',
  close: 'x',
  database: 'database',
  share: 'square-arrow-up',
  lock: 'lock',
  // Fase 2 (azioni)
  arrowUp: 'arrow-up',
  send: 'send',
  skip: 'skip-forward',
  plug: 'plug',
  message: 'message-square',
  pencil: 'pencil',
  // Approvazione di un tool (comando, modifica, MCP...)
  approval: 'shield-question-mark',
  // Attivita' recente (categorie dei tool)
  fileText: 'file-text',
  search: 'search',
  globe: 'globe',
  wrench: 'wrench',
  bot: 'bot',
  listTodo: 'list-todo',
  trash: 'trash-2',
  user: 'user',
  xCircle: 'circle-x',
  // Navigazione e preferite
  inbox: 'inbox',
  messages: 'messages-square',
  heart: 'heart',
  heartOff: 'heart-off',
  plus: 'plus',
  archive: 'archive',
  archiveRestore: 'archive-restore',
  stop: 'square',
  volumeOff: 'volume-x',
};

const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
const out = {};
for (const [name, lucide] of Object.entries(ICONS)) {
  const file = path.join(src, 'dist', 'esm', 'icons', `${lucide}.mjs`);
  const mod = await import(pathToFileURL(file).href);
  // __iconNode: [["path", {d, key}], ...] -> tolgo `key` (serve solo a React)
  out[name] = mod.__iconNode.map(([tag, attrs]) => {
    const { key: _key, ...rest } = attrs;
    return [tag, rest];
  });
}

const body = `// GENERATO da tools/vendor-icons.mjs - non modificare a mano.
// Icone: Lucide ${pkg.version} (licenza ISC, vedi /icons/LICENSE-lucide.txt). Nessuna dipendenza a runtime.
const NS = 'http://www.w3.org/2000/svg';

const DATA = ${JSON.stringify(out, null, 1)};

/** Crea un elemento <svg> (decorativo) per l'icona \`name\`. */
export function icon(name, { size = 20, className = '' } = {}) {
  const nodes = DATA[name];
  if (!nodes) throw new Error(\`icona sconosciuta: \${name}\`);
  const svg = document.createElementNS(NS, 'svg');
  const attrs = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  svg.setAttribute('class', \`icon\${className ? \` \${className}\` : ''}\`);
  for (const [tag, a] of nodes) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(DATA);
`;

fs.mkdirSync(path.join(root, 'pwa', 'js'), { recursive: true });
fs.mkdirSync(path.join(root, 'pwa', 'icons'), { recursive: true });
fs.writeFileSync(path.join(root, 'pwa', 'js', 'icons.js'), body);
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(root, 'pwa', 'icons', 'LICENSE-lucide.txt'));
console.log(`Icone vendorizzate: ${Object.keys(out).length} (Lucide ${pkg.version})`);
