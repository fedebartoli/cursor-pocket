// Keep Mac awake while an agent is working (optional, off by default).
//
// Level 1 - always available on macOS, no permission: with the feature on and at least one chat "running", the daemon
// keeps a `caffeinate -i -m -s -w <pid>` alive (if the daemon dies, it dies too). When work finishes, after a short
// grace period (a chat between steps must not let the Mac sleep) it is stopped. The display sleeps as usual (no `-d`).
// With the lid closed, `-s` keeps awake only on AC power.
//
// Level 2 - "lid closed on battery too" (requires one-time `tools/mac/power-setup.sh` with sudo): while an agent works
// the daemon sets `pmset disablesleep 1`; reset to 0 with FOUR safeguards: end of work, daemon shutdown,
// guard process (if the daemon dies unexpectedly), and battery below threshold on battery power.
//
// Zero brightness (optional, needs `tools/mac/build.sh`): with lid closed and Mac awake, backlight may stay on in a bag;
// set to 0 and restore on open or end of work (saved value survives a crash).
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import { errorFields } from './log.js';
import { Power } from './power.js';

const META = { enabled: 'keep_awake', closed: 'keep_awake_closed', dim: 'keep_awake_dim', sleepSet: 'awake_sleep_disabled', saved: 'awake_saved_brightness' };
const AVAILABLE_TTL_MS = 20_000;

const GUARD = [
  'pid=$1; bcmd=$2; saved=$3',
  'while kill -0 "$pid" 2>/dev/null; do sleep 3; done',
  '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0 >/dev/null 2>&1',
  '[ -n "$saved" ] && [ -x "$bcmd" ] && "$bcmd" set "$saved" >/dev/null 2>&1',
  'exit 0',
].join('\n');

export class KeepAwake {
  #proc = null;
  #graceTimer = null;
  #pollTimer = null;
  #guard = null;
  #broken = false;
  #running = 0;
  #closedActive = false;
  #lowBattery = false;
  #saved = null; // brightness before dimming
  #closedAvailable = false;
  #availableAt = 0;
  #chain = Promise.resolve();

  /** @param {{ store: object, config: object, logger: object, spawn?: Function, exists?: Function, power?: Power }} p */
  constructor({ store, config, logger, spawn = realSpawn, exists = fs.existsSync, power }) {
    this.store = store;
    this.cmd = config.keepAwakeCmd;
    this.graceMs = config.keepAwakeGraceMs;
    this.pollMs = config.keepAwakePollMs ?? 5000;
    this.minBattery = config.keepAwakeMinBattery ?? 20;
    this.logger = logger;
    this.spawn = spawn;
    this.exists = exists;
    this.power = power ?? new Power({ brightnessCmd: config.keepAwakeBrightnessCmd ?? '', exists });
  }

  get supported() {
    return Boolean(this.cmd) && !this.#broken && this.exists(this.cmd);
  }
  get enabled() {
    return this.store.getMeta(META.enabled) === '1';
  }
  set enabled(v) {
    this.store.setMeta(META.enabled, v ? '1' : '0');
    this.update(this.#running);
  }
  get closedEnabled() {
    return this.store.getMeta(META.closed) === '1';
  }
  set closedEnabled(v) {
    this.store.setMeta(META.closed, v ? '1' : '0');
    this.#kick();
  }
  get dimEnabled() {
    return this.store.getMeta(META.dim) === '1';
  }
  set dimEnabled(v) {
    this.store.setMeta(META.dim, v ? '1' : '0');
    this.#kick();
  }

  /** State for the PWA. Refreshes (with short cache) sudoers rule availability. */
  async describe() {
    if (this.supported && Date.now() - this.#availableAt > AVAILABLE_TTL_MS) {
      this.#closedAvailable = await this.power.canControlSleep();
      this.#availableAt = Date.now();
    }
    return {
      supported: this.supported,
      enabled: this.enabled,
      active: this.#proc !== null,
      closed: { available: this.#closedAvailable, enabled: this.closedEnabled, active: this.#closedActive },
      dim: { available: this.power.brightnessAvailable, enabled: this.dimEnabled, active: this.#saved !== null },
      lowBattery: this.#lowBattery,
    };
  }

  /** On startup: fix what an abrupt previous shutdown may have left (sleep, brightness). */
  async init() {
    if (this.store.getMeta(META.sleepSet) === '1') {
      try {
        await this.power.setSleepDisabled(false);
        this.store.setMeta(META.sleepSet, '0');
        this.logger.warn('keep_awake_recovered', { what: 'sleep' });
      } catch (err) {
        this.logger.warn('keep_awake_recover_failed', errorFields(err));
      }
    }
    const saved = Number.parseFloat(this.store.getMeta(META.saved) ?? '');
    if (Number.isFinite(saved)) {
      await this.power.setBrightness(saved);
      this.store.setMeta(META.saved, '');
      this.logger.warn('keep_awake_recovered', { what: 'brightness' });
    }
  }

  /** Called on every Cursor read with the number of chats currently working. */
  update(runningCount) {
    this.#running = runningCount;
    const want = this.enabled && this.supported && runningCount > 0;
    if (want) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
      if (!this.#proc) this.#start();
      return;
    }
    if (!this.#proc) return;
    if (!this.enabled) return void this.#stop();
    if (!this.#graceTimer) {
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = null;
        if (this.#running === 0 || !this.enabled) this.#stop();
      }, this.graceMs);
      this.#graceTimer.unref?.();
    }
  }

  #queue(fn) {
    this.#chain = this.#chain.then(fn).catch((err) => this.logger.warn('keep_awake_error', errorFields(err)));
    return this.#chain;
  }

  #kick() {
    if (this.#proc) this.#queue(() => this.#reconcile());
  }

  #start() {
    try {
      const p = this.spawn(this.cmd, ['-i', '-m', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
      p.on?.('error', (err) => {
        this.#broken = true;
        this.#proc = null;
        this.logger.warn('keep_awake_failed', errorFields(err));
      });
      p.on?.('exit', () => {
        if (this.#proc === p) this.#proc = null;
      });
      p.unref?.();
      this.#proc = p;
      this.logger.info('keep_awake_on');
    } catch (err) {
      this.#broken = true;
      this.logger.warn('keep_awake_failed', errorFields(err));
      return;
    }
    this.#lowBattery = false;
    this.#pollTimer = setInterval(() => this.#kick(), this.pollMs);
    this.#pollTimer.unref?.();
    this.#kick();
  }

  #stop() {
    clearTimeout(this.#graceTimer);
    this.#graceTimer = null;
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    const p = this.#proc;
    this.#proc = null;
    if (p) {
      try {
        p.kill('SIGTERM');
      } catch {
        // already exited
      }
      this.logger.info('keep_awake_off');
    }
    return this.#queue(() => this.#releaseAll());
  }

  /** One control pass: sleep, battery, display. Only while keep-awake is active. */
  async #reconcile() {
    if (!this.#proc) return;
    const b = await this.power.battery();
    if (b && !b.onAC && b.percent !== null) {
      if (b.percent < this.minBattery) this.#lowBattery = true;
      else if (b.percent >= this.minBattery + 5) this.#lowBattery = false;
    } else if (b?.onAC) {
      this.#lowBattery = false;
    }

    const wantClosed = this.closedEnabled && !this.#lowBattery && (await this.power.canControlSleep());
    if (wantClosed) {
      if (!this.#closedActive || (await this.power.sleepDisabled()) === false) {
        await this.power.setSleepDisabled(true);
        this.store.setMeta(META.sleepSet, '1');
        if (!this.#closedActive) this.logger.info('keep_awake_closed_on');
        this.#closedActive = true;
        this.#armGuard();
      }
    } else if (this.#closedActive) {
      await this.#releaseSleep();
    }

    const wantDim = this.dimEnabled && (await this.power.lidClosed()) === true;
    if (wantDim && this.#saved === null) {
      const v = await this.power.getBrightness();
      if (v !== null && v > 0) {
        this.#saved = v;
        this.store.setMeta(META.saved, String(v));
        await this.power.setBrightness(0);
        this.#armGuard();
        this.logger.info('keep_awake_dim_on');
      }
    } else if (!wantDim && this.#saved !== null) {
      await this.#restoreBrightness();
    }
  }

  async #releaseSleep() {
    this.#closedActive = false;
    try {
      await this.power.setSleepDisabled(false);
      this.store.setMeta(META.sleepSet, '0');
      this.logger.info('keep_awake_closed_off');
    } catch (err) {
      this.logger.error('keep_awake_release_failed', errorFields(err)); // meta flag remains: retried on startup
    }
    this.#armGuard();
  }

  async #restoreBrightness() {
    const v = this.#saved;
    this.#saved = null;
    if (v !== null) {
      await this.power.setBrightness(v);
      this.store.setMeta(META.saved, '');
      this.logger.info('keep_awake_dim_off');
    }
    this.#armGuard();
  }

  async #releaseAll() {
    if (this.#proc) return; // restarted in the meantime
    await this.#restoreBrightness();
    if (this.#closedActive) await this.#releaseSleep();
    this.#killGuard();
  }

  #killGuard() {
    const g = this.#guard;
    this.#guard = null;
    try {
      g?.kill('SIGTERM');
    } catch {
      // already exited
    }
  }

  /** Guard process: if the daemon disappears, restore normal sleep and brightness. */
  #armGuard() {
    this.#killGuard();
    if (!this.#closedActive && this.#saved === null) return;
    try {
      const g = this.spawn('/bin/sh', ['-c', GUARD, 'sh', String(process.pid), this.power.brightnessCmd || '', this.#saved === null ? '' : String(this.#saved)], { stdio: 'ignore', detached: true });
      g.on?.('error', () => {});
      g.unref?.();
      this.#guard = g;
    } catch (err) {
      this.logger.warn('keep_awake_guard_failed', errorFields(err));
    }
  }

  /** On daemon shutdown: restore everything before exit. */
  async close() {
    await this.#stop();
  }
}
