// Compatibility canary for Cursor's database.
//
// The daemon reads Cursor's database with SQL and `json_extract`. If Cursor renames a column the query throws and the daemon
// reports it, but if Cursor MOVES a field inside the JSON, `json_extract` simply returns NULL and detection would stop without
// any error: no red dot, no push, nothing. This module looks for exactly that, using only the structure of a few recent chats
// (column names and JSON field types, never content) and returns short reason codes.
//
// Rules of thumb that keep it quiet on healthy installs:
//  - a reason is raised only when EVERY examined sample fails the same check (one odd chat is not a format change);
//  - no evidence (no chats, no tool bubble among the samples) means no reason;
//  - queries go by composerId, the database is never scanned.

/** Columns and JSON fields the reader relies on. */
export const REQUIRED_COLUMNS = Object.freeze({
  composerHeaders: ['composerId', 'workspaceId', 'lastUpdatedAt', 'isArchived', 'isSubagent', 'value'],
  cursorDiskKV: ['key', 'value'],
  ItemTable: ['key', 'value'],
});

export const REASONS = Object.freeze([
  'schema_missing', // a table or column the daemon reads is gone
  'no_visible_chats', // headers exist but none is recognized as a visible local chat
  'composer_data_missing', // chats exist but their `composerData` rows were not found
  'bubble_list_changed', // `composerData` no longer has the bubble list where expected
  'bubble_rows_missing', // the last bubble of a chat cannot be found
  'bubble_type_changed', // bubbles no longer have an integer `type`
  'tool_fields_changed', // tool bubbles lost `toolFormerData.name` / `toolCallId`
]);

const SAMPLE_SIZE = 5;
const MIN_HEADERS_FOR_VISIBILITY = 5;

/**
 * @param {import('./db.js').CursorDb} db  an OPEN database
 * @param {{ visibleCount?: number | null, sampleSize?: number }} [opts]
 *   `visibleCount`: how many chats the watcher currently shows (null = unknown, skips that check).
 * @returns {{ reasons: string[], examined: number }}
 */
export function evaluateDbCompat(db, { visibleCount = null, sampleSize = SAMPLE_SIZE } = {}) {
  const reasons = [];

  const cols = db.schemaColumns();
  const missingSchema = Object.entries(REQUIRED_COLUMNS).some(([table, needed]) => needed.some((c) => !(cols[table] ?? []).includes(c)));
  if (missingSchema) return { reasons: ['schema_missing'], examined: 0 };

  const headers = db.listHeaders();
  if (visibleCount !== null && headers.length >= MIN_HEADERS_FOR_VISIBILITY && visibleCount === 0) reasons.push('no_visible_chats');

  const sample = [...headers].sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0)).slice(0, sampleSize);
  if (sample.length === 0) return { reasons, examined: 0 };

  const composers = sample.map((h) => ({ id: h.id, shape: db.composerShape(h.id) }));
  const present = composers.filter((c) => c.shape);
  if (present.length === 0) {
    reasons.push('composer_data_missing');
    return { reasons, examined: sample.length };
  }
  // A brand-new empty chat may not have the bubble list yet: with a single sample that proves nothing, so ask for two.
  const withList = present.filter((c) => c.shape.headersType === 'array');
  if (present.length >= 2 && withList.length === 0) {
    reasons.push('bubble_list_changed');
    return { reasons, examined: sample.length };
  }

  const lasts = withList.filter((c) => c.shape.lastBubbleId).map((c) => ({ id: c.id, bubble: db.bubbleShape(c.id, c.shape.lastBubbleId) }));
  if (lasts.length > 0 && lasts.every((l) => !l.bubble)) {
    reasons.push('bubble_rows_missing');
    return { reasons, examined: sample.length };
  }
  const found = lasts.filter((l) => l.bubble).map((l) => l.bubble);
  if (found.length > 0 && found.every((b) => b.typeType !== 'integer')) reasons.push('bubble_type_changed');
  const tools = found.filter((b) => b.toolType === 'object');
  if (tools.length > 0 && tools.every((b) => b.toolNameType !== 'text' || b.toolCallIdType !== 'text')) reasons.push('tool_fields_changed');

  return { reasons, examined: sample.length };
}
