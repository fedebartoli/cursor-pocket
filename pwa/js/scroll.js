// Scorrimento verticale della schermata corrente.
//
// Nelle schermate con la barra in basso (elenchi, impostazioni) la pagina non scorre: scorre solo il contenitore
// `#app` e il documento resta fermo. Cosi' su iOS il rimbalzo di fine corsa riguarda il contenuto e mai la barra,
// che non puo' piu' muoversi. Nelle chat (compositore in fondo, tastiera) scorre invece la finestra, come prima.
const appEl = () => document.getElementById('app');
const inner = () => document.body.classList.contains('has-tabbar');

export const scrollTop = () => (inner() ? appEl().scrollTop : window.scrollY);
export const scrollToY = (y) => {
  if (inner()) appEl().scrollTop = y;
  else window.scrollTo(0, y);
};
