// Mac sveglio mentre un agente lavora (opzionale, spento di default).
//
// Con la funzione attiva e almeno una chat "in corso" il daemon tiene in vita un `caffeinate` (strumento di macOS: nessun
// permesso speciale, nessuna modifica alle impostazioni di sistema). Finito il lavoro, dopo un breve periodo di tolleranza
// (una chat tra un passo e l'altro non deve far riaddormentare il Mac), `caffeinate` viene chiuso e il Mac torna a comportarsi
// come prima. `-w <pid del daemon>`: se il daemon muore, muore anche `caffeinate` (niente Mac sveglio per sempre).
//
// Flag: -i niente sospensione per inattivita'; -m il disco non si ferma; -s niente sospensione di sistema CON ALIMENTATORE
// (a batteria macOS lo ignora). Lo schermo si spegne come al solito (nessun `-d`).
// Chiudendo lo schermo: a Mac in carica `-s` dovrebbe tenerlo sveglio; a batteria si addormenta comunque (limite di macOS).
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import { errorFields } from './log.js';

const META_KEY = 'keep_awake';

export class KeepAwake {
  #proc = null;
  #graceTimer = null;
  #broken = false;
  #running = 0;

  /**
   * @param {{ store: object, config: object, logger: object, spawn?: Function, exists?: Function }} p
   */
  constructor({ store, config, logger, spawn = realSpawn, exists = fs.existsSync }) {
    this.store = store;
    this.cmd = config.keepAwakeCmd;
    this.graceMs = config.keepAwakeGraceMs;
    this.logger = logger;
    this.spawn = spawn;
    this.exists = exists;
  }

  get supported() {
    return Boolean(this.cmd) && !this.#broken && this.exists(this.cmd);
  }

  get enabled() {
    return this.store.getMeta(META_KEY) === '1';
  }

  set enabled(v) {
    this.store.setMeta(META_KEY, v ? '1' : '0');
    this.update(this.#running);
  }

  get status() {
    return { supported: this.supported, enabled: this.enabled, active: this.#proc !== null };
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
    if (!this.enabled) return this.#stop();
    if (!this.#graceTimer) {
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = null;
        if (this.#running === 0 || !this.enabled) this.#stop();
      }, this.graceMs);
      this.#graceTimer.unref?.();
    }
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
    }
  }

  #stop() {
    clearTimeout(this.#graceTimer);
    this.#graceTimer = null;
    if (!this.#proc) return;
    const p = this.#proc;
    this.#proc = null;
    try {
      p.kill('SIGTERM');
    } catch {
      // gia' terminato
    }
    this.logger.info('keep_awake_off');
  }

  /** Allo spegnimento del daemon. */
  close() {
    this.#stop();
  }
}
