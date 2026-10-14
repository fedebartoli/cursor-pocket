// Comportamento del viewport su Safari/iOS (e browser mobili in generale).
//
//  1. Doppio tocco: iOS lo usa per fare zoom. `touch-action: manipulation` (CSS) lo spegne quasi ovunque, ma non sui
//     tocchi che cadono fuori da elementi con quella proprieta' ne' in tutte le versioni di iOS: qui c'e' la rete di
//     sicurezza. Il pinch NON si tocca (zoom per accessibilita' ancora possibile). I campi di testo sono esclusi: il
//     doppio tocco serve a selezionare le parole.
//  2. Tastiera: su iOS la tastiera non ridimensiona la pagina ma solo il "visual viewport"; si calcola quanto copre e
//     lo si espone come `--kb` (CSS), cosi' il compositore dei messaggi resta sopra la tastiera.
//
// Tutto e' CSSOM/eventi: nessuno stile inline nel markup (la CSP lo vieta).

const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 36;
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_MS = 300;
const KEYBOARD_MIN_PX = 80; // sotto questa soglia e' la barra del browser che appare/scompare, non la tastiera

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * Decide se un tocco appena finito e' il secondo di un doppio tocco. Funzione pura (si prova in Node).
 * @param {{x: number, y: number, t: number, moved: number, duration: number} | null} last  ultimo tocco "pulito"
 * @param {{x: number, y: number, t: number, moved: number, duration: number}} tap          tocco appena finito
 * @returns {{double: boolean, remember: object | null}}
 */
export function classifyTap(last, tap) {
  const clean = tap.moved <= TAP_MAX_MOVE_PX && tap.duration <= TAP_MAX_MS;
  if (!clean) return { double: false, remember: null }; // trascinamento o pressione lunga: non e' un tocco
  if (last && tap.t - last.t <= DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) <= DOUBLE_TAP_PX) {
    return { double: true, remember: null };
  }
  return { double: false, remember: tap };
}

/**
 * Quanto la barra fissa in basso va spostata (px, positivo = in giu') per restare incollata al fondo di CIO' CHE SI VEDE.
 * Con il visual viewport allineato (nessun pinch-zoom, nessuna tastiera) vale 0. Se iOS lo sposta rispetto al viewport di
 * layout (rimbalzo, tastiera chiusa male, barre di Safari) la barra seguirebbe il layout e finirebbe a meta' schermo.
 * Funzione pura.
 */
export function bottomShift({ innerHeight, vvHeight, vvOffsetTop, vvScale = 1 }) {
  if (vvScale > 1.01) return 0; // pinch-zoom: la barra resta dove sta, come ogni elemento fisso
  const shift = Math.round(vvOffsetTop + vvHeight - innerHeight);
  return Math.abs(shift) <= 1 ? 0 : shift;
}

/** Altezza coperta dalla tastiera, dato il visual viewport (0 se non c'e'). Funzione pura. */
export function keyboardHeight({ innerHeight, vvHeight, vvOffsetTop, vvScale = 1 }) {
  if (vvScale > 1.01) return 0; // pinch-zoom in corso: il visual viewport e' piu' piccolo, ma non e' la tastiera
  const covered = Math.round(innerHeight - vvHeight - vvOffsetTop);
  return covered >= KEYBOARD_MIN_PX ? covered : 0;
}

function guardDoubleTap(doc = document) {
  let last = null;
  const starts = new Map();

  doc.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length > 1) {
        starts.clear();
        last = null; // pinch: niente doppio tocco
        return;
      }
      const t = ev.changedTouches[0];
      starts.set(t.identifier, { x: t.clientX, y: t.clientY, at: ev.timeStamp });
    },
    { passive: true },
  );

  doc.addEventListener(
    'touchend',
    (ev) => {
      if (ev.touches.length > 0 || ev.changedTouches.length !== 1) return;
      const t = ev.changedTouches[0];
      const s = starts.get(t.identifier);
      starts.delete(t.identifier);
      if (!s) return;
      const target = ev.target instanceof Element ? ev.target : null;
      if (target?.closest(EDITABLE)) {
        last = null;
        return;
      }
      const tap = { x: t.clientX, y: t.clientY, t: ev.timeStamp, moved: Math.hypot(t.clientX - s.x, t.clientY - s.y), duration: ev.timeStamp - s.at };
      const r = classifyTap(last, tap);
      last = r.remember;
      // Il secondo tocco ravvicinato non diventa ne' zoom ne' click: cosi' un doppio tocco su "Invia" non invia due volte.
      if (r.double && ev.cancelable) ev.preventDefault();
    },
    { passive: false },
  );

  doc.addEventListener('touchcancel', () => starts.clear(), { passive: true });
}

function trackKeyboard(win = window, doc = document) {
  const vv = win.visualViewport;
  if (!vv) return;
  const root = doc.documentElement;
  let frame = 0;
  let current = -1;
  let currentShift = 0;
  const apply = () => {
    frame = 0;
    const m = { innerHeight: win.innerHeight, vvHeight: vv.height, vvOffsetTop: vv.offsetTop, vvScale: vv.scale };
    const kb = keyboardHeight(m);
    // Con la tastiera aperta la barra in basso si nasconde (CSS): non si sposta sopra la tastiera.
    const shift = kb > 0 ? 0 : bottomShift(m);
    if (shift !== currentShift) {
      currentShift = shift;
      root.style.setProperty('--vv-shift', `${shift}px`);
    }
    if (kb === current) return;
    current = kb;
    root.style.setProperty('--kb', `${kb}px`);
    root.classList.toggle('kb-open', kb > 0);
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();
}

export function initViewport() {
  guardDoubleTap();
  trackKeyboard();
}
