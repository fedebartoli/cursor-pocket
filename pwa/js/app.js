// App bootstrap: session, hash router, live connection, service worker.
import { api, onUnauthorized } from './api.js';
import { forgetCommit, h } from './dom.js';
import { initI18n, t } from './i18n/index.js';
import { icon } from './icons.js';
import { getLive, startLive, stopLive, subscribe } from './live.js';
import { resyncPush } from './push.js';
import { scrollToY, scrollTop } from './scroll.js';
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
let navigated = false; // true after the first screen: from then on focus follows navigation
let unsubscribeLive = null;
const scrollMemory = new Map();

// Bottom bar (thumb-reachable): Attention, Chats, Favorites, Settings. Visible only outside chats,
// where the composer sits at the bottom.
let tabBadge;
let tabEls;
let tabbar;

function buildTabbar() {
  tabBadge = h('span', { class: 'tab-badge', hidden: true });
  const tabDefs = [
    { route: 'home', href: '#/', label: t('app.tabAttention'), icon: 'inbox', badge: tabBadge },
    { route: 'chats', href: '#/chat', label: t('app.tabChats'), icon: 'messages' },
    { route: 'favorites', href: '#/preferite', label: t('app.tabFavorites'), icon: 'heart' },
    { route: 'settings', href: '#/impostazioni', label: t('app.tabSettings'), icon: 'settings' },
  ];
  tabEls = new Map(
    tabDefs.map((def) => [def.route, h('a', { class: 'tab', href: def.href }, h('span.tab-icon', null, icon(def.icon, { size: 24 }), def.badge ?? null), h('span.tab-label', null, def.label))]),
  );
  tabbar = h('nav', { class: 'tabbar', 'aria-label': t('app.mainNav'), hidden: true }, h('div.tabbar-inner', null, [...tabEls.values()]));
  document.body.append(tabbar);
}

function updateTabbar(routeName) {
  const visible = mode === 'app' && routeName !== 'chat' && routeName !== 'history' && routeName !== 'newchat';
  tabbar.hidden = !visible;
  document.body.classList.toggle('has-tabbar', visible);
  const active = routeName === 'help' || routeName === 'archive' ? 'settings' : routeName === 'newchat' ? 'chats' : routeName; // "How it works" lives under Settings
  for (const [route, el] of tabEls) {
    if (visible && route === active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function updateBadge(n) {
  tabBadge.hidden = n <= 0;
  tabBadge.textContent = n > 99 ? '99+' : String(n);
  tabEls.get('home').setAttribute('aria-label', n > 0 ? t('app.tabAttentionWithCount', { count: n }) : t('app.tabAttentionLabel'));
}

function parseRoute() {
  const hash = location.hash || '#/';
  const chat = /^#\/chat\/([^/?]+)$/.exec(hash);
  if (chat) {
    try {
      const id = decodeURIComponent(chat[1]);
      if (id) return { name: 'chat', id, key: `chat:${id}` };
    } catch {
      // malformed id: return to the list
    }
  }
  const hist = /^#\/chat\/([^/?]+)\/storia$/.exec(hash);
  if (hist) {
    try {
      const id = decodeURIComponent(hist[1]);
      if (id) return { name: 'history', id, key: `history:${id}` };
    } catch {
      // malformed id: return to the list
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
  scrollMemory.set(currentKey, scrollTop());
  view?.destroy?.();
  forgetCommit(root); // new view must always replace content, even if identical to the previous one
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
  // Restore list scroll position; other screens start at the top.
  const isList = ['home', 'chats', 'favorites'].includes(route.name);
  scrollToY(isList ? (scrollMemory.get(route.key) ?? 0) : 0);
  // Accessibility: after a screen change the screen reader starts at the new screen title.
  if (navigated) {
    root.querySelector('.appbar-title')?.focus({ preventScroll: true });
    // Brief fade (opacity only: a transform would move the fixed composer); off with "Reduce motion".
    root.classList.remove('enter');
    void root.offsetWidth; // restart animation
    root.classList.add('enter');
  }
  navigated = true;
}

function onLive(lv) {
  view?.update?.(lv);
  const n = lv.payload?.state?.counts?.attention ?? 0;
  updateBadge(n);
  document.title = n > 0 ? t('app.documentTitleWithCount', { count: n }) : TITLE;
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
    // badge not supported
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
  mountRoute(); // show skeleton immediately: data arrives from startLive
  await startLive();
  if (mode === 'app') resyncPush(); // after re-pairing, restore existing push registration
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
  // Tap on a notification asks the open window to open the right chat.
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

async function main() {
  await initI18n();
  buildTabbar();
  initViewport();
  registerServiceWorker();
  onUnauthorized(showLogin);
  window.addEventListener('hashchange', mountRoute);
  // Relative times ("3 min ago") update even without new data.
  setInterval(() => {
    if (mode === 'app' && document.visibilityState === 'visible') view?.update?.(getLive());
  }, 30_000);
  await boot();
}

main();
