// Impostazioni: notifiche push, informazioni sul daemon, uscita dal dispositivo.
import { api } from '../api.js';
import { appbar, banner, switchRow } from '../components.js';
import { commit, h, replace } from '../dom.js';
import { timeAgo } from '../format.js';
import { icon } from '../icons.js';
import { getLive, refresh as refreshLive } from '../live.js';
import { PushError, disablePush, enablePush, getPushState, sendTestPush } from '../push.js';

export function mountSettings(root, { onLoggedOut }) {
  let push = null; // { kind: 'install' | 'unsupported' | 'denied' | 'off' | 'on' }
  let info = null;
  let busy = null; // 'enable' | 'disable' | 'test' | 'logout'
  let note = null; // { error: boolean, text }
  let quiet = null; // { enabled, from, to }
  let awake = null; // { supported, enabled, active }
  let devices = null; // [{ id, label, createdAt, lastSeenAt, current, notifications }]
  let armedDevice = null; // id del dispositivo in attesa del secondo tocco
  let deviceTimer = null;
  let armedLogout = false;
  let armTimer = null;
  let alive = true;
  const mainHost = h('div.region');
  const diagHost = h('div.region');
  replace(root, h('div', { class: 'screen' }, mainHost, diagHost));

  const refreshPush = () =>
    getPushState().then((s) => {
      if (!alive) return;
      push = s;
      render();
    });
  refreshPush();
  api
    .get('/api/info')
    .then((i) => {
      if (!alive) return;
      info = i;
      render();
    })
    .catch(() => {});

  api
    .get('/api/settings/quiet')
    .then((q) => {
      if (!alive) return;
      quiet = q;
      render();
    })
    .catch(() => {});

  const loadAwake = () =>
    api
      .get('/api/settings/awake')
      .then((a) => {
        if (!alive) return;
        awake = a;
        render();
      })
      .catch(() => {});
  loadAwake();
  const awakeTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadAwake();
  }, 6000);

  async function setAwake(key, value) {
    const prev = awake;
    awake = key === 'enabled' ? { ...awake, enabled: value } : { ...awake, [key]: { ...awake[key], enabled: value } }; // subito, poi conferma dal daemon
    render();
    try {
      awake = await api.post('/api/settings/awake', { [key]: value });
      setTimeout(() => alive && loadAwake(), 1500); // il daemon applica il cambio subito dopo la risposta
    } catch (err) {
      awake = prev;
      note = { error: true, text: err.message || 'Impostazione non salvata.' };
    }
    if (alive) render();
  }

  function awakePanel() {
    if (!awake?.supported) return null;
    const rows = [
      switchRow({
        label: 'Resta sveglio mentre un agente lavora',
        sub: awake.active ? 'Attivo adesso: il Mac non va in stop' : awake.enabled ? 'Si attiva quando un agente lavora' : null,
        checked: awake.enabled,
        onToggle: (v) => setAwake('enabled', v),
      }),
    ];
    if (awake.enabled) {
      rows.push(
        switchRow({
          label: 'Anche a schermo chiuso e a batteria',
          sub: awake.closed.available ? (awake.lowBattery ? 'Sospeso: batteria bassa' : awake.closed.active ? 'Attivo adesso' : null) : 'Non configurato: vedi Come funziona',
          checked: awake.closed.enabled,
          disabled: !awake.closed.available && !awake.closed.enabled,
          onToggle: (v) => setAwake('closed', v),
        }),
        switchRow({
          label: 'Luminosit\u00e0 a zero a schermo chiuso',
          sub: awake.dim.available ? (awake.dim.active ? 'Attivo adesso' : null) : 'Non configurato: vedi Come funziona',
          checked: awake.dim.enabled,
          disabled: !awake.dim.available && !awake.dim.enabled,
          onToggle: (v) => setAwake('dim', v),
        }),
      );
    }
    return h('section.panel', null, h('div.panel-title', null, icon('zap', { size: 20 }), h('span.grow', null, 'Mac sveglio')), ...rows);
  }

  const loadDevices = () =>
    api
      .get('/api/devices')
      .then((d) => {
        if (!alive) return;
        devices = d.devices;
        render();
      })
      .catch(() => {});
  loadDevices();

  function revokeDevice(d) {
    if (armedDevice !== d.id) {
      armedDevice = d.id;
      clearTimeout(deviceTimer);
      deviceTimer = setTimeout(() => {
        armedDevice = null;
        render();
      }, 4000);
      render();
      return;
    }
    clearTimeout(deviceTimer);
    armedDevice = null;
    run(
      `device:${d.id}`,
      async () => {
        await api.post(`/api/devices/${d.id}/revoke`, {});
        devices = devices.filter((x) => x.id !== d.id);
        note = { error: false, text: 'Dispositivo scollegato.' };
      },
      () => 'Non sono riuscito a scollegare il dispositivo.',
    );
  }

  function devicesPanel() {
    if (!devices || devices.length < 2) return null; // con un solo dispositivo (questo) il pannello non serve
    const rows = devices.map((d) => {
      const meta = d.current ? 'Questo dispositivo' : `Ultimo accesso ${timeAgo(d.lastSeenAt)}`;
      const armed = armedDevice === d.id;
      return h(
        'div.device-row',
        null,
        icon('phone', { size: 20 }),
        h('div.device-main', null, h('div.device-name', null, d.label || 'Dispositivo'), h('div.device-meta', null, meta, d.notifications ? ' \u00b7 notifiche attive' : '')),
        d.current
          ? null
          : h('button', { class: `btn small${armed ? ' armed' : ''}`, type: 'button', disabled: busy !== null, onClick: () => revokeDevice(d) }, armed ? 'Tocca ancora' : 'Scollega'),
      );
    });
    return h('section.panel', null, h('div.panel-title', null, icon('phone', { size: 20 }), h('span.grow', null, 'Dispositivi abbinati')), ...rows);
  }

  async function saveQuiet(patch) {
    const next = { ...quiet, ...patch };
    quiet = next; // subito, poi conferma dal daemon
    render();
    try {
      quiet = await api.post('/api/settings/quiet', next);
    } catch {
      note = { error: true, text: 'Orari non salvati.' };
    }
    if (alive) render();
  }

  async function setProjectMuted(ws, muted) {
    try {
      await api.post(`/api/workspaces/${encodeURIComponent(ws.id)}/prefs`, { muted });
    } catch {
      note = { error: true, text: 'Impossibile aggiornare il progetto.' };
    }
    await refreshLive().catch(() => {});
    if (alive) render();
  }

  function quietPanel() {
    if (!quiet) return null;
    const time = (label, key) => h('label', { class: 'time-field' }, h('span', null, label), h('input', { type: 'time', value: quiet[key], 'aria-label': label, onChange: (e) => e.target.value && saveQuiet({ [key]: e.target.value }) }));
    return h(
      'section.panel',
      null,
      h('div.panel-title', null, icon('clock', { size: 20 }), h('span.grow', null, 'Orari senza notifiche')),
      switchRow({ label: 'Silenzio programmato', sub: quiet.enabled ? `Dalle ${quiet.from} alle ${quiet.to}` : null, checked: quiet.enabled, onToggle: (v) => saveQuiet({ enabled: v }) }),
      quiet.enabled ? h('div', { class: 'time-pair' }, time('Dalle', 'from'), time('Alle', 'to')) : null,
    );
  }

  function mutedPanel() {
    const workspaces = getLive().payload?.state?.workspaces ?? [];
    if (!workspaces.length) return null;
    return h(
      'section.panel',
      null,
      h('div.panel-title', null, icon('bellOff', { size: 20 }), h('span.grow', null, 'Progetti silenziati')),
      workspaces.map((ws) => switchRow({ label: ws.name, sub: ws.muted ? 'Nessuna notifica' : null, checked: ws.muted === true, onToggle: (v) => setProjectMuted(ws, v) })),
    );
  }

  async function run(name, fn, onError) {
    busy = name;
    note = null;
    render();
    try {
      await fn();
    } catch (err) {
      note = { error: true, text: onError(err) };
    }
    if (!alive) return; // es. dopo l'uscita: la vista e' gia' stata sostituita dal login
    busy = null;
    await refreshPush();
    if (alive) render();
  }

  // enablePush deve partire direttamente dal tocco: iOS richiede un gesto per mostrare la richiesta di permesso.
  const enable = () =>
    run(
      'enable',
      async () => {
        await enablePush();
        note = { error: false, text: 'Notifiche attivate su questo dispositivo.' };
      },
      (err) => {
        if (err instanceof PushError && err.code === 'denied') return 'Permesso negato. Puoi abilitarlo dalle impostazioni di iOS.';
        if (err instanceof PushError && err.code === 'dismissed') return 'Permesso non concesso.';
        return 'Attivazione non riuscita. Riprova.';
      },
    );

  const disable = () =>
    run(
      'disable',
      async () => {
        await disablePush();
        note = { error: false, text: 'Notifiche disattivate su questo dispositivo.' };
      },
      () => 'Disattivazione non riuscita.',
    );

  const test = () =>
    run(
      'test',
      async () => {
        const r = await sendTestPush();
        note = r.sent > 0 ? { error: false, text: 'Notifica di prova inviata.' } : { error: true, text: 'Nessuna notifica consegnata. Controlla i permessi di iOS.' };
      },
      (err) => (err.code === 'too_fast' ? 'Attendi qualche secondo prima di riprovare.' : 'Invio non riuscito.'),
    );

  function logout() {
    if (!armedLogout) {
      armedLogout = true;
      armTimer = setTimeout(() => {
        armedLogout = false;
        render();
      }, 4000);
      render();
      return;
    }
    clearTimeout(armTimer);
    run(
      'logout',
      async () => {
        await disablePush().catch(() => {});
        await api.post('/api/logout');
        onLoggedOut();
      },
      () => 'Uscita non riuscita.',
    );
  }

  function btn(label, iconName, onClick, { primary = false, name } = {}) {
    return h('button', { class: `btn block${primary ? ' primary' : ''}`, type: 'button', disabled: busy !== null, onClick }, busy === name ? icon('spinner', { size: 18, className: 'spin' }) : icon(iconName, { size: 18 }), label);
  }

  function notificationsPanel() {
    const body = [h('div.panel-title', null, icon('bell', { size: 20 }), h('span.grow', null, 'Notifiche'))];
    switch (push?.kind) {
      case undefined:
      case null:
        body.push(h('p.panel-note', null, 'Verifica in corso\u2026'));
        break;
      case 'install':
        body.push(
          h('p.panel-note', null, 'Su iPhone le notifiche funzionano solo dall\u2019app installata:'),
          h('ol.steps', null, h('li', null, 'In Safari tocca Condividi.'), h('li', null, 'Scegli Aggiungi alla schermata Home.'), h('li', null, 'Apri Cursor Pocket dalla Home e abbinala di nuovo.')),
        );
        break;
      case 'unsupported':
        body.push(h('p.panel-note', null, 'Questo browser non supporta le notifiche push.'));
        break;
      case 'denied':
        body.push(h('p.panel-note', null, 'Le notifiche sono bloccate per questa app. Abilitale da Impostazioni di iOS, Notifiche, Cursor Pocket.'));
        break;
      case 'off':
        body.push(h('p.panel-note', null, 'Ricevi un avviso quando una chat pone una nuova domanda, aspetta una tua approvazione o termina il lavoro.'), h('div.panel-actions', null, btn('Attiva notifiche', 'bell', enable, { primary: true, name: 'enable' })));
        break;
      case 'on':
        body.push(
          h('p.panel-note', null, 'Attive su questo dispositivo. Ricevi un avviso per ogni nuova domanda, per ogni approvazione richiesta e quando una chat termina.'),
          h('div.panel-actions', null, btn('Invia notifica di prova', 'bell', test, { name: 'test' }), btn('Disattiva notifiche', 'bellOff', disable, { name: 'disable' })),
        );
        break;
      default:
        break;
    }
    if (note) body.push(h('p', { class: note.error ? 'panel-note error-text' : 'panel-note', role: 'status' }, note.text));
    return h('section.panel', null, body);
  }

  const ACTION_LABEL = { ok: 'attive', off: 'non attive', no_window: 'finestra Agents chiusa', disabled: 'disattivate' };

  function actionsPanel() {
    const reason = getLive().payload?.status?.actions ?? info?.actions?.reason ?? null;
    const port = info?.actions?.port ?? 9222;
    const body = [h('div.panel-title', null, icon('plug', { size: 20 }), h('span.grow', null, 'Rispondere dal telefono'))];
    switch (reason) {
      case 'ok':
        body.push(h('p.panel-note', null, 'Attivo. Dalle chat puoi rispondere alle domande di Cursor, saltarle e scrivere messaggi.'));
        break;
      case 'no_window':
        body.push(h('p.panel-note', null, 'Cursor \u00e8 raggiungibile, ma la finestra Agents non \u00e8 aperta. Aprila sul Mac: questa pagina si aggiorna da sola.'));
        break;
      case 'disabled':
        body.push(h('p.panel-note', null, 'Le azioni sono disattivate nella configurazione del daemon (CP_ACTIONS).'));
        break;
      default:
        body.push(
          h('p.panel-note', null, 'Per rispondere e scrivere dal telefono Cursor deve essere avviato con una porta di debug locale. Sul Mac:'),
          h(
            'ol.steps',
            null,
            h('li', null, 'Chiudi Cursor. Le chat in corso si interrompono: aspetta che abbiano finito.'),
            h('li', null, 'Riaprilo con ', h('code', null, 'tools/cursor-cdp.sh'), ' dalla cartella del progetto.'),
            h('li', null, 'Questa pagina si aggiorna da sola quando Cursor risponde.'),
          ),
          h('p.hint', null, `Mentre la porta ${port} \u00e8 attiva, qualunque programma sul Mac pu\u00f2 controllare Cursor. Non \u00e8 raggiungibile dalla rete.`),
        );
    }
    return h('section.panel', null, body);
  }

  function daemonPanel() {
    const lv = getLive();
    const rows = [];
    const total = lv.payload?.state?.counts?.total;
    if (total != null) rows.push(['Chat visibili', String(total)]);
    if (info) {
      rows.push(['Dispositivi con notifiche', String(info.subscriptions)]);
      if (info.lastScanAt) rows.push(['Ultima lettura di Cursor', timeAgo(info.lastScanAt)]);
      rows.push(['Richieste vecchie in \u201cIn sospeso\u201d dopo', info.pendingAfterHours > 0 ? `${info.pendingAfterHours} h` : 'mai']);
    }
    const act = lv.payload?.status?.actions ?? info?.actions?.reason;
    if (act) rows.push(['Risposte dal telefono', ACTION_LABEL[act] ?? act]);
    rows.push(['Connessione', lv.offline ? 'non raggiungibile' : lv.connection === 'ok' ? 'attiva' : 'in corso']);
    return h('section.panel', null, h('div.panel-title', null, icon('database', { size: 20 }), h('span.grow', null, 'Daemon sul Mac')), h('dl.kv', null, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  function render() {
    if (!alive) return;
    const out = [appbar({ title: 'Impostazioni' })];
    if (getLive().offline) out.push(banner({ text: 'Daemon non raggiungibile' }));
    out.push(notificationsPanel(), quietPanel(), mutedPanel(), awakePanel(), actionsPanel(), daemonPanel(), devicesPanel());
    out.push(h('a', { class: 'row help-link', href: '#/come-funziona' }, icon('info', { size: 20 }), h('div.row-main', null, h('div.row-title', null, 'Come funziona')), icon('chevronRight', { size: 18 })));
    out.push(
      h(
        'section.panel',
        null,
        h('div.panel-title', null, icon('lock', { size: 20 }), h('span.grow', null, 'Accesso')),
        h('p.panel-note', null, 'Questo dispositivo resta abbinato per 90 giorni di inattivit\u00e0. Uscendo, le sue notifiche vengono rimosse.'),
        h('div.panel-actions', null, btn(armedLogout ? 'Tocca ancora per uscire' : 'Esci da questo dispositivo', 'logout', logout, { name: 'logout' })),
      ),
    );
    commit(mainHost, out);
    renderDiag();
  }

  const secs = (ms) => (ms == null ? 'n/d' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} s fa` : 'mai');

  /** Dove si perde tempo tra Mac e telefono (aggiornata ogni secondo, in una regione a parte: non tocca i pulsanti). */
  function renderDiag() {
    const lv = getLive();
    const st = lv.stats;
    const rows = [
      ['Flusso live', lv.connection === 'ok' ? 'attivo' : 'non attivo'],
      ['Eventi ricevuti dal flusso', `${st.sseEvents}, ultimo ${ago(st.lastSseAt)}`],
      ['Ritardo dell\u2019ultimo evento', `${secs(st.lastSseLagMs)} (stima)`],
      ['Aggiornamenti arrivati in ritardo dal flusso', st.pollWins === 0 ? 'nessuno' : `${st.pollWins}, ultimo dopo ${secs(st.lastPollWinLagMs)}`],
      ['Tempo di risposta del daemon', secs(st.lastRttMs)],
    ];
    commit(
      diagHost,
      h(
        'section.panel',
        null,
        h('div.panel-title', null, icon('clock', { size: 20 }), h('span.grow', null, 'Diagnostica connessione')),
        h('dl.kv', null, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        h('p.hint', null, 'Il ritardo \u00e8 una stima: confronta l\u2019orologio del Mac con quello del telefono. Se \u201carrivati in ritardo dal flusso\u201d cresce, gli aggiornamenti live non passano e la pagina si regge sul controllo periodico.'),
      ),
    );
  }

  const diagTimer = setInterval(() => {
    if (document.visibilityState === 'visible') renderDiag();
  }, 1000);

  render();
  return {
    update: render,
    destroy() {
      alive = false;
      clearTimeout(armTimer);
      clearTimeout(deviceTimer);
      clearInterval(awakeTimer);
      clearInterval(diagTimer);
    },
  };
}
