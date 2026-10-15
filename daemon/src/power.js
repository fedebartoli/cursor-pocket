// macOS interface for "keep Mac awake" with lid closed: sleep (pmset), lid state, battery, brightness.
// Everything goes through `run(command, args)` (injectable in tests) and NEVER reads chat content.
//
// Sleep: `sudo -n pmset -a disablesleep 1|0` works only if the user installed the rule from `tools/mac/power-setup.sh`
// (allows exactly those two commands, no password). Without it `canControlSleep()` is false and we do not try.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const SUDO = '/usr/bin/sudo';
const PMSET = '/usr/bin/pmset';
const IOREG = '/usr/sbin/ioreg';

const defaultRun = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

export class Power {
  /** @param {{ run?: Function, brightnessCmd?: string, exists?: Function }} p */
  constructor({ run = defaultRun, brightnessCmd = '', exists = fs.existsSync } = {}) {
    this.run = run;
    this.brightnessCmd = brightnessCmd;
    this.exists = exists;
  }

  async canControlSleep() {
    try {
      await this.run(SUDO, ['-n', '-l', PMSET, '-a', 'disablesleep', '1']);
      return true;
    } catch {
      return false;
    }
  }

  async setSleepDisabled(on) {
    await this.run(SUDO, ['-n', PMSET, '-a', 'disablesleep', on ? '1' : '0']);
  }

  /** @returns {Promise<boolean|null>} current SleepDisabled value (null if unreadable) */
  async sleepDisabled() {
    try {
      const m = /SleepDisabled\s+(\d)/.exec(await this.run(PMSET, ['-g']));
      return m ? m[1] === '1' : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<boolean|null>} lid closed? (null if unreadable, e.g. desktop Mac) */
  async lidClosed() {
    try {
      const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(await this.run(IOREG, ['-r', '-k', 'AppleClamshellState', '-d', '4']));
      return m ? m[1] === 'Yes' : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<{ onAC: boolean, percent: number|null }|null>} */
  async battery() {
    try {
      const out = await this.run(PMSET, ['-g', 'batt']);
      const pct = /(\d{1,3})%/.exec(out);
      return { onAC: /AC Power/.test(out), percent: pct ? Number(pct[1]) : null };
    } catch {
      return null;
    }
  }

  get brightnessAvailable() {
    return Boolean(this.brightnessCmd) && this.exists(this.brightnessCmd);
  }

  /** @returns {Promise<number|null>} 0..1 */
  async getBrightness() {
    if (!this.brightnessAvailable) return null;
    try {
      const v = Number.parseFloat(await this.run(this.brightnessCmd, ['get']));
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  async setBrightness(v) {
    if (!this.brightnessAvailable) return false;
    try {
      await this.run(this.brightnessCmd, ['set', String(Math.min(1, Math.max(0, v)))]);
      return true;
    } catch {
      return false;
    }
  }
}
