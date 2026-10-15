// Installed Cursor version and the releases this code was verified against.
//
// Reads `package.json` inside the Cursor app bundle: read-only, no chat content, no configuration touched.
// A release that is not on the tested list is only a WARNING for the user, never a reason to disable anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Cursor versions (major.minor) the selectors and the database reader were verified against. */
export const TESTED_CURSOR = ['3.24', '3.25'];

export const APP_CANDIDATES = ['/Applications/Cursor.app', path.join(os.homedir(), 'Applications', 'Cursor.app')];

/** `"3.25.6"` -> `[3, 25, 6]`; null when it does not look like a version. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Is this release (e.g. `3.25.6`) on the tested list? null when the version cannot be parsed. */
export function isTestedVersion(version, tested = TESTED_CURSOR) {
  const v = parseVersion(version);
  return v ? tested.includes(`${v[0]}.${v[1]}`) : null;
}

/**
 * Version string of the installed Cursor app, or null when the app is not found or unreadable.
 * `found` tells apart "app missing" from "version unreadable" (the doctor words them differently).
 * @returns {{ found: boolean, version: string | null }}
 */
export function readCursorVersion({ readFile = (p) => fs.readFileSync(p, 'utf8'), candidates = APP_CANDIDATES } = {}) {
  for (const app of candidates) {
    try {
      const version = JSON.parse(readFile(path.join(app, 'Contents', 'Resources', 'app', 'package.json'))).version;
      return { found: true, version: typeof version === 'string' ? version : null };
    } catch {
      // try the next location
    }
  }
  return { found: false, version: null };
}
