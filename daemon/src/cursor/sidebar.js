// Order and state (collapsed/expanded) of groups in the Agents Window sidebar.
//
// Cursor saves settings in `ItemTable` (global db), key `cursor/glassSidebarSettings`:
//   { groupBy, sortGroupsBy: "manual"|"updated", sortAgentsBy, sectionOrderByGroupBy:{<groupBy>:[id]},
//     collapsedSectionIdsByGroupBy:{<groupBy>:[id]}, removedSectionIds:[id] }
//
// "manual" sort algorithm (from the bundle, functions s3v/LO0/o3v, to be confirmed visually with the user):
//   [sections NOT in saved order, in default order] + [saved order filtered to present sections]
// Default order: last activity (max lastUpdatedAt) descending, then by label.
//
// Known limit: `removedSectionIds` (sections manually removed from the sidebar) is not handled: no real case
// in the user's data. Cursor internal detail: keep in `daemon/src/cursor/`.

/** Sorts `sections` ([{id, label, lastUpdatedAt}]) as the sidebar would. Returns a new array. */
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
