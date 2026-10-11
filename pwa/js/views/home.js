// Elenco: "Richiedono attenzione", "In sospeso" e le chat raggruppate per workspace nell'ordine della sidebar di Cursor.
import { appbar, banner, chatRow, emptyState, iconButton, sectionHead, skeleton } from '../components.js';
import { api } from '../api.js';
import { commit, h } from '../dom.js';
import { icon } from '../icons.js';
import { getLive, refresh } from '../live.js';
import { environment } from '../push.js';

const PREFS_KEY = 'cp.home.v1';
const PREVIEW = 5; // chat mostrate per workspace prima di "Mostra altre"
const SWIPE_W = 92; // larghezza del pulsante "Ignora" scoperto scorrendo una riga (anche in app.css: --swipe-w)
const PTR_TRIGGER = 56; // trascinamento (px, dopo la resistenza) oltre il quale si aggiorna
const PTR_MAX = 80;

function readPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function mountHome(root) {
  const prefs = readPrefs();
  const expandedLists = new Set();
  let refreshing = false;
  let alive = true;

  const save = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // archivio non disponibile: le preferenze valgono solo per la sessione
    }
  };

  // Stato iniziale dei gruppi: quello di Cursor (`collapsed`), salvo scelta locale dell'utente.
  const wsOpen = (ws) => (prefs.ws?.[ws.id] ? prefs.ws[ws.id] === 'open' : !ws.collapsed);

  function toggleWs(ws) {
    prefs.ws = { ...prefs.ws, [ws.id]: wsOpen(ws) ? 'closed' : 'open' };
    save();
    render();
  }

  async function doRefresh() {
    if (refreshing) return;
    refreshing = true;
    render();
    try {
      await refresh();
    } catch {
      // l'errore e' gia' mostrato dal banner di connessione
    }
    refreshing = false;
    render();
  }

  // --- gesti -----------------------------------------------------------------------------------------------
  // Scorrere una riga verso sinistra scopre "Ignora" (la stessa azione della pagina chat, che resta per chi usa VoiceOver).
  // Il tocco semplice apre la chat come prima; un trascinamento orizzontale non la apre.
  async function ignoreCard(card) {
    try {
      await api.post(`/api/chats/${encodeURIComponent(card.id)}/ignore`, { key: card.attention.key });
    } catch {
      // se la richiesta e' cambiata nel frattempo l'elenco si aggiorna comunque
    }
    await refresh().catch(() => {});
    closeSwipes(null);
    pendingRender = false;
    render();
  }

  // Mentre una riga e' trascinata o aperta l'elenco non si ridisegna (si perderebbe il gesto): si recupera dopo.
  let pendingRender = false;
  const swiping = () => Boolean(document.querySelector('.swipe.dragging, .swipe.open'));
  const flushRender = () => {
    if (pendingRender && !swiping()) {
      pendingRender = false;
      render();
    }
  };
  const closeSwipes = (except) => {
    for (const el of document.querySelectorAll('.swipe.open')) if (el !== except) el.classList.remove('open');
    flushRender();
  };

  function swipeRow(card) {
    const wrap = h(
      'div.swipe',
      null,
      h('button', { class: 'swipe-action', type: 'button', tabindex: '-1', 'aria-hidden': 'true', onClick: () => ignoreCard(card) }, icon('eyeOff', { size: 20 }), h('span', null, 'Ignora')),
      chatRow(card, { showWorkspace: true, showPrompt: true }),
    );
    let pid = null;
    let sx = 0;
    let sy = 0;
    let base = 0;
    let axis = null;
    let dx = 0;
    let moved = false;
    wrap.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.swipe-action')) return;
      pid = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      base = wrap.classList.contains('open') ? -SWIPE_W : 0;
      axis = null;
      moved = false;
    });
    wrap.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      const mx = e.clientX - sx;
      const my = e.clientY - sy;
      if (!axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        axis = Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y';
        if (axis === 'x') {
          wrap.setPointerCapture?.(pid);
          closeSwipes(wrap);
          wrap.classList.add('dragging');
          wrap.classList.remove('open'); // durante il trascinamento comanda --swipe (partendo da `base`)
        }
      }
      if (axis !== 'x') return;
      moved = true;
      dx = Math.min(0, Math.max(-SWIPE_W - 24, base + mx));
      wrap.style.setProperty('--swipe', `${dx}px`);
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (axis === 'x') {
        wrap.classList.remove('dragging');
        wrap.classList.toggle('open', dx < -SWIPE_W / 2);
        wrap.style.removeProperty('--swipe');
      }
      axis = null;
      flushRender();
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    // Dopo un trascinamento, o con la riga aperta, il tocco non apre la chat: chiude soltanto la riga.
    wrap.addEventListener(
      'click',
      (e) => {
        if (e.target.closest('.swipe-action')) return;
        if (moved || wrap.classList.contains('open')) {
          e.preventDefault();
          e.stopPropagation();
          if (!moved) wrap.classList.remove('open');
          moved = false;
          flushRender();
        }
      },
      true,
    );
    return wrap;
  }

  const onOutsidePointer = (e) => {
    if (!e.target.closest?.('.swipe')) closeSwipes(null);
  };
  document.addEventListener('pointerdown', onOutsidePointer, true);

  // Trascinare l'elenco verso il basso, quando e' in cima, lo aggiorna (iOS non lo fa da solo in una PWA).
  const ptr = h('div', { class: 'ptr', 'aria-hidden': 'true' }, icon('refresh', { size: 20 }));
  document.body.append(ptr);
  let ptrY = null;
  let ptrX = 0;
  let pulling = false;
  let pull = 0;
  const setPtr = (p) => {
    pull = p;
    ptr.style.setProperty('--ptr-o', String(Math.min(1, p / PTR_TRIGGER)));
    ptr.style.setProperty('--ptr-y', `${p * 0.6}px`);
    ptr.style.setProperty('--ptr-r', `${p * 4}deg`);
  };
  const onTouchStart = (e) => {
    if (e.touches.length !== 1 || window.scrollY > 0 || refreshing) {
      ptrY = null;
      return;
    }
    ptrY = e.touches[0].clientY;
    ptrX = e.touches[0].clientX;
    pulling = false;
  };
  const onTouchMove = (e) => {
    if (ptrY == null) return;
    const dy = e.touches[0].clientY - ptrY;
    const adx = Math.abs(e.touches[0].clientX - ptrX);
    if (!pulling) {
      if (dy > 10 && dy > adx * 1.5 && window.scrollY <= 0) pulling = true;
      else if (dy < -6 || adx > 24) ptrY = null;
      if (!pulling) return;
    }
    setPtr(Math.min(PTR_MAX, Math.max(0, (dy - 10) * 0.5)));
  };
  const onTouchEnd = () => {
    if (pulling && pull >= PTR_TRIGGER) doRefresh();
    setPtr(0);
    ptrY = null;
    pulling = false;
  };
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });

  function pushHint() {
    if (prefs.pushHintDismissed) return null;
    const env = environment();
    let text = null;
    if (env.ios && !env.standalone) text = 'Per ricevere le notifiche aggiungi l\u2019app alla schermata Home.';
    else if (env.hasApis && Notification.permission === 'default') text = 'Le notifiche non sono attive.';
    if (!text) return null;
    return banner({
      tone: 'info',
      iconName: 'bell',
      text,
      actionLabel: 'Apri impostazioni',
      href: '#/impostazioni',
      onDismiss: () => {
        prefs.pushHintDismissed = true;
        save();
        render();
      },
    });
  }

  function workspaceBlock(ws) {
    const open = wsOpen(ws);
    const head = sectionHead({
      label: ws.name,
      count: ws.counts.total,
      alert: ws.counts.attention > 0,
      iconName: open ? 'folderOpen' : 'folder',
      expanded: open,
      onToggle: () => toggleWs(ws),
    });
    if (!open) return [head];
    const all = expandedLists.has(ws.id);
    const cards = all ? ws.chats : ws.chats.slice(0, PREVIEW);
    const hidden = ws.chats.length - cards.length;
    const more =
      hidden > 0
        ? h(
            'button',
            {
              class: 'row row-more',
              type: 'button',
              onClick: () => {
                expandedLists.add(ws.id);
                render();
              },
            },
            `Mostra altre ${hidden}`,
          )
        : null;
    return [head, h('div.list', null, cards.map((c) => chatRow(c)), more)];
  }

  function render() {
    if (!alive) return; // chiamata tardiva dopo un cambio di schermata
    if (swiping()) {
      pendingRender = true;
      return;
    }
    const y = window.scrollY;
    const lv = getLive();
    const state = lv.payload?.state ?? null;
    const status = lv.payload?.status ?? null;

    const out = [
      appbar({
        title: 'Cursor Pocket',
        logo: true,
        actions: [
          iconButton({ label: 'Aggiorna', name: 'refresh', spin: refreshing, onClick: doRefresh }),
        ],
      }),
    ];

    if (lv.offline) {
      out.push(banner({ text: 'Daemon non raggiungibile', detail: 'Controlla che sia attivo sul Mac e che Tailscale sia connesso.', actionLabel: 'Riprova', onAction: doRefresh }));
    } else if (status && !status.ok) {
      out.push(
        banner({
          text: status.error === 'db' ? 'Database di Cursor non leggibile' : 'Il daemon si sta avviando',
          detail: status.error === 'db' ? 'I dati mostrati potrebbero non essere aggiornati.' : null,
        }),
      );
    }
    const hint = pushHint();
    if (hint) out.push(hint);

    if (!state) {
      out.push(skeleton());
    } else if (state.counts.total === 0) {
      out.push(emptyState({ iconName: 'terminal', title: 'Nessuna chat locale', text: 'Le chat locali dell\u2019Agents Window di Cursor compariranno qui.' }));
    } else {
      // Sistema le preferenze: niente voci per workspace che non esistono piu'.
      const ids = new Set(state.workspaces.map((w) => w.id));
      const known = Object.keys(prefs.ws ?? {});
      if (known.some((k) => !ids.has(k))) {
        prefs.ws = Object.fromEntries(known.filter((k) => ids.has(k)).map((k) => [k, prefs.ws[k]]));
        save();
      }

      if (state.attention.length) {
        out.push(
          sectionHead({ label: 'Richiedono attenzione', count: state.attention.length, tone: 'danger' }),
          h('div.list', null, state.attention.map((c) => swipeRow(c))),
        );
      }
      if (state.pending.length) {
        const open = Boolean(prefs.pendingOpen);
        out.push(
          sectionHead({
            label: 'In sospeso',
            count: state.pending.length,
            iconName: 'clock',
            expanded: open,
            onToggle: () => {
              prefs.pendingOpen = !open;
              save();
              render();
            },
          }),
        );
        if (open) out.push(h('div.list', null, state.pending.map((c) => chatRow(c, { showWorkspace: true }))));
      }
      for (const ws of state.workspaces) out.push(...workspaceBlock(ws));
    }

    if (commit(root, h('div.screen', null, out))) window.scrollTo(0, y);
  }

  render();
  return {
    update: render,
    destroy() {
      alive = false;
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      ptr.remove();
    },
  };
}
