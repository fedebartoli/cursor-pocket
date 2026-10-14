// Interfaccia con macOS per "Mac sveglio" a schermo chiuso: sospensione (pmset), stato dello schermo, batteria, luminosita'.
// Tutto passa da `run(comando, argomenti)` (iniettabile nei test) e NON legge mai contenuti di chat.
//
// Sospensione: `sudo -n pmset -a disablesleep 1|0` funziona solo se l'utente ha installato la regola di `tools/mac/power-setup.sh`
// (ammette esattamente quei due comandi, senza password). Senza regola `canControlSleep()` e' falso e non si prova nemmeno.
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

  /** @returns {Promise<boolean|null>} valore attuale di SleepDisabled (null se non leggibile) */
  async sleepDisabled() {
    try {
      const m = /SleepDisabled\s+(\d)/.exec(await this.run(PMSET, ['-g']));
      return m ? m[1] === '1' : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<boolean|null>} schermo chiuso? (null se non leggibile, es. Mac fisso) */
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
