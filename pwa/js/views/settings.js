// Settings: push notifications, daemon info, sign out from this device.
import { api } from '../api.js';
import { appbar, banner, switchRow } from '../components.js';
import { commit, h, replace } from '../dom.js';
import { timeAgo } from '../format.js';
import { icon } from '../icons.js';
import { t, LANGUAGES, getLanguagePreference, setLanguagePreference } from '../i18n/index.js';
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
  let armedDevice = null; // device id waiting for second tap
  let deviceTimer = null;
  let armedLogout = false;
  let armTimer = null;
  let alive = true;
  const mainHost = h('div.region');
  const diagHost = h('div.region');
  replace(root, h('div', { class: 'screen' }, mainHost, diagHost));

  function actionStatusLabel(reason) {
    const labels = {
      ok: t('settings.actionStatusOk'),
      off: t('settings.actionStatusOff'),
      no_window: t('settings.actionStatusNoWindow'),
      disabled: t('settings.actionStatusDisabled'),
      ui_changed: t('settings.actionStatusPaused'),
    };
    return labels[reason] ?? reason;
  }

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
    awake = key === 'enabled' ? { ...awake, enabled: value } : { ...awake, [key]: { ...awake[key], enabled: value } }; // optimistic UI, then confirm from daemon
    render();
    try {
      awake = await api.post('/api/settings/awake', { [key]: value });
      setTimeout(() => alive && loadAwake(), 1500); // daemon applies change shortly after the response
    } catch (err) {
      awake = prev;
      note = { error: true, text: err.message || t('settings.settingNotSaved') };
    }
    if (alive) render();
  }

  function awakePanel() {
    if (!awake?.supported) return null;
    const rows = [
      switchRow({
        label: t('settings.awakeStayAwakeLabel'),
        sub: awake.active ? t('settings.awakeStayAwakeSubActive') : awake.enabled ? t('settings.awakeStayAwakeSubEnabled') : null,
        checked: awake.enabled,
        onToggle: (v) => setAwake('enabled', v),
      }),
    ];
    if (awake.enabled) {
      rows.push(
        switchRow({
          label: t('settings.awakeClosedLabel'),
          sub: awake.closed.available
            ? awake.lowBattery
              ? t('settings.awakeClosedSubLowBattery')
              : awake.closed.active
                ? t('settings.awakeClosedSubActive')
                : null
            : t('settings.awakeNotConfigured'),
          checked: awake.closed.enabled,
          disabled: !awake.closed.available && !awake.closed.enabled,
          onToggle: (v) => setAwake('closed', v),
        }),
        switchRow({
          label: t('settings.awakeDimLabel'),
          sub: awake.dim.available ? (awake.dim.active ? t('settings.awakeDimSubActive') : null) : t('settings.awakeNotConfigured'),
          checked: awake.dim.enabled,
          disabled: !awake.dim.available && !awake.dim.enabled,
          onToggle: (v) => setAwake('dim', v),
        }),
      );
    }
    return h('section.panel', null, h('div.panel-title', null, icon('zap', { size: 20 }), h('span.grow', null, t('settings.awakeTitle'))), ...rows);
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
        note = { error: false, text: t('settings.deviceUnpaired') };
      },
      () => t('settings.deviceUnpairFailed'),
    );
  }

  function devicesPanel() {
    if (!devices || devices.length < 2) return null; // with only this device the panel is unnecessary
    const rows = devices.map((d) => {
      const meta = d.current ? t('settings.deviceThisDevice') : t('settings.deviceLastAccess', { time: timeAgo(d.lastSeenAt) });
      const armed = armedDevice === d.id;
      return h(
        'div.device-row',
        null,
        icon('phone', { size: 20 }),
        h(
          'div.device-main',
          null,
          h('div.device-name', null, d.label || t('settings.deviceDefaultName')),
          h('div.device-meta', null, meta, d.notifications ? t('settings.deviceNotificationsOn') : ''),
        ),
        d.current
          ? null
          : h('button', { class: `btn small${armed ? ' armed' : ''}`, type: 'button', disabled: busy !== null, onClick: () => revokeDevice(d) }, armed ? t('settings.deviceTapAgain') : t('settings.deviceUnpair')),
      );
    });
    return h('section.panel', null, h('div.panel-title', null, icon('phone', { size: 20 }), h('span.grow', null, t('settings.devicesTitle'))), ...rows);
  }

  async function saveQuiet(patch) {
    const next = { ...quiet, ...patch };
    quiet = next; // optimistic UI, then confirm from daemon
    render();
    try {
      quiet = await api.post('/api/settings/quiet', next);
    } catch {
      note = { error: true, text: t('settings.quietSaveFailed') };
    }
    if (alive) render();
  }

  async function setProjectMuted(ws, muted) {
    try {
      await api.post(`/api/workspaces/${encodeURIComponent(ws.id)}/prefs`, { muted });
    } catch {
      note = { error: true, text: t('settings.mutedUpdateFailed') };
    }
    await refreshLive().catch(() => {});
    if (alive) render();
  }

  function quietPanel() {
    if (!quiet) return null;
    const fromLabel = t('settings.quietFrom');
    const toLabel = t('settings.quietTo');
    const time = (label, key) =>
      h('label', { class: 'time-field' }, h('span', null, label), h('input', { type: 'time', value: quiet[key], 'aria-label': label, onChange: (e) => e.target.value && saveQuiet({ [key]: e.target.value }) }));
    return h(
      'section.panel',
      null,
      h('div.panel-title', null, icon('clock', { size: 20 }), h('span.grow', null, t('settings.quietTitle'))),
      switchRow({
        label: t('settings.quietScheduled'),
        sub: quiet.enabled ? t('settings.quietRange', { from: quiet.from, to: quiet.to }) : null,
        checked: quiet.enabled,
        onToggle: (v) => saveQuiet({ enabled: v }),
      }),
      quiet.enabled ? h('div', { class: 'time-pair' }, time(fromLabel, 'from'), time(toLabel, 'to')) : null,
    );
  }

  function mutedPanel() {
    const workspaces = getLive().payload?.state?.workspaces ?? [];
    if (!workspaces.length) return null;
    return h(
      'section.panel',
      null,
      h('div.panel-title', null, icon('bellOff', { size: 20 }), h('span.grow', null, t('settings.mutedTitle'))),
      workspaces.map((ws) => switchRow({ label: ws.name || (ws.home ? t('common.noFolder') : ''), sub: ws.muted ? t('settings.mutedNoNotifications') : null, checked: ws.muted === true, onToggle: (v) => setProjectMuted(ws, v) })),
    );
  }

  function languagePanel() {
    const pref = getLanguagePreference();
    const selectId = 'settings-language';
    const onChange = (e) => {
      setLanguagePreference(e.target.value);
      location.reload();
    };
    const options = [
      h('option', { value: 'auto', selected: pref === 'auto' }, t('settings.languageAuto')),
      ...LANGUAGES.map((l) => h('option', { value: l.code, selected: pref === l.code }, l.name)),
    ];
    return h(
      'section.panel',
      null,
      h('div.panel-title', null, icon('globe', { size: 20 }), h('span.grow', null, t('settings.languageTitle'))),
      h('label.lang-field', { for: selectId }, h('span.lang-label', null, t('settings.languageTitle')), h('select.lang-select', { id: selectId, onChange }, ...options)),
      h('p.hint', null, t('settings.languageHint')),
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
    if (!alive) return; // e.g. after logout: view already replaced by login
    busy = null;
    await refreshPush();
    if (alive) render();
  }

  // enablePush must run directly from a tap: iOS requires a gesture to show the permission prompt.
  const enable = () =>
    run(
      'enable',
      async () => {
        await enablePush();
        note = { error: false, text: t('settings.pushEnabled') };
      },
      (err) => {
        if (err instanceof PushError && err.code === 'denied') return t('settings.pushDeniedIos');
        if (err instanceof PushError && err.code === 'dismissed') return t('settings.pushDismissed');
        return t('settings.pushEnableFailed');
      },
    );

  const disable = () =>
    run(
      'disable',
      async () => {
        await disablePush();
        note = { error: false, text: t('settings.pushDisabled') };
      },
      () => t('settings.pushDisableFailed'),
    );

  const test = () =>
    run(
      'test',
      async () => {
        const r = await sendTestPush();
        note = r.sent > 0 ? { error: false, text: t('settings.pushTestSent') } : { error: true, text: t('settings.pushTestNone') };
      },
      (err) => (err.code === 'too_fast' ? t('settings.pushTestTooFast') : t('settings.pushTestFailed')),
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
      () => t('settings.logoutFailed'),
    );
  }

  function btn(label, iconName, onClick, { primary = false, name } = {}) {
    return h('button', { class: `btn block${primary ? ' primary' : ''}`, type: 'button', disabled: busy !== null, onClick }, busy === name ? icon('spinner', { size: 18, className: 'spin' }) : icon(iconName, { size: 18 }), label);
  }

  function notificationsPanel() {
    const body = [h('div.panel-title', null, icon('bell', { size: 20 }), h('span.grow', null, t('settings.notificationsTitle')))];
    switch (push?.kind) {
      case undefined:
      case null:
        body.push(h('p.panel-note', null, t('settings.pushChecking')));
        break;
      case 'install':
        body.push(
          h('p.panel-note', null, t('settings.pushInstallIntro')),
          h('ol.steps', null, h('li', null, t('settings.pushInstallStep1')), h('li', null, t('settings.pushInstallStep2')), h('li', null, t('settings.pushInstallStep3'))),
        );
        break;
      case 'unsupported':
        body.push(h('p.panel-note', null, t('settings.pushUnsupported')));
        break;
      case 'denied':
        body.push(h('p.panel-note', null, t('settings.pushDeniedHelp')));
        break;
      case 'off':
        body.push(h('p.panel-note', null, t('settings.pushOffNote')), h('div.panel-actions', null, btn(t('settings.pushEnableBtn'), 'bell', enable, { primary: true, name: 'enable' })));
        break;
      case 'on':
        body.push(
          h('p.panel-note', null, t('settings.pushOnNote')),
          h('div.panel-actions', null, btn(t('settings.pushTestBtn'), 'bell', test, { name: 'test' }), btn(t('settings.pushDisableBtn'), 'bellOff', disable, { name: 'disable' })),
        );
        break;
      default:
        break;
    }
    if (note) body.push(h('p', { class: note.error ? 'panel-note error-text' : 'panel-note', role: 'status' }, note.text));
    return h('section.panel', null, body);
  }

  function actionsPanel() {
    const reason = getLive().payload?.status?.actions ?? info?.actions?.reason ?? null;
    const port = info?.actions?.port ?? 9222;
    const body = [h('div.panel-title', null, icon('plug', { size: 20 }), h('span.grow', null, t('settings.actionsTitle')))];
    switch (reason) {
      case 'ok':
        body.push(h('p.panel-note', null, t('settings.actionsOk')));
        break;
      case 'no_window':
        body.push(h('p.panel-note', null, t('settings.actionsNoWindow')));
        break;
      case 'disabled':
        body.push(h('p.panel-note', null, t('settings.actionsDisabled')));
        break;
      case 'ui_changed':
        body.push(h('p.panel-note', null, t('settings.actionsPaused')));
        break;
      default:
        body.push(
          h('p.panel-note', null, t('settings.actionsSetupIntro')),
          h(
            'ol.steps',
            null,
            h('li', null, t('settings.actionsSetupStep1')),
            h('li', null, t('settings.actionsSetupStep2Before'), h('code', null, 'tools/cursor-cdp.sh'), t('settings.actionsSetupStep2After')),
            h('li', null, t('settings.actionsSetupStep3')),
          ),
          h('p.hint', null, t('settings.actionsPortHint', { port })),
        );
    }
    return h('section.panel', null, body);
  }

  function daemonPanel() {
    const lv = getLive();
    const rows = [];
    const total = lv.payload?.state?.counts?.total;
    if (total != null) rows.push([t('settings.daemonVisibleChats'), String(total)]);
    if (info) {
      rows.push([t('settings.daemonPushDevices'), String(info.subscriptions)]);
      if (info.lastScanAt) rows.push([t('settings.daemonLastScan'), timeAgo(info.lastScanAt)]);
      rows.push([
        t('settings.daemonPendingAfter'),
        info.pendingAfterHours > 0 ? t('settings.daemonPendingHours', { hours: info.pendingAfterHours }) : t('settings.daemonPendingNever'),
      ]);
    }
    const act = lv.payload?.status?.actions ?? info?.actions?.reason;
    if (act) rows.push([t('settings.daemonPhoneReplies'), actionStatusLabel(act)]);
    const cursorState = lv.payload?.status?.cursor ?? info?.compat?.versionStatus;
    const cursorVersion = info?.compat?.version;
    if (cursorState) {
      const value =
        cursorState === 'tested' && cursorVersion
          ? t('settings.cursorTested', { version: cursorVersion })
          : cursorState === 'untested' && cursorVersion
            ? t('settings.cursorUntested', { version: cursorVersion })
            : t('settings.cursorUnknown');
      rows.push([t('settings.daemonCursor'), value]);
    }
    const compat = lv.payload?.status?.compat;
    if (compat) rows.push([t('settings.daemonCompat'), compat === 'degraded' ? t('settings.compatDegraded') : t('settings.compatOk')]);
    rows.push([
      t('settings.daemonConnection'),
      lv.offline ? t('settings.connectionOffline') : lv.connection === 'ok' ? t('settings.connectionOk') : t('settings.connectionPending'),
    ]);
    return h('section.panel', null, h('div.panel-title', null, icon('database', { size: 20 }), h('span.grow', null, t('settings.daemonTitle'))), h('dl.kv', null, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  function render() {
    if (!alive) return;
    const out = [appbar({ title: t('settings.title') })];
    if (getLive().offline) out.push(banner({ text: t('settings.daemonUnreachable') }));
    out.push(notificationsPanel(), languagePanel(), quietPanel(), mutedPanel(), awakePanel(), actionsPanel(), daemonPanel(), devicesPanel());
    out.push(h('a', { class: 'row help-link', href: '#/archivio' }, icon('archive', { size: 20 }), h('div.row-main', null, h('div.row-title', null, t('settings.archivedChatsLink'))), icon('chevronRight', { size: 18 })));
    out.push(h('a', { class: 'row help-link', href: '#/come-funziona' }, icon('info', { size: 20 }), h('div.row-main', null, h('div.row-title', null, t('settings.helpLink'))), icon('chevronRight', { size: 18 })));
    out.push(
      h(
        'section.panel',
        null,
        h('div.panel-title', null, icon('lock', { size: 20 }), h('span.grow', null, t('settings.accessTitle'))),
        h('p.panel-note', null, t('settings.accessNote')),
        h('div.panel-actions', null, btn(armedLogout ? t('settings.logoutTapAgain') : t('settings.logoutBtn'), 'logout', logout, { name: 'logout' })),
      ),
    );
    commit(mainHost, out);
    renderDiag();
  }

  function formatDiagSecs(ms) {
    if (ms == null) return t('settings.diagNa');
    if (ms < 1000) return t('settings.diagMs', { ms });
    return t('settings.diagSec', { sec: (ms / 1000).toFixed(1) });
  }

  function formatDiagAgo(at) {
    if (!at) return t('settings.diagAgoNever');
    return t('settings.diagAgoSec', { sec: Math.max(0, Math.round((Date.now() - at) / 1000)) });
  }

  /** Where time is lost between Mac and phone (updates every second, separate region: does not affect buttons). */
  function renderDiag() {
    const lv = getLive();
    const st = lv.stats;
    const rows = [
      [t('settings.diagLiveFlow'), lv.connection === 'ok' ? t('settings.diagLiveActive') : t('settings.diagLiveInactive')],
      [t('settings.diagSseEvents'), t('settings.diagSseEventsValue', { count: st.sseEvents, ago: formatDiagAgo(st.lastSseAt) })],
      [t('settings.diagLastEventLag'), t('settings.diagLastEventLagValue', { secs: formatDiagSecs(st.lastSseLagMs) })],
      [
        t('settings.diagPollWins'),
        st.pollWins === 0 ? t('settings.diagPollWinsNone') : t('settings.diagPollWinsValue', { count: st.pollWins, secs: formatDiagSecs(st.lastPollWinLagMs) }),
      ],
      [t('settings.diagRtt'), formatDiagSecs(st.lastRttMs)],
    ];
    commit(
      diagHost,
      h(
        'section.panel',
        null,
        h('div.panel-title', null, icon('clock', { size: 20 }), h('span.grow', null, t('settings.diagTitle'))),
        h('dl.kv', null, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        h('p.hint', null, t('settings.diagHint')),
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
