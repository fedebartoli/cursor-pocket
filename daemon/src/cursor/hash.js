// Replica of VS Code's `hash()` (vs/base/common/hash.ts) limited to strings.
// Cursor uses it to build Agents Window sidebar section ids, and we need it to
// match the manual workspace order saved in `cursor/glassSidebarSettings`.
//
// Cursor internal detail: keep isolated in `daemon/src/cursor/`.

function numberHash(value, initial) {
  return (((initial << 5) - initial) + value) | 0;
}

/** Signed int32 hash of a string, computed over UTF-16 code units. */
export function stringHash(s, seed = 0) {
  let h = numberHash(149417, seed);
  for (let i = 0; i < s.length; i++) h = numberHash(s.charCodeAt(i), h);
  return h;
}
