// Compatibility monitor: tells the user when Cursor changed something this daemon depends on.
//
// Two independent signals, both read-only and content-free:
//  - the database layout (`cursor/compat.js`): a moved JSON field would otherwise stop detection silently;
//  - the installed Cursor release (`cursor/version.js`): a release that was not tested is a notice, never a block.
// The result is only shown (home banner, Settings, /api/info, doctor): it never disables reading, and it does not touch Cursor.
import { EventEmitter } from 'node:events';
import { evaluateDbCompat } from './cursor/compat.js';
import { isTestedVersion, parseVersion, readCursorVersion } from './cursor/version.js';
import { errorFields } from './log.js';

/**
 * Public, stable summary sent to clients (no timestamps: it must not change on every check).
 * `compat`: ok | degraded. `cursor`: tested | untested | unknown.
 */
export function publicCompat(s) {
  return { compat: s.reasons.length ? 'degraded' : 'ok', cursor: s.versionStatus };
}

export class Compat extends EventEmitter {
  #timer = null;
  #state = { reasons: [], version: null, versionStatus: 'unknown', checkedAt: null };

  /**
   * @param {{ db: object, watcher: object, config: object, logger: object, now?: Function, readVersion?: Function, evaluate?: Function }} deps
   */
  constructor({ db, watcher, config, logger, now = Date.now, readVersion = readCursorVersion, evaluate = evaluateDbCompat }) {
    super();
    this.db = db;
    this.watcher = watcher;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.readVersion = readVersion;
    this.evaluate = evaluate;
  }

  get status() {
    return this.#state;
  }

  start() {
    if (this.#timer) return;
    this.check();
    this.#timer = setInterval(() => this.check(), this.config.compatCheckMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One check; never throws. Emits `change` when what clients see changes. */
  check() {
    const prev = this.#state;
    let reasons = prev.reasons;
    // The database is shared with the watcher: when it is not open (Cursor busy, file missing) keep the last verdict.
    if (this.db.isOpen) {
      try {
        const visibleCount = this.watcher.last ? this.watcher.last.chats.length : null;
        reasons = this.evaluate(this.db, { visibleCount }).reasons;
      } catch (err) {
        this.logger.warn('compat_check_failed', errorFields(err));
      }
    }

    let version = prev.version;
    let versionStatus = prev.versionStatus;
    try {
      const dirs = this.config.cursorAppDirs?.length ? this.config.cursorAppDirs : undefined;
      const r = this.readVersion(dirs ? { candidates: dirs } : {});
      version = r.version;
      const tested = r.found ? isTestedVersion(r.version) : null;
      versionStatus = tested === null ? 'unknown' : tested ? 'tested' : 'untested';
    } catch (err) {
      this.logger.warn('compat_version_failed', errorFields(err));
    }

    this.#state = { reasons, version, versionStatus, checkedAt: this.now() };
    const was = publicCompat(prev);
    const is = publicCompat(this.#state);
    const reasonsChanged = reasons.join(',') !== prev.reasons.join(',');
    if (reasonsChanged) {
      if (reasons.length) this.logger.warn('compat_degraded', { count: reasons.length, reason: reasons.join(',') });
      else this.logger.info('compat_ok', {});
    }
    if (versionStatus !== prev.versionStatus || version !== prev.version) {
      const v = parseVersion(version);
      this.logger.info('cursor_version', { state: versionStatus, major: v?.[0] ?? null, minor: v?.[1] ?? null });
    }
    if (was.compat !== is.compat || was.cursor !== is.cursor || reasonsChanged || version !== prev.version) this.emit('change', this.#state);
    return this.#state;
  }
}
