// "Come funziona": explanations that do not belong on working screens.
import { appbar } from '../components.js';
import { h, replace } from '../dom.js';
import { t } from '../i18n/index.js';

function helpSections() {
  return [
    {
      title: t('help.sectionTabs'),
      items: [t('help.tabsItem1'), t('help.tabsItem2'), t('help.tabsItem3')],
    },
    {
      title: t('help.sectionRequests'),
      items: [t('help.requestsItem1'), t('help.requestsItem2'), t('help.requestsItem3')],
    },
    {
      title: t('help.sectionManage'),
      items: [t('help.manageItem1'), t('help.manageItem2'), t('help.manageItem3'), t('help.manageItem4')],
    },
    {
      title: t('help.sectionAwake'),
      items: [t('help.awakeItem1'), t('help.awakeItem2'), t('help.awakeItem3')],
    },
    {
      title: t('help.sectionNotifications'),
      items: [t('help.notifItem1'), t('help.notifItem2')],
    },
  ];
}

export function mountHelp(root) {
  const sections = helpSections();
  replace(
    root,
    h(
      'div.screen',
      null,
      appbar({ title: t('help.title'), backHref: '#/impostazioni' }),
      sections.map((s) => h('section', { class: 'panel help' }, h('h2', { class: 'help-title' }, s.title), h('ul', { class: 'help-list' }, s.items.map((text) => h('li', null, text))))),
    ),
  );
  return {};
}
