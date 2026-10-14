// Avvio dell'app: sessione, router a hash, connessione live, service worker.
import { api, onUnauthorized } from './api.js';
import { forgetCommit, h } from './dom.js';
import { icon } from './icons.js';
import { getLive, startLive, stopLive, subscribe } from './live.js';
import { resyncPush } from './push.js';
import { initViewport } from './viewport.js';
import { mountChat } from './views/chat.js';
import { mountHelp } from './views/help.js';
import { mountArchive } from './views/archive.js';
import { mountHistory } from './views/history.js';
import { mountNewChat } from './views/newchat.js';
import { mountHome } from './views/home.js';
import { mountLogin, mountUnreachable } from './views/login.js';
import { mountSettings } from './views/settings.js';

const root = document.getElementById('app');
const TITLE = 'Cursor Pocket';

let mode = 'boot'; // 'boot' | 'login' | 'app'
let view = null;
let currentKey = '';
let navigated = false; // vero dopo la prima schermata: da li' in poi il focus segue la navigazione
let unsubscribeLive = null;
const scrollMemory = new Map();

// Barra in basso (raggiungibile col pollice): Attenzione, Chat, Preferite, Impostazioni. Si vede solo fuori dalle chat,
// dove in fondo c'e' il compositore.
const tabBadge = h('span', { class: 'tab-badge', hidden: true });
const tabDefs = [
  { route: 'home', href: '#/', label: 'Attenzione', icon: 'inbox', badge: tabBadge },
  { route: 'chats', href: '#/chat', label: 'Chat', icon: 'messages' },
  { route: 'favorites', href: '#/preferite', label: 'Preferite', icon: 'heart' },
  { route: 'settings', href: '#/impostazioni', label: 'Impostazioni', icon: 'settings' },
];
const tabEls = new Map(
  tabDefs.map((t) => [t.route, h('a', { class: 'tab', href: t.href }, h('span.tab-icon', null, icon(t.icon, { size: 24 }), t.badge ?? null), h('span.tab-label', null, t.label))]),
);
const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Navigazione principale', hidden: true }, h('div.tabbar-inner', null, [...tabEls.values()]));
document.body.append(tabbar);

function updateTabbar(routeName) {
  const visible = mode === 'app' && routeName !== 'chat' && routeName !== 'history' && routeName !== 'newchat';
  tabbar.hidden = !visible;
  document.body.classList.toggle('has-tabbar', visible);
  const active = routeName === 'help' || routeName === 'archive' ? 'settings' : routeName === 'newchat' ? 'chats' : routeName; // "Come funziona" sta sotto Impostazioni
  for (const [route, el] of tabEls) {
    if (visible && route === active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function updateBadge(n) {
  tabBadge.hidden = n <= 0;
  tabBadge.textContent = n > 99 ? '99+' : String(n);
  tabEls.get('home').setAttribute('aria-label', n > 0 ? `Attenzione, ${n} richieste da decidere` : 'Attenzione');
}

function parseRoute() {
  const hash = location.hash || '#/';
  const chat = /^#\/chat\/([^/?]+)$/.exec(hash);
  if (chat) {
    try {
      const id = decodeURIComponent(chat[1]);
      if (id) return { name: 'chat', id, key: `chat:${id}` };
    } catch {
      // identificativo malformato: si torna all'elenco
    }
  }
  const hist = /^#\/chat\/([^/?]+)\/storia$/.exec(hash);
  if (hist) {
    try {
      const id = decodeURIComponent(hist[1]);
      if (id) return { name: 'history', id, key: `history:${id}` };
    } catch {
      // identificativo malformato: si torna all'elenco
    }
  }
  if (hash === '#/impostazioni') return { name: 'settings', key: 'settings' };
  if (hash === '#/nuova') return { name: 'newchat', key: 'newchat' };
  if (hash === '#/archivio') return { name: 'archive', key: 'archive' };
  if (hash === '#/come-funziona') return { name: 'help', key: 'help' };
  if (hash === '#/chat') return { name: 'chats', key: 'chats' };
  if (hash === '#/preferite') return { name: 'favorites', key: 'favorites' };
  return { name: 'home', key: 'home' };
}

function mountRoute() {
  if (mode !== 'app') return;
  scrollMemory.set(currentKey, window.scrollY);
  view?.destroy?.();
  forgetCommit(root); // la nuova vista deve sempre sostituire il contenuto, anche se identico al precedente
  const route = parseRoute();
  currentKey = route.key;
  updateTabbar(route.name);
  if (route.name === 'chat') view = mountChat(root, route.id);
  else if (route.name === 'history') view = mountHistory(root, route.id);
  else if (route.name === 'settings') view = mountSettings(root, { onLoggedOut: showLogin });
  else if (route.name === 'help') view = mountHelp(root);
  else if (route.name === 'archive') view = mountArchive(root);
  else if (route.name === 'newchat') view = mountNewChat(root);
  else view = mountHome(root, route.name === 'home' ? 'attention' : route.name);
  // Si ripristina la posizione degli elenchi; le altre schermate partono dall'alto.
  const isList = ['home', 'chats', 'favorites'].includes(route.name);
  window.scrollTo(0, isList ? (scrollMemory.get(route.key) ?? 0) : 0);
  // Accessibilita': dopo un cambio di schermata il lettore vocale parte dal titolo della nuova schermata.
  if (navigated) {
    root.querySelector('.appbar-title')?.focus({ preventScroll: true });
    // Dissolvenza breve (solo opacita': una trasformazione sposterebbe il compositore fisso); spenta da "Riduci movimento".
    root.classList.remove('enter');
    void root.offsetWidth; // riavvia l'animazione
    root.classList.add('enter');
  }
  navigated = true;
}

function onLive(lv) {
  view?.update?.(lv);
  const n = lv.payload?.state?.counts?.attention ?? 0;
  updateBadge(n);
  document.title = n > 0 ? `(${n}) ${TITLE}` : TITLE;
}

function showLogin() {
  if (mode === 'login') return;
  mode = 'login';
  updateTabbar('login');
  updateBadge(0);
  stopLive();
  unsubscribeLive?.();
  unsubscribeLive = null;
  view?.destroy?.();
  view = null;
  document.title = TITLE;
  try {
    navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    // badge non supportato
  }
  mountLogin(root, {
    onSuccess() {
      location.hash = '#/';
      enterApp();
    },
  });
  window.scrollTo(0, 0);
}

async function enterApp() {
  mode = 'app';
  unsubscribeLive?.();
  unsubscribeLive = subscribe(onLive);
  mountRoute(); // mostra subito lo scheletro: i dati arrivano da startLive
  await startLive();
  if (mode === 'app') resyncPush(); // dopo un nuovo abbinamento, ripristina la registrazione push gia' presente
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
  // Il tocco su una notifica chiede alla finestra aperta di aprire la chat giusta.
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const data = ev.data;
    if (data?.type === 'navigate' && typeof data.hash === 'string' && /^#\/[\w\-/%.]*$/.test(data.hash)) {
      location.hash = data.hash;
    }
  });
}

async function boot() {
  mode = 'boot';
  let session;
  try {
    session = await api.get('/api/session');
  } catch {
    mountUnreachable(root, { onRetry: boot });
    return;
  }
  if (!session.authenticated) {
    showLogin();
    return;
  }
  enterApp();
}

initViewport();
registerServiceWorker();
onUnauthorized(showLogin);
window.addEventListener('hashchange', mountRoute);
// Gli orari relativi ("3 min fa") si aggiornano anche senza nuovi dati.
setInterval(() => {
  if (mode === 'app' && document.visibilityState === 'visible') view?.update?.(getLive());
}, 30_000);
boot();
