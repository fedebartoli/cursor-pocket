// Mac sveglio mentre un agente lavora (opzionale, spento di default).
//
// Livello 1 - sempre disponibile su macOS, nessun permesso: con la funzione accesa e almeno una chat "in corso" il daemon
// tiene in vita un `caffeinate -i -m -s -w <pid>` (se il daemon muore muore anche lui). Finito il lavoro, dopo una breve
// tolleranza (una chat tra un passo e l'altro non deve far riaddormentare il Mac) viene chiuso. Lo schermo si spegne come al
// solito (nessun `-d`). Con lo schermo chiuso `-s` tiene sveglio solo con l'alimentatore collegato.
//
// Livello 2 - "anche a schermo chiuso e a batteria" (richiede `tools/mac/power-setup.sh`, una tantum, con sudo): mentre un
// agente lavora il daemon imposta `pmset disablesleep 1`; lo rimette a 0 con QUATTRO protezioni: fine del lavoro, spegnimento
// del daemon, processo di guardia (se il daemon muore all'improvviso) e batteria sotto soglia a batteria.
//
// Luminosita' a zero (opzionale, serve `tools/mac/build.sh`): con lo schermo chiuso e il Mac sveglio l'illuminazione puo' restare
// accesa dentro la borsa; si porta a 0 e si ripristina all'apertura o a fine lavoro (il valore salvato sopravvive a un crash).
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
  #saved = null; // luminosita' prima di azzerarla
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

  /** Stato per la PWA. Aggiorna (con cache breve) la disponibilita' della regola sudoers. */
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

  /** All'avvio: rimette a posto cio' che un arresto brusco precedente potrebbe aver lasciato (sospensione, luminosita'). */
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

  /** Chiamata a ogni lettura di Cursor con il numero di chat che stanno lavorando. */
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
        // gia' terminato
      }
      this.logger.info('keep_awake_off');
    }
    return this.#queue(() => this.#releaseAll());
  }

  /** Un passo di controllo: sospensione, batteria, schermo. Solo con la funzione in corso. */
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
      this.logger.error('keep_awake_release_failed', errorFields(err)); // resta il segno in meta: all'avvio si riprova
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
    if (this.#proc) return; // nel frattempo e' ripartito
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
      // gia' terminato
    }
  }

  /** Processo di guardia: se il daemon sparisce, rimette la sospensione normale e la luminosita'. */
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

  /** Allo spegnimento del daemon: tutto torna come prima prima di uscire. */
  async close() {
    await this.#stop();
  }
}
