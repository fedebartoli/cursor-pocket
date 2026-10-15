// `npm run doctor`: checks that this Mac, Cursor and the daemon fit together, and says what to fix.
//
// Read-only and content-free: it never clicks in Cursor, never writes, and prints no chat titles, texts, keys or tokens.
// Every check is a small function returning { level: 'ok' | 'warn' | 'fail', text, hint? }; `runDoctor` collects them so the
// whole thing can be tested with fake dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CursorDb } from './cursor/db.js';

/** Cursor version the selectors were last verified against (major.minor). */
export const TESTED_CURSOR = '3.24';
export const MIN_NODE = [22, 13];

const APP_CANDIDATES = ['/Applications/Cursor.app', path.join(os.homedir(), 'Applications', 'Cursor.app')];

const ok = (text) => ({ level: 'ok', text });
const warn = (text, hint) => ({ level: 'warn', text, hint });
const fail = (text, hint) => ({ level: 'fail', text, hint });

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function checkNode(version = process.versions.node) {
  const v = parseVersion(version);
  if (!v) return fail(`Node: cannot read the version (${version})`);
  const good = v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]);
  return good ? ok(`Node ${version}`) : fail(`Node ${version} is too old`, `Install Node ${MIN_NODE.join('.')} or newer.`);
}

export function checkCursorVersion({ readFile = (p) => fs.readFileSync(p, 'utf8'), candidates = APP_CANDIDATES } = {}) {
  for (const app of candidates) {
    let version = null;
    try {
      version = JSON.parse(readFile(path.join(app, 'Contents', 'Resources', 'app', 'package.json'))).version;
    } catch {
      continue;
    }
    const v = parseVersion(version);
    if (!v) return warn(`Cursor: unreadable version (${version})`);
    if (`${v[0]}.${v[1]}` === TESTED_CURSOR) return ok(`Cursor ${version} (the version the selectors were tested on)`);
    return warn(
      `Cursor ${version}: this release was tested on ${TESTED_CURSOR}.x`,
      'It may still work. If an action fails, run this command again and report the lines marked FAIL (see the Troubleshooting section of the README).',
    );
  }
  return warn('Cursor app not found in /Applications or ~/Applications: version unknown');
}

export function checkDatabase(config, { open = (p) => new CursorDb(p) } = {}) {
  const db = open(config.cursorDbPath);
  try {
    db.open();
  } catch (err) {
    return [fail(`Cursor database not readable (${err.code || err.message})`, 'Check CP_CURSOR_DB, or open Cursor once so it creates the database.')];
  }
  const out = [ok('Cursor database opens read-only')];
  try {
    const headers = db.listHeaders();
    out.push(headers.length > 0 ? ok(`Chat headers readable (${headers.length} chats with activity)`) : warn('The database has no chats with activity yet'));
    const settings = db.sidebarSettings();
    out.push(settings ? ok('Sidebar settings readable (group order)') : warn('Sidebar settings not found: the group order may differ from Cursor', 'Open the Agents Window once.'));
  } catch (err) {
    out.push(fail(`Cursor database format not as expected (${err.code || err.message})`, 'Cursor probably changed its storage: the code that reads it lives in daemon/src/cursor/db.js.'));
  } finally {
    db.close();
  }
  return out;
}

export async function checkDaemon(config, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? ok(`Daemon answers on ${config.host}:${config.port}`) : fail(`Daemon answered with status ${r.status}`);
  } catch {
    return warn(`Daemon is not running on ${config.host}:${config.port}`, 'Start it with `npm start`, or `tools/launchd.sh install` to run it at login.');
  }
}

/** Debug port, Agents window and the page elements the actions rely on. `ui` is an AgentsUi. */
export async function checkActions(config, ui) {
  const p = await ui.probe();
  if (!p.up) {
    return [warn(`Debug port ${config.cdpPort} is closed: phone actions are off (read-only mode still works)`, 'Quit Cursor and start it with tools/cursor-cdp.sh when no agent is working.')];
  }
  const out = [ok(`Debug port ${config.cdpPort} is open (${p.browser ?? 'unknown version'})`)];
  if (!(await ui.hasWindow())) {
    out.push(fail('Agents window not found', 'Open the Agents Window in Cursor (and keep it open) so the daemon can drive it.'));
    return out;
  }
  out.push(ok('Agents window found'));
  let t;
  try {
    t = await ui.selfTest();
  } catch (err) {
    out.push(fail(`Page check failed (${err.code || 'error'})`));
    return out;
  }
  out.push(t.rows > 0 ? ok(`Sidebar rows found (${t.rows})`) : warn('No sidebar rows found', 'Show the sidebar, or create a chat: the daemon needs the rows to open chats.'));
  out.push(t.sidebarToggle ? ok('Sidebar toggle found') : warn('Sidebar toggle not found: a hidden sidebar cannot be opened automatically'));
  out.push(t.customize ? ok('Sidebar customize button found') : warn('Sidebar customize button not found'));
  if (!t.panel) {
    out.push(warn('No chat is open in the foreground: composer and send button were not checked', 'Open any chat in Cursor and run this again.'));
  } else {
    out.push(t.composer ? ok('Composer found in the open chat') : fail('Composer not found in the open chat', 'The editor markup probably changed: see SEL.composer in daemon/src/cursor/agents-ui.js.'));
    out.push(t.send ? ok('Send (or stop) button found') : fail('Send button not found in the open chat', 'See SEL.send and SEL.stop in daemon/src/cursor/agents-ui.js.'));
  }
  return out;
}

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });

/** `tailscale serve` should point to the daemon port, and Funnel must be off. */
export async function checkTailscale(config, { exec = run, bins = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] } = {}) {
  const bin = bins.find((b) => fs.existsSync(b));
  if (!bin) return [warn('Tailscale command not found: the phone cannot reach the daemon without it', 'Install Tailscale on the Mac and the iPhone.')];
  const serve = await exec(bin, ['serve', 'status']);
  if (serve == null) return [warn('Could not read `tailscale serve status` (is Tailscale running?)')];
  const out = [];
  if (/funnel on/i.test(serve)) out.push(fail('Tailscale Funnel is ON: the daemon would be reachable from the whole internet', 'Turn it off now: `tailscale funnel reset`. Never use Funnel with this app.'));
  else out.push(ok('Tailscale Funnel is off'));
  const proxied = new RegExp(`(127\\.0\\.0\\.1|localhost):${config.port}\\b`).test(serve);
  out.push(proxied ? ok(`tailscale serve forwards to port ${config.port}`) : warn(`tailscale serve does not forward to port ${config.port}`, `Run: tailscale serve --bg ${config.port}`));
  return out;
}

/**
 * Runs every check. `deps` lets tests replace the outside world.
 * @returns {Promise<{ results: {level: string, text: string, hint?: string}[], failed: number, warned: number }>}
 */
export async function runDoctor(config, { ui, deps = {} } = {}) {
  const results = [];
  const add = (x) => results.push(...[].concat(x));
  add(checkNode(deps.nodeVersion));
  add(checkCursorVersion(deps.cursorVersion));
  add(checkDatabase(config, deps.database));
  add(await checkDaemon(config, deps.daemon));
  add(await checkActions(config, ui));
  add(await checkTailscale(config, deps.tailscale));
  return { results, failed: results.filter((r) => r.level === 'fail').length, warned: results.filter((r) => r.level === 'warn').length };
}

export function formatReport(report) {
  const tag = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  const lines = [];
  for (const r of report.results) {
    lines.push(`${tag[r.level]}  ${r.text}`);
    if (r.hint && r.level !== 'ok') lines.push(`      -> ${r.hint}`);
  }
  lines.push('');
  lines.push(report.failed ? `${report.failed} problem(s) to fix, ${report.warned} warning(s).` : report.warned ? `No problems, ${report.warned} warning(s).` : 'Everything looks fine.');
  return lines.join('\n');
}
