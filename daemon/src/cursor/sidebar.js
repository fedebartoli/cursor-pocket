// Ordine e stato (compresso/espanso) dei gruppi nella sidebar dell'Agents Window.
//
// Cursor salva la configurazione in `ItemTable` (db globale), chiave `cursor/glassSidebarSettings`:
//   { groupBy, sortGroupsBy: "manual"|"updated", sortAgentsBy, sectionOrderByGroupBy:{<groupBy>:[id]},
//     collapsedSectionIdsByGroupBy:{<groupBy>:[id]}, removedSectionIds:[id] }
//
// Algoritmo di ordinamento "manual" (dal bundle, funzioni s3v/LO0/o3v, da confermare visivamente con l'utente):
//   [sezioni NON presenti nell'ordine salvato, in ordine predefinito] + [ordine salvato filtrato sulle sezioni presenti]
// Ordine predefinito: ultima attivita' (max lastUpdatedAt) decrescente, a parita' per etichetta.
//
// Limite noto: `removedSectionIds` (sezioni rimosse a mano dalla sidebar) non e' gestito: nessun caso reale
// nei dati dell'utente. Dettaglio interno di Cursor: tenuto in `daemon/src/cursor/`.

/** Ordina `sections` ([{id, label, lastUpdatedAt}]) come farebbe la sidebar. Ritorna un nuovo array. */
export function orderSections(sections, settings, groupBy = 'workspace') {
  const byDefault = [...sections].sort((a, b) => {
    if (b.lastUpdatedAt !== a.lastUpdatedAt) return b.lastUpdatedAt - a.lastUpdatedAt;
    return String(a.label).localeCompare(String(b.label), 'it');
  });
  if ((settings?.sortGroupsBy ?? 'manual') !== 'manual') return byDefault;

  const saved = Array.isArray(settings?.sectionOrderByGroupBy?.[groupBy]) ? settings.sectionOrderByGroupBy[groupBy] : [];
  if (!saved.length) return byDefault;
  const byId = new Map(sections.map((s) => [s.id, s]));
  const savedSet = new Set(saved);
  const unsaved = byDefault.filter((s) => !savedSet.has(s.id));
  const inSaved = [];
  const seen = new Set();
  for (const id of saved) {
    const s = byId.get(id);
    if (s && !seen.has(id)) {
      seen.add(id);
      inSaved.push(s);
    }
  }
  return [...unsaved, ...inSaved];
}

export function collapsedIds(settings, groupBy = 'workspace') {
  const list = settings?.collapsedSectionIdsByGroupBy?.[groupBy];
  return new Set(Array.isArray(list) ? list : []);
}
