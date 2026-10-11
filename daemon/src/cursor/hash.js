// Replica di `hash()` di VS Code (vs/base/common/hash.ts) limitata alle stringhe.
// Cursor la usa per costruire gli id delle sezioni della sidebar, e noi ne abbiamo bisogno per
// ritrovare l'ordine manuale dei workspace salvato in `cursor/glassSidebarSettings`.
//
// Dettaglio interno di Cursor: tenerlo isolato in `daemon/src/cursor/`.

function numberHash(value, initial) {
  return (((initial << 5) - initial) + value) | 0;
}

/** Hash int32 con segno di una stringa, calcolato sulle unita' di codice UTF-16. */
export function stringHash(s, seed = 0) {
  let h = numberHash(149417, seed);
  for (let i = 0; i < s.length; i++) h = numberHash(s.charCodeAt(i), h);
  return h;
}
