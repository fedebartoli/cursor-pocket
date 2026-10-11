import test from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_QUESTION_MS, buildChat, classifyAttention, headerSignature, isPendingQuestion, isPendingReview, isRunning, isVisibleLocalChat } from '../src/cursor/model.js';
import { normalizeQuestionParams } from '../src/cursor/questions.js';

const NOW = 1_700_000_000_000;
const entry = (header = {}, extra = {}) => ({ id: 'c1', workspaceId: 'w', createdAt: NOW - 1000, lastUpdatedAt: NOW - 500, header, ...extra });

test('visibilita\': non archiviata, non sottoagente, non bozza, con attivita\', in locale', () => {
  const loc = { type: 'local', status: 'active', environment: { id: 'e' } };
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc })), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: { ...loc, type: 'worktree' } })), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: { ...loc, type: 'remote-ssh' } })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: { type: 'cloud' } })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, isDraft: true })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, isArchived: true })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, isSubagent: true })), false);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { lastUpdatedAt: 0 })), false, 'chat vuota');
  // chat classica (agentLocation nullo): dipende dall'opzione
  assert.equal(isVisibleLocalChat(entry({}), { includeClassic: true }), true);
  assert.equal(isVisibleLocalChat(entry({}), { includeClassic: false }), false);
});

test('visibilita\': le chat di un progetto RIMOSSO dalla sidebar non compaiono, anche se non archiviate', () => {
  const loc = { type: 'local', status: 'active', environment: { id: 'e' } };
  const removed = new Set(['ws-rimosso']);
  // colonna workspaceId dell'header
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-rimosso' }), { removedWorkspaceIds: removed }), false);
  // oppure workspaceIdentifier.id dentro l'header (stesso id)
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc, workspaceIdentifier: { id: 'ws-rimosso' } }, { workspaceId: 'altro' }), { removedWorkspaceIds: removed }), false);
  // un altro workspace resta visibile; elenco vuoto o assente non nasconde nulla
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-vivo' }), { removedWorkspaceIds: removed }), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-rimosso' }), { removedWorkspaceIds: new Set() }), true);
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: 'ws-rimosso' })), true);
  // chat senza alcun id di workspace: non si puo' dire che sia rimossa
  assert.equal(isVisibleLocalChat(entry({ agentLocation: loc }, { workspaceId: null }), { removedWorkspaceIds: removed }), true);
});

test('in corso: marcatore unfinishedRunAt recente; residuo se troppo vecchio', () => {
  const stale = 12 * 3_600_000;
  assert.equal(isRunning({ unfinishedRunAt: NOW - 1000 }, NOW, stale), true);
  assert.equal(isRunning({ unfinishedRunAt: NOW - stale - 1 }, NOW, stale), false, 'Cursor chiuso durante la run');
  assert.equal(isRunning({}, NOW, stale), false);
  assert.equal(isRunning({ unfinishedRunAt: 'x' }, NOW, stale), false);
});

test('classifyAttention: nessun flag, nessuna attenzione', () => {
  assert.equal(classifyAttention({ entry: entry({}), tail: null, bubble: null, now: NOW }), null);
});

test('classifyAttention: header in ritardo, domanda RECENTE senza risposta = viva anche a flag spento', () => {
  const ask = (createdAt, tool = {}) => ({
    entry: entry({}), // nessun flag: l'header di Cursor non e' ancora stato riscritto
    tail: { lastBubble: { id: 'b9' } },
    bubble: { createdAt, tool: { name: 'ask_question', status: 'loading', toolCallId: 'tc-9', ...tool } },
    now: NOW,
  });
  // appena posta (loading) e dopo il passaggio a completed/pending: stessa domanda, stessa chiave
  for (const tool of [{}, { status: 'completed', additionalStatus: 'pending' }]) {
    const a = classifyAttention(ask(NOW - 3000, tool));
    assert.deepEqual({ kind: a.kind, live: a.live, key: a.key, since: a.since }, { kind: 'domanda', live: true, key: 'tc-9', since: NOW - 3000 });
  }
  // confini della finestra
  assert.equal(classifyAttention(ask(NOW - FRESH_QUESTION_MS)).live, true);
  assert.equal(classifyAttention(ask(NOW - FRESH_QUESTION_MS - 1)), null, 'oltre la finestra, a flag spento, non e\' una richiesta viva');
  // gia' risposta, annullata o diversa da ask_question: mai viva
  assert.equal(classifyAttention(ask(NOW - 3000, { status: 'completed', additionalStatus: 'submitted' })), null);
  assert.equal(classifyAttention(ask(NOW - 3000, { status: 'completed', additionalStatus: 'cancelled' })), null);
  assert.equal(classifyAttention(ask(NOW - 3000, { name: 'run_terminal_command_v2' })), null);
  // bubble senza orario: non si puo' dire che sia recente
  assert.equal(classifyAttention(ask(null)), null);
});

test('classifyAttention: domanda viva = flag + ultimo bubble ask_question in loading', () => {
  const a = classifyAttention({
    entry: entry({ hasBlockingPendingActions: true }),
    tail: { lastBubble: { id: 'b9' } },
    bubble: { createdAt: NOW - 100, tool: { name: 'ask_question', status: 'loading', toolCallId: 'tc-9' } },
    now: NOW,
  });
  assert.deepEqual({ kind: a.kind, key: a.key, live: a.live, since: a.since, bubbleId: a.bubbleId }, { kind: 'domanda', key: 'tc-9', live: true, since: NOW - 100, bubbleId: 'b9' });
});

test('isPendingQuestion: loading o completed con additionalData pending; risposta data, annullata o altro tool no', () => {
  const q = (status, additionalStatus, name = 'ask_question') => ({ name, status, additionalStatus });
  assert.equal(isPendingQuestion(q('loading')), true, 'primi secondi');
  assert.equal(isPendingQuestion(q('completed', 'pending')), true, 'turno finito, domanda ancora senza risposta');
  assert.equal(isPendingQuestion(q('completed', 'submitted')), false);
  assert.equal(isPendingQuestion(q('loading', 'submitted')), false);
  assert.equal(isPendingQuestion(q('completed', 'cancelled')), false);
  assert.equal(isPendingQuestion(q('completed')), false, 'senza stato aggiuntivo non e\' dimostrabile: non si considera in attesa');
  assert.equal(isPendingQuestion(q('loading', null, 'run_terminal_command_v2')), false);
  assert.equal(isPendingQuestion(null), false);
});

test('classifyAttention: la domanda resta una domanda dopo il passaggio a completed/pending (ciclo di vita reale)', () => {
  const base = { entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b9' } }, now: NOW };
  const loading = classifyAttention({ ...base, bubble: { createdAt: NOW - 100, tool: { name: 'ask_question', status: 'loading', toolCallId: 't2' } } });
  const completed = classifyAttention({ ...base, bubble: { createdAt: NOW - 100, tool: { name: 'ask_question', status: 'completed', toolCallId: 't2', additionalStatus: 'pending' } } });
  assert.deepEqual({ kind: completed.kind, key: completed.key, live: completed.live }, { kind: 'domanda', key: 't2', live: true });
  assert.equal(completed.key, loading.key, 'stessa chiave nei due stati: nessuna seconda notifica');
  // Cursor puo' riscrivere il bubble (cambia createdAt): la chiave non cambia
  const rewritten = classifyAttention({ ...base, bubble: { createdAt: NOW + 5_000_000, tool: { name: 'ask_question', status: 'completed', toolCallId: 't2', additionalStatus: 'pending' } } });
  assert.equal(rewritten.key, 't2');
});

test('classifyAttention: domanda gia\' risposta (submitted) o annullata con flag ancora acceso = residuo, non viva', () => {
  const base = { entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b9' } }, now: NOW };
  const submitted = classifyAttention({ ...base, bubble: { tool: { name: 'ask_question', status: 'loading', toolCallId: 't', additionalStatus: 'submitted' } } });
  assert.equal(submitted.live, false);
  assert.equal(submitted.kind, 'residuo');
  const answered = classifyAttention({ ...base, bubble: { tool: { name: 'ask_question', status: 'completed', toolCallId: 't2', additionalStatus: 'submitted' } } });
  assert.equal(answered.kind, 'residuo');
  assert.equal(answered.key, 't2', 'la chiave resta il toolCallId: una NUOVA domanda ha chiave diversa');
  const cancelled = classifyAttention({ ...base, bubble: { tool: { name: 'ask_question', status: 'completed', toolCallId: 't3', additionalStatus: 'cancelled' } } });
  assert.equal(cancelled.kind, 'residuo');
  // una domanda superata da altri messaggi (ultimo bubble di testo) non e' piu' l'ultima cosa: residuo
  const superseded = classifyAttention({ ...base, bubble: { tool: null } });
  assert.equal(superseded.kind, 'residuo');
  // senza flag, anche una domanda in attesa nel bubble non conta: Cursor non mostra il pallino
  const noFlag = classifyAttention({ entry: entry({}), tail: { lastBubble: { id: 'b9' } }, bubble: { tool: { name: 'ask_question', status: 'completed', toolCallId: 't4', additionalStatus: 'pending' } }, now: NOW });
  assert.equal(noFlag, null);
});

test('classifyAttention: un tool diverso da ask_question NON e\' mai una richiesta viva (regressione: 68 eventi falsi)', () => {
  // Caso reale (FINDINGS 9.1): chat con il flag acceso da una vecchia domanda irrisolta, ora al lavoro: ogni comando
  // parte `loading` senza `userDecision`, esattamente come apparirebbe un'approvazione. Non si puo' distinguere:
  // quindi mai `live`, mai una notifica.
  const base = { entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b3' } }, now: NOW };
  for (const name of ['run_terminal_command_v2', 'edit_file_v2', 'mcp-cursor-ide-browser-browser_click', 'task_v2']) {
    const a = classifyAttention({ ...base, bubble: { createdAt: NOW, tool: { name, status: 'loading', toolCallId: `tc-${name}` } } });
    assert.equal(a.kind, 'residuo', name);
    assert.equal(a.live, false, name);
  }
  const decided = classifyAttention({ ...base, bubble: { tool: { name: 'run_terminal_command_v2', status: 'loading', toolCallId: 'tc-y', userDecision: 'accepted' } } });
  assert.equal(decided.kind, 'residuo');
});

test('isPendingReview: solo reviewData Requested; domande e piani hanno il loro percorso', () => {
  const t = (name, status, approvalType = 'user') => ({ name, review: status ? { status, approvalType } : null });
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested')), true);
  assert.equal(isPendingReview(t('mcp-cursor-ide-browser-browser_click', 'Requested')), true, 'nome MCP qualsiasi');
  // approvazioni automatiche (lista consentita, "full auto"): le decide Cursor, nessuno da aspettare
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', 'full_auto')), false);
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', 'allowlist')), false);
  // tipo assente o sconosciuto: non esclude (meglio una notifica in piu' che una persa)
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', null)), true);
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Requested', 'qualcosa-di-nuovo')), true);
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'Done')), false, 'gia\' decisa');
  assert.equal(isPendingReview(t('run_terminal_command_v2', 'None')), false);
  assert.equal(isPendingReview(t('run_terminal_command_v2', null)), false, 'senza reviewData: un comando in esecuzione');
  assert.equal(isPendingReview(t('ask_question', 'Requested')), false);
  assert.equal(isPendingReview(t('create_plan', 'Requested')), false, 'il piano ha il suo flag e resta Requested per ore');
  assert.equal(isPendingReview(null), false);
  assert.equal(isPendingReview({ name: 'run_terminal_command_v2' }), false);
});

test('classifyAttention: approvazione = reviewData Requested negli ultimi due bubble (FINDINGS 11)', () => {
  const review = (extra = {}) => ({ name: 'run_terminal_command_v2', status: 'loading', toolCallId: 'tc-ap', review: { status: 'Requested', approvalType: 'user' }, ...extra });
  const last = { id: 'b5' };
  const prev = { id: 'b4' };
  const base = { entry: entry({}), tail: { lastBubble: last, prevBubble: prev }, now: NOW };

  // Appena comparsa: l'header non e' ancora stato riscritto (nessun flag) ma la richiesta e' fresca = viva.
  const fresh = classifyAttention({ ...base, bubble: { createdAt: NOW - 3000, tool: review() } });
  assert.deepEqual(
    { kind: fresh.kind, key: fresh.key, live: fresh.live, toolName: fresh.toolName, toolCallId: fresh.toolCallId, bubbleId: fresh.bubbleId, since: fresh.since },
    { kind: 'approvazione', key: 'tc-ap', live: true, toolName: 'run_terminal_command_v2', toolCallId: 'tc-ap', bubbleId: 'b5', since: NOW - 3000 },
  );

  // Vecchia, senza flag e chat ferma: residuo di Cursor chiuso a meta' (nessun pallino in Cursor) = nessuna attenzione.
  const old = { createdAt: NOW - FRESH_QUESTION_MS - 1000, tool: review() };
  assert.equal(classifyAttention({ ...base, bubble: old }), null);
  // Vecchia ma la chat sta lavorando (l'agente e' fermo ad aspettarti) oppure il flag e' acceso: viva.
  assert.equal(classifyAttention({ ...base, bubble: old, running: true }).live, true);
  assert.equal(classifyAttention({ ...base, entry: entry({ hasBlockingPendingActions: true }), bubble: old }).kind, 'approvazione');

  // Decisa (Done) o mai richiesta (None): non e' un'approvazione; con il flag acceso resta un residuo.
  for (const status of ['Done', 'None']) {
    const r = classifyAttention({ ...base, entry: entry({ hasBlockingPendingActions: true }), bubble: { createdAt: NOW, tool: review({ review: { status } }) } });
    assert.equal(r.kind, 'residuo', status);
    assert.equal(r.live, false, status);
  }

  // Cursor guarda gli ultimi DUE bubble: un messaggio arrivato dopo la richiesta non la nasconde.
  const viaPrev = classifyAttention({ ...base, bubble: { createdAt: NOW, tool: null }, prevBubble: { createdAt: NOW - 2000, tool: review({ toolCallId: undefined }) } });
  assert.deepEqual({ kind: viaPrev.kind, key: viaPrev.key, live: viaPrev.live, bubbleId: viaPrev.bubbleId }, { kind: 'approvazione', key: 'b:b4', live: true, bubbleId: 'b4' });

  // Un piano o una domanda con reviewData Requested seguono il loro percorso, non diventano approvazioni.
  const plan = classifyAttention({ ...base, entry: entry({ hasPendingPlan: true }), bubble: { createdAt: NOW, tool: review({ name: 'create_plan' }) } });
  assert.equal(plan.kind, 'piano');
  // Una domanda ancora aperta ha la precedenza anche se il bubble precedente chiedeva un'approvazione.
  const q = classifyAttention({
    ...base,
    bubble: { createdAt: NOW - 1000, tool: { name: 'ask_question', status: 'loading', toolCallId: 'tq' } },
    prevBubble: { createdAt: NOW - 2000, tool: review() },
  });
  assert.equal(q.kind, 'domanda');
});

test('classifyAttention: flag senza richiesta viva = residuo; senza bubble la chiave e\' "chat"', () => {
  const a = classifyAttention({ entry: entry({ hasBlockingPendingActions: true }), tail: null, bubble: null, now: NOW });
  assert.deepEqual({ kind: a.kind, key: a.key, live: a.live, since: a.since }, { kind: 'residuo', key: 'chat', live: false, since: NOW - 500 });
  const b = classifyAttention({ entry: entry({ hasBlockingPendingActions: true }), tail: { lastBubble: { id: 'b1' } }, bubble: { tool: null }, now: NOW });
  assert.equal(b.key, 'b:b1');
});

test('classifyAttention: piano in attesa', () => {
  const a = classifyAttention({ entry: entry({ hasPendingPlan: true }), tail: { lastBubble: { id: 'b4' } }, bubble: null, now: NOW });
  assert.deepEqual({ kind: a.kind, key: a.key, live: a.live }, { kind: 'piano', key: 'plan:b4', live: false });
});

test('headerSignature cambia quando cambiano i campi rilevanti', () => {
  const a = headerSignature(entry({ hasBlockingPendingActions: true }));
  assert.notEqual(a, headerSignature(entry({ hasBlockingPendingActions: false })));
  assert.notEqual(a, headerSignature(entry({ hasBlockingPendingActions: true, unfinishedRunAt: 5 })));
  assert.equal(a, headerSignature(entry({ hasBlockingPendingActions: true })));
});

test('buildChat: titolo di riserva e nessun percorso nella vista pubblica', () => {
  const ws = { sectionId: 's', name: 'app', parent: 'dev', home: false, path: '/Users/demo/app' };
  const chat = buildChat({ entry: entry({ name: '   ' }), ws, attention: null, now: NOW, staleRunMs: 1 });
  assert.equal(chat.name, 'Senza titolo');
  assert.equal(JSON.stringify(chat).includes('/Users/demo'), false);
});

test('buildChat: `running` esplicito prevale sull\'header (fine run vista dallo stato del composer)', () => {
  const ws = { sectionId: 's', name: 'app', parent: 'dev', home: false };
  const e = entry({ unfinishedRunAt: NOW - 1000 });
  assert.equal(buildChat({ entry: e, ws, attention: null, now: NOW, staleRunMs: 3_600_000 }).running, true, 'senza indicazione vale l\'header');
  assert.equal(buildChat({ entry: e, ws, attention: null, now: NOW, staleRunMs: 3_600_000, running: false }).running, false);
});

test('normalizeQuestionParams: forma stabile, limiti e valori non validi', () => {
  const q = normalizeQuestionParams(JSON.stringify({ title: 'T', questions: [{ id: 'q', prompt: 'P', options: [{ id: 'a', label: 'A' }, null, 'x'], allowMultiple: true }] }));
  assert.deepEqual(q, { title: 'T', questions: [{ id: 'q', prompt: 'P', options: [{ id: 'a', label: 'A' }], allowMultiple: true }] });
  assert.equal(normalizeQuestionParams('non json'), null);
  assert.equal(normalizeQuestionParams(null), null);
  assert.equal(normalizeQuestionParams('{}'), null);
  const many = normalizeQuestionParams({ questions: Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, prompt: 'x'.repeat(5000), options: [] })) });
  assert.equal(many.questions.length, 8);
  assert.ok(many.questions[0].prompt.length <= 1500);
});
