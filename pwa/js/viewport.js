// Viewport behavior on Safari/iOS (and mobile browsers in general).
//
//  1. Double tap: iOS uses it to zoom. `touch-action: manipulation` (CSS) disables it almost everywhere, but not on
//     taps that land outside elements with that property nor on all iOS versions: this is the safety net. Pinch is
//     NOT touched (zoom for accessibility still possible). Text fields are excluded: double tap selects words.
//  2. Keyboard: on iOS the keyboard does not resize the page but only the "visual viewport"; we compute how much it
//     covers and expose it as `--kb` (CSS), so the message composer stays above the keyboard.
//
// All via CSSOM/events: no inline styles in markup (CSP forbids them).

const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 36;
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_MS = 300;
const KEYBOARD_MIN_PX = 80; // below this threshold it is the browser bar showing/hiding, not the keyboard

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * Decide whether a tap that just ended is the second of a double tap. Pure function (testable in Node).
 * @param {{x: number, y: number, t: number, moved: number, duration: number} | null} last  last "clean" tap
 * @param {{x: number, y: number, t: number, moved: number, duration: number}} tap          tap that just ended
 * @returns {{double: boolean, remember: object | null}}
 */
export function classifyTap(last, tap) {
  const clean = tap.moved <= TAP_MAX_MOVE_PX && tap.duration <= TAP_MAX_MS;
  if (!clean) return { double: false, remember: null }; // drag or long press: not a tap
  if (last && tap.t - last.t <= DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) <= DOUBLE_TAP_PX) {
    return { double: true, remember: null };
  }
  return { double: false, remember: tap };
}

/**
 * How much the fixed bottom bar must shift (px, positive = down) to stay glued to the bottom of WHAT IS VISIBLE.
 * With the visual viewport aligned (no pinch-zoom, no keyboard) this is 0. If iOS moves it relative to the layout
 * viewport (bounce, keyboard dismissed badly, Safari bars) the bar would follow layout and end up mid-screen.
 * Pure function.
 */
export function bottomShift({ innerHeight, vvHeight, vvOffsetTop, vvScale = 1 }) {
  if (vvScale > 1.01) return 0; // pinch-zoom: bar stays put, like any fixed element
  const shift = Math.round(vvOffsetTop + vvHeight - innerHeight);
  return Math.abs(shift) <= 1 ? 0 : shift;
}

/** Height covered by the keyboard, given the visual viewport (0 if none). Pure function. */
export function keyboardHeight({ innerHeight, vvHeight, vvOffsetTop, vvScale = 1 }) {
  if (vvScale > 1.01) return 0; // pinch-zoom active: visual viewport is smaller, but it is not the keyboard
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
        last = null; // pinch: no double tap
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
      // The second quick tap must not become zoom or click: so double tap on "Send" does not send twice.
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
    // With keyboard open the bottom bar is hidden (CSS): do not shift above the keyboard.
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
