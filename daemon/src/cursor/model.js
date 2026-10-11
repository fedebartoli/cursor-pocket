// Modello del dominio: funzioni PURE che interpretano gli header e le "code" delle chat di Cursor.
//
// Tutte le regole qui sotto sono state verificate nella Fase 0 (vedi docs/FINDINGS.md, sezione 8):
//  - chat visibile = non archiviata, non sottoagente, non bozza, con attivita' (lastUpdatedAt > 0),
//    in locale (agentLocation nullo = chat classica, `local` o `worktree`);
//  - "Need attention" come il pallino rosso di Cursor: hasBlockingPendingActions oppure hasPendingPlan;
//  - il flag da solo non dice di che richiesta si tratta: si guarda l'ultimo bubble. Una domanda (ask_question)
//    e' `loading` solo per pochi secondi: poi il turno dell'agente finisce e il bubble diventa `completed` con
//    additionalData.status `pending`, ma la domanda resta in attesa (e il flag acceso) fino alla risposta
//    (`submitted`). Per questo "in attesa" si decide su additionalData.status, non sullo stato del tool
//    (traccia dal vivo, FINDINGS 9.1);
//  - un'approvazione ("allow" di un comando, di un tool MCP, di una richiesta web...) e' un tool bubble con
//    additionalData.reviewData.status === 'Requested', cercato come fa Cursor tra gli ULTIMI DUE bubble (FINDINGS 11).
//
// Dettaglio interno di Cursor: tenuto in `daemon/src/cursor/`.
import { clampStr } from '../util.js';

/**
 * @param {object} entry riga di listHeaders()
 * @param {object} [o]
 * @param {boolean} [o.includeClassic]  mostra anche le chat classiche (agentLocation nullo)
 * @param {Set<string>} [o.removedWorkspaceIds]  workspace dei progetti rimossi dalla sidebar (CursorDb.removedWorkspaceIds)
 * @returns {boolean} true se la chat va mostrata (stessa definizione della sidebar, vedi FINDINGS 8.2).
 */
export function isVisibleLocalChat(entry, { includeClassic = true, removedWorkspaceIds } = {}) {
  const h = entry.header || {};
  if (h.isDraft === true || h.isArchived === true || h.isSubagent === true) return false;
  if (!(entry.lastUpdatedAt > 0)) return false;
  // Le chat di un progetto rimosso dalla sidebar non compaiono nell'Agents Window, anche se non sono archiviate.
  if (removedWorkspaceIds?.size) {
    if (removedWorkspaceIds.has(entry.workspaceId) || removedWorkspaceIds.has(h.workspaceIdentifier?.id)) return false;
  }
  const loc = h.agentLocation;
  if (loc) return loc.type === 'local' || loc.type === 'worktree';
  return includeClassic;
}

/**
 * Una chat e' "in corso" se l'header porta il marcatore `unfinishedRunAt` (valorizzato da Cursor solo mentre
 * la composer e' in generazione). Se e' troppo vecchio e' un residuo (Cursor chiuso durante la run).
 */
export function isRunning(header, now, staleRunMs) {
  const at = header?.unfinishedRunAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return now - at < staleRunMs;
}

/** Firma dei campi dell'header che, se cambiano, richiedono di rileggere la "coda" della chat. */
export function headerSignature(entry) {
  const h = entry.header || {};
  return [
    entry.lastUpdatedAt,
    h.hasBlockingPendingActions === true ? 1 : 0,
    h.hasPendingPlan === true ? 1 : 0,
    h.unfinishedRunAt ?? '',
    h.hasUnreadMessages === true ? 1 : 0,
  ].join('|');
}

/**
 * Domanda (`ask_question`) ancora senza risposta.
 * Ciclo di vita osservato dal vivo: creazione con tool `loading`; dopo 5-33 s il bubble passa a `completed` con
 * additionalData.status `pending` (il turno e' finito, la domanda aspetta); alla risposta diventa `submitted`.
 */
export function isPendingQuestion(tool) {
  if (!tool || tool.name !== 'ask_question') return false;
  if (tool.additionalStatus === 'submitted') return false;
  return tool.status === 'loading' || tool.additionalStatus === 'pending';
}

/**
 * Per quanto una domanda senza risposta si considera "appena posta" (dalla creazione del bubble). Deve coprire un ciclo
 * di scrittura dell'header di Cursor (60 s) con margine: oltre, il flag nell'header e' gia' arrivato.
 */
export const FRESH_QUESTION_MS = 120_000;

const AUTOMATIC_APPROVALS = new Set(['allowlist', 'full_auto']);

/** Valore di `reviewData.status` mentre Cursor mostra la richiesta di approvazione all'utente (enum: None, Requested, Done). */
export const REVIEW_REQUESTED = 'Requested';

/**
 * Tool in attesa di approvazione dell'utente: il bubble ha `reviewData.status === 'Requested'` (Cursor: "card" con
 * Run/Skip). `reviewData` compare SOLO quando serve una revisione (2 bubble su 5274 nei dati reali), quindi il segnale
 * e' specifico: a differenza di un tool `loading`, un comando in esecuzione non ce l'ha mai (FINDINGS 9.1, 11).
 * Escluse le domande (hanno il loro percorso) e i piani (flag `hasPendingPlan`, `reviewData` resta `Requested` per ore).
 */
/** Tool di terminale: gli unici di cui si sa pilotare l'approvazione (carta `.ui-shell-tool-call` di Cursor). */
export const SHELL_TOOLS = new Set(['run_terminal_command_v2', 'run_terminal_command', 'run_terminal_cmd']);

export function isPendingReview(tool) {
  if (!tool?.review) return false;
  if (tool.name === 'ask_question' || tool.name === 'create_plan') return false;
  // Approvazione automatica (lista consentita o modalita' "full auto": enum `approvalType` nel bundle): la decide Cursor
  // in un attimo, non c'e' nessuno da aspettare. Un tipo sconosciuto o assente NON esclude: meglio una notifica in piu'.
  if (AUTOMATIC_APPROVALS.has(tool.review.approvalType)) return false;
  return tool.review.status === REVIEW_REQUESTED;
}

/**
 * Classifica l'attenzione richiesta da una chat. Funzione pura: nessuno stato.
 *
 * @param {object} p
 * @param {object} p.entry          riga di listHeaders()
 * @param {object|null} p.tail      CursorDb.composerTail() (puo' mancare)
 * @param {object|null} p.bubble    CursorDb.bubbleSummary() dell'ultimo bubble (puo' mancare)
 * @param {object|null} [p.prevBubble] CursorDb.bubbleSummary() del penultimo bubble (cerca l'approvazione in sospeso)
 * @param {boolean} [p.running]     la chat sta lavorando adesso (header + stato del composer)
 * @param {number} p.now
 * @returns {null | {kind: 'domanda'|'approvazione'|'piano'|'residuo', key: string, live: boolean, since: number,
 *                   toolName: string|null, toolCallId: string|null, bubbleId: string|null}}
 */
export function classifyAttention({ entry, tail, bubble, prevBubble = null, running = false, now }) {
  const h = entry.header || {};
  const flag = h.hasBlockingPendingActions === true;
  const plan = h.hasPendingPlan === true;

  const lastId = tail?.lastBubble?.id ?? null;
  const tool = bubble?.tool ?? null;
  const baseSince = entry.lastUpdatedAt || entry.createdAt || now;

  // L'header (da cui viene il flag) Cursor lo scrive IN RITARDO: osservato dal vivo +4,8 s e +41 s dalla domanda, perche'
  // aspetta una scrittura generale oppure quella periodica ogni 60 s (FINDINGS 9.7). Il bubble invece c'e' subito: una
  // domanda senza risposta e RECENTE e' viva anche a flag spento, cosi' la notifica non aspetta l'header. Solo recente:
  // senza il flag una domanda vecchia puo' essere un residuo (es. tool rimasto `loading` per una run interrotta).
  const pending = isPendingQuestion(tool);
  const fresh = pending && typeof bubble?.createdAt === 'number' && now - bubble.createdAt <= FRESH_QUESTION_MS;

  if (pending && (flag || fresh)) {
    // Verificato dal vivo (FINDINGS 9.1): flag acceso + ultimo bubble `ask_question` senza risposta.
    // La chiave e' il toolCallId: resta uguale anche se Cursor riscrive il bubble (cambia `createdAt`).
    return {
      kind: 'domanda',
      key: tool.toolCallId || `b:${lastId}`,
      live: true,
      since: bubble.createdAt ?? baseSince,
      toolName: tool.name,
      toolCallId: tool.toolCallId,
      bubbleId: lastId,
    };
  }
  // Approvazione di un tool (FINDINGS 11). NON da `loading` + assenza di `userDecision`: quell'ipotesi fu smentita dal
  // vivo (FINDINGS 9.1: un comando in esecuzione ha lo stesso aspetto, 68 eventi falsi in 28 minuti). Il segnale vero e'
  // `reviewData.status === 'Requested'`, cercato tra gli ultimi due bubble come fa Cursor. E' viva se il flag e' acceso,
  // se la chat sta lavorando (l'agente e' fermo in attesa) o se e' appena comparsa (l'header arriva in ritardo): una
  // richiesta rimasta `Requested` in una chat ferma e senza flag e' un residuo (es. Cursor chiuso a meta') e non conta.
  const reviewBubble = isPendingReview(tool) ? bubble : isPendingReview(prevBubble?.tool) ? prevBubble : null;
  if (reviewBubble) {
    const rt = reviewBubble.tool;
    const rid = reviewBubble === bubble ? lastId : (tail?.prevBubble?.id ?? null);
    const freshReview = typeof reviewBubble.createdAt === 'number' && now - reviewBubble.createdAt <= FRESH_QUESTION_MS;
    if (flag || running || freshReview) {
      return {
        kind: 'approvazione',
        key: rt.toolCallId || `b:${rid}`,
        live: true,
        since: reviewBubble.createdAt ?? baseSince,
        toolName: rt.name,
        toolCallId: rt.toolCallId,
        bubbleId: rid,
      };
    }
  }

  if (!flag && !plan) return null;

  if (flag) {
    // Flag acceso ma l'ultimo bubble non e' una domanda aperta (es. domanda gia' risposta o superata da altri
    // messaggi, oppure la chat sta lavorando): residuo "appiccicato" di Cursor, che non ha ricalcolato il flag.
    return {
      kind: 'residuo',
      key: tool?.toolCallId || (lastId ? `b:${lastId}` : 'chat'),
      live: false,
      since: baseSince,
      toolName: tool?.name ?? null,
      toolCallId: tool?.toolCallId ?? null,
      bubbleId: lastId,
    };
  }

  return {
    kind: 'piano',
    key: `plan:${lastId ?? 'chat'}`,
    live: false,
    since: baseSince,
    toolName: null,
    toolCallId: null,
    bubbleId: lastId,
  };
}

/** Vista pubblica di una chat (nessun percorso, nessun dato grezzo di Cursor). */
export function buildChat({ entry, ws, attention, now, staleRunMs, running }) {
  const h = entry.header || {};
  return {
    id: entry.id,
    name: clampStr(typeof h.name === 'string' && h.name.trim() ? h.name.trim() : 'Senza titolo', 200),
    subtitle: clampStr(typeof h.subtitle === 'string' ? h.subtitle.trim() : '', 300),
    mode: typeof h.unifiedMode === 'string' ? h.unifiedMode : null,
    sectionId: ws.sectionId,
    workspaceName: ws.name,
    workspaceParent: ws.parent,
    workspaceHome: ws.home,
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
    lastUpdatedAt: entry.lastUpdatedAt,
    unread: h.hasUnreadMessages === true,
    // `running` puo' arrivare dal watcher (header + stato del composer); senza, vale solo l'header.
    running: typeof running === 'boolean' ? running : isRunning(h, now, staleRunMs),
    attention,
  };
}
