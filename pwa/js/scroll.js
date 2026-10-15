// Vertical scroll of the current screen.
//
// On screens with the bottom bar (lists, settings) the page does not scroll: only the `#app` container
// scrolls and the document stays fixed. On iOS bounce at the end applies to content, never the bar,
// which can no longer move. On chats (composer at bottom, keyboard) the window scrolls as before.
const appEl = () => document.getElementById('app');
const inner = () => document.body.classList.contains('has-tabbar');

export const scrollTop = () => (inner() ? appEl().scrollTop : window.scrollY);
export const scrollToY = (y) => {
  if (inner()) appEl().scrollTop = y;
  else window.scrollTo(0, y);
};
