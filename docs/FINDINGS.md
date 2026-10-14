# Findings (verificati su Cursor 3.24.6, macOS 26.5, Electron 42.10 / Chrome 148)

Legenda: [OK] provato dal vivo - [CODICE] letto nel bundle, non provato dal vivo - [NO] scartato.

## 1. Soluzioni esistenti (nessuna adatta)
- Remote Control ufficiale Cursor: mostra tutte le chat senza dividere per workspace, include le archiviate,
  inbox centrata sui cloud agents, nessuna notifica in tempo reale paragonabile all'app di Claude. [utente]
- nitech/auto e simili (CursorRemote ecc.): automazione via CDP/DOM, fragile, pensate per l'IDE classico.
- Recursor, omg.dev, Nexting, Codync e simili: sessioni CLI/ACP separate, NON le chat dell'Agents Window.
- Pushary (SaaS ~9.99 USD/mese): copre domande/approvazioni ma non le chat locali dell'Agents Window.
Conclusione: serve una soluzione custom.

## 2. Dati nel database di Cursor (sola lettura)
Percorso: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (~17 GB, SQLite).
- [OK] Tabella `composerHeaders(composerId PK, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency,
  checkpointAt, value TEXT(JSON), subagentTypeName)`. Esempio: 587 chat, 286 archiviate, 130 sottoagenti, 70 workspace attivi.
- [OK] Chiavi del JSON `value`: agentLocation, agentLocationHistory, composerId, contextUsagePercent,
  conversationCheckpointLastUpdatedAt, createdAt, filesChangedCount, forceMode, hasBlockingPendingActions, hasPendingPlan,
  hasUnreadMessages, isBestOfNSubcomposer, isDraft, isProject, isSpec, isWorktree, lastUpdatedAt, name, numSubComposers,
  referencedPlans, subtitle, totalLinesAdded, totalLinesRemoved, trackedGitRepos, type, unifiedMode, workspaceIdentifier,
  worktreeStartedReadOnly.
- Verificato in Fase 0 (vedi sezione 8): semantica di `hasBlockingPendingActions`, valori di `agentLocation`, dove Cursor
  salva l'ORDINE dei workspace nella sidebar, come riconoscere "in corso" e "finita".
- [OK] Mappa workspaceId -> cartella: `~/Library/Application Support/Cursor/User/workspaceStorage/<id>/workspace.json`
  (campo `folder`). Qualche workspace non e' mappabile cosi' (da indagare, `workspaceIdentifier` nel JSON).
- [OK] `cursorDiskKV`: chiavi `composerData:<composerId>` (JSON con `fullConversationHeadersOnly`, `status`,
  `generatingBubbleIds`, `queueItems`, ...) e `bubbleId:<composerId>:<bubbleId>` (messaggi e tool call).
- [OK, CORRETTO IN 9.1] Domanda nativa in attesa: l'ULTIMO bubble della chat ha `toolFormerData.name == "ask_question"`.
  `toolFormerData.status` e' `loading` solo nei primi 5-33 secondi; poi diventa `completed` con `additionalData.status ==
  "pending"` e cosi' resta (ore o giorni) fino alla risposta. (La prima versione di questa nota dava `loading` per tutta
  l'attesa: era una misura presa dentro quella finestra breve.) `toolFormerData.params` e' una stringa JSON:
  `{title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}`.
  A risposta data: `status == "completed"`, `additionalData = {status:"submitted", currentSelections:{qid:[optId|"__freeform_other__"]},
  freeformTexts:{qid:text}}`, `result` = JSON `{"answers":[{questionId, selectedOptionIds, freeformText}]}`.
- [OK] Latenza di rilevamento con polling a 1 s: la domanda e' vista come pendente entro ~1 s; una scansione delle 40 chat piu'
  recenti costa ~0.4 s.
- Il campo `status` di `composerData` per chat con agente in loop puo' restare "aborted"/"completed": non fidarsi da solo
  per capire se la chat e' finita; usare l'ultimo bubble e gli header.

## 3. Hook di Cursor (hooks.json)
- [OK] Funzionano nell'Agents Window. Eventi usati nei test: preToolUse, postToolUse, beforeShellExecution, beforeMCPExecution,
  afterMCPExecution, subagentStart/Stop, beforeSubmitPrompt, stop.
- [OK] Possono bloccare >= 100 s, negare con messaggio (`user_message` arriva, `agent_message` no), riscrivere gli input
  (anche MCP).
- [OK] NON scattano per: AskQuestion nativo, Glob, WebFetch. Quindi non si puo' intercettare la domanda nativa con un hook.
- [NON PROVATO] hook `stop` (non testabile in una chat in loop): da provare per "chat finita".

## 4. Tool MCP bloccante (alternativa scartata ma documentata)
L'utente vuole usare le AskQuestion NATIVE, quindi questa strada e' scartata. Misure fatte:
- Senza `notifications/progress`: 75 s OK, 330 s -> errore -32001 "Request timed out" (limite tra 75 e 330 s, non misurato meglio).
- Con progress ogni 15 s: 130 s OK, 900 s OK, 3700 s -> "Maximum total timeout exceeded" a 3600 s esatti (cap totale 1 ora).
- Cursor puo' riavviare un server MCP stdio (tutte le chiamate in corso cadono con "Connection closed"): successo dopo
  l'avvio di un sottoagente, causa non confermata.

## 5. Rispondere alle domande native: CDP
- [OK] `Cursor --remote-debugging-port=<porta>` funziona: `/json/list` espone la finestra "Cursor Agents" come target `page`
  (titolo "Cursor Agents"). Cursor legge lo switch in `main.js` e passa `cdpPort` alle finestre.
- [NO] `~/.cursor/argv.json` NON puo' impostarlo (whitelist di switch). Va passato all'avvio:
  `open -a Cursor --args --remote-debugging-port=9222` (solo a Cursor chiuso). Vedi `research/launch-cursor-cdp.sh`.
- [OK] La porta si lega a 127.0.0.1. Chiunque sul Mac puo' pilotare Cursor mentre e' attiva: rischio da dichiarare.
- [OK] Lo stato della domanda vive in memoria nel renderer (bozza `additionalData.status:"pending"`, poi
  `submitted` + persist). Scrivere nel database NON sblocca la tool call. Nel bundle non ci sono comandi interni per rispondere.
- [CODICE] Selettori nel bundle `out/vs/workbench/workbench.glass.main.js`:
  - tray: `.glass-questionnaire-tray`
  - opzione: `button.ui-tray-option` (attributi `aria-pressed`, `data-selected`, `data-label-style="letter"`),
    badge `.ui-tray-option__badge` (A, B, C...), etichetta `.ui-tray-option__label`
  - campo libero: `.questionnaire-freeform-option` (editor di testo ricco; focus, poi `Input.insertText`)
  - pulsante principale: `.ui-tray-footer__primary button` (testo "Continue" o "Next"); secondario "Skip"
  - piu' domande = step (stepper): "Next" fino all'ultimo, poi "Continue"
  - tray aperto solo per la chat visibile: per una chat non selezionata bisogna prima aprirla nella sidebar
  - sidebar: contenitore `.glass-sidebar-agent-list-container`, righe con `data-sidebar-item-key` (IPOTESI: id della chat),
    `data-sidebar-selected-static-row`, `data-sidebar-status-subdued` ("done-unseen")
- Prototipo: `research/bridge_probe.py` (comandi pending, sidebar, tray, open, answer). `pending` provato; il resto NO.
- [NO] Accessibility/System Events: la finestra di Cursor non era elencata (non sullo Space corrente); fragile.
- [NO] SIGUSR1 sul processo principale per aprire l'inspector: rischio di terminare Cursor; non provare.

## 6. Notifiche su iPhone
- L'utente fa sideload con SideStore = Apple ID gratuito => nessun permesso APNs, certificato 7 giorni, Xcode non installato.
  Quindi un IPA nativo NON puo' ricevere push a app chiusa. Decisione: PWA.
- PWA installata in Home: Web Push reali (iOS >= 16.4), VAPID, nessun account.
  Richiede HTTPS: `tailscale serve` + abilitare i certificati HTTPS nel pannello admin Tailscale.
- Tailscale: installato sul Mac (`/usr/local/bin/tailscale`); all'inizio della ricerca l'iPhone risultava offline da 23
  giorni e andava riconnesso (nomi dei dispositivi omessi: il repository puo' diventare pubblico).
- Fallback: ntfy (app App Store) che apre la PWA.
- Notifica "persistente" vera non esiste su iOS senza Live Activity (richiede APNs/app nativa). Alternativa: sezione "In sospeso"
  nella PWA e, opzionale, promemoria ripetuti (disattivati per default).

## 7. Sicurezza
- Rispondere dal telefono = controllo di un agente con accesso alla shell. Autenticazione forte, solo Tailscale, niente porte pubbliche.
- Il database di stato contiene chiavi in chiaro; la riga di comando di un processo Cursor espone una chiave API: non loggare `ps`.
- La porta CDP e' controllo totale di Cursor per i processi locali.

## 8. Fase 0 - verifiche sul database (Cursor 3.24.6, sola lettura)
Metodo: script `research/phase0_*.py` (solo libreria standard, `mode=ro`, stampano solo conteggi, forme e stati: mai titoli
o testi) e lettura con `rg` del bundle `Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.glass.main.js`
(nessuna modifica). I numeri sono quelli del database dell'utente al momento della misura (588 header).

### 8.1 `hasBlockingPendingActions`, `hasPendingPlan`, `hasUnreadMessages`
- [CODICE] Il renderer scrive nell'header il valore calcolato dallo stato IN MEMORIA: vero se c'e' una decisione utente
  bloccante (es. approvazione di un tool), un questionario in attesa di input, oppure un sottoagente bloccato. Se la chat non
  e' caricata in memoria (Cursor riavviato, chat archiviata, run interrotta) il flag NON viene ricalcolato e resta l'ultimo
  valore scritto.
- [CODICE] Stato nella sidebar (`tIi`): `needs_attention` se `hasBlockingPendingActions` oppure `hasPendingPlan`;
  `in_progress` se `composerData.status === "generating"`; altrimenti `done`. Con `done` e `hasUnreadMessages` l'icona e'
  "Completed, unread" (`done-unseen`). Quindi il pallino rosso di Cursor = flag blocking o piano in attesa.
- [OK] 20 header con flag a true (10 non archiviati, 10 archiviati). Solo 1 aveva l'ultimo bubble `ask_question` in `loading`;
  per quasi tutti gli altri l'ultimo bubble era un `ask_question` `completed` con `additionalData.status:"pending"` (mai
  `submitted`), per qualcuno `cancelled` o un bubble senza tool.
  [INTERPRETAZIONE CORRETTA IN 9.1] Allora i `completed`/`pending` furono scambiati per residui "appiccicati". La traccia dal
  vivo mostra che e' lo stato NORMALE di una domanda che aspetta la risposta: `loading` dura solo pochi secondi. I residui
  veri sono altri: flag acceso con ultimo bubble che non e' una domanda in attesa (risposta data, domanda superata da altri
  messaggi, ...). Cursor lascia il pallino acceso anche in quei casi: e' il motivo d'essere del pulsante Ignora.
- Regola adottata (versione corrente in 9.1): "Need attention" = come Cursor (flag o piano in attesa, non archiviata, non
  sottoagente, con contenuto). Tipo: `domanda` se l'ultimo bubble e' un `ask_question` senza risposta (azionabile in fase 2);
  `residuo` negli altri casi (l'ipotesi `azione` per le approvazioni e' stata tolta perche' smentita: 9.1). Le NOTIFICHE
  partono solo da una nuova domanda (nuovo `toolCallId` in attesa), da un'approvazione di tool in attesa (sezione 11) e dalla
  fine di una run, mai dallo stato iniziale.
- [OK] `hasPendingPlan`: true in 1 header. `hasUnreadMessages`: true in 1 header su 588 (le chat a riposo sono "lette").
- [CODICE] `hasUnreadMessages` passa a true a fine turno solo se la chat NON e' quella mostrata nell'Agents Window
  (`turnCompletionAnnouncement`); `lastReadAtMs` e' in `composerData` (e in 1 header). Quindi NON basta per "chat finita":
  se l'utente sta guardando la chat sul Mac il flag non scatta mai.
- [IPOTESI SMENTITA, vedi 9.1] "Approvazione di tool in attesa = tool in `loading` senza `userDecision`": un tool in
  esecuzione e' `loading` senza `userDecision` allo stesso modo (osservato su decine di comandi di una stessa chat).
  Un'approvazione vera non e' mai stata osservata nel database: oggi non si sa riconoscerla. `toolFormerData.userDecision`
  esiste: `accepted` sulle domande con risposta, assente sui comandi eseguiti. Il segnale vero delle approvazioni
  (`additionalData.reviewData`) e' stato trovato dopo: sezione 11.

### 8.2 `agentLocation`, bozze, chat vuote
- [OK] `agentLocation` e' `null` in 446 header (bozze e chat create nell'editor classico) e un oggetto
  `{type, status, environment:{id, uri?}}` in 142: `local/active` (141; 9 con `environment.id:"empty-window"`, cioe' senza
  cartella) e `worktree/unknown` (1; con `worktreePath`, `worktreeId`, `sourceRepoRootPath`, `sourceEnvironment`, `ownership`).
  `agentLocationHistory` e' una lista con 1 elemento per gli stessi 142.
- [CODICE] I tipi di localizzazione noti al bundle sono `local`, `worktree`, `remote-ssh`, `remote-wsl`. Nel database locale
  non c'e' alcun cloud agent: arrivano dal server (header con `source:"cloud"`), non da `composerHeaders`.
- [OK] `isDraft:true` in 142 header, tutti con `agentLocation` nullo: sono i residui del flusso "nuovo agente" (uno per ogni
  agente creato dalla Agents Window, stesso numero di quelli con `agentLocation`). Non sono chat: da escludere.
- [OK] `lastUpdatedAt == 0` in 249 header: sono chat vuote (campione di 60: 55 con 0 bubble, 5 senza `composerData`). Per
  esse `recency == createdAt`; per le altre `recency == lastUpdatedAt` (339 su 339). Le chat con contenuto
  (`lastUpdatedAt > 0`) hanno quasi tutte 3+ bubble.
- [OK] Insieme "chat locali visibili" = non archiviata, non sottoagente, non bozza, `lastUpdatedAt > 0`: 35 chat su 588
  (altre 131 non archiviate sono vuote). Origine: 24 con `agentLocation`, 11 classiche (`agentLocation` nullo, con
  `workspaceIdentifier`).
- [OK] Colonne SQL e JSON coincidono: `lastUpdatedAt`, `createdAt`, `workspaceId == workspaceIdentifier.id` (0 differenze).
  `isDraft` NON e' una colonna SQL: sta solo nel JSON.
- [OK, 12/10, screenshot della sidebar] Le chat classiche (`agentLocation` nullo) compaiono nell'Agents Window: una chat
  creata nell'editor classico e' visibile in un gruppo della sidebar. `CP_INCLUDE_CLASSIC=true` resta quindi corretto.
- [OK, 12/10] **Progetti rimossi dalla sidebar.** Il filtro qui sopra lasciava passare 35 chat, ma la sidebar ne mostra 9 (in 7
  gruppi): le altre 26 NON sono archiviate chat per chat (`isArchived` falso), appartengono a progetti che l'utente ha
  RIMOSSO dall'Agents Window. Dove sta: `ItemTable`, chiave `cursor/glass.removedProjects`, array di
  `{type:'workspace', id, name, repoUrls, workspaceIdentifier:{id, uri}}` (15 voci, 13 workspace distinti). Il collegamento e'
  `workspaceIdentifier.id` (32 caratteri), uguale alla colonna `workspaceId` e a `header.workspaceIdentifier.id` delle chat; il
  campo `id` della voce (42 caratteri) e' un altro identificatore e NON serve.
  Regola "il workspace della chat e' tra i rimossi -> nascosta": 9 mostrate su 9, 26 nascoste su 26, 0 errori, sia per id
  (colonna e header) sia per nome; per `uri.path` 34 chat su 35 (una non ha l'uri). Il confronto per id e' quello usato.
- [OK] Ipotesi scartate con gli stessi dati: `isArchived` dei progetti in `glass.localAgentProjects.v1` (0 archiviati su 20),
  appartenenza a un progetto in `glass.localAgentProjectMembership.v1` (272 voci: la regola "ha un'appartenenza" mostrava 23 chat,
  22 in piu' e 8 mancanti), eta' della chat, chat classiche.
- [NON PROVATO] Che succede se l'utente ri-aggiunge un progetto rimosso (si presume che Cursor lo tolga da
  `glass.removedProjects`: il daemon rilegge ogni 10 s) o crea una nuova chat in un progetto rimosso.
- [OK] Dopo la regola le chat visibili sono 9 (`npm run probe` riporta anche quante ne nasconde).
- Chiavi di header viste in questa versione, oltre a quelle elencate nella sezione 2: `unfinishedRunAt`, `lastReadAtMs`,
  `subagentInfo`, `draftTarget`, `hasBeenInSidebar`, `isEphemeral`, `committedToBranch`, `createdOnBranch`,
  `createdFromBackgroundAgent`, `projectAppearance`.

### 8.3 Ordine dei workspace nella sidebar
- [OK] Chiave `cursor/glassSidebarSettings` nella `ItemTable` del database GLOBALE (scope APPLICATION di Cursor), valore JSON:
  `groupBy` (`workspace`|`repository`|`environmentInstance`|`time`|`status`|`environment`), `sortAgentsBy`
  (`updated`|`status`), `sortGroupsBy` (`updated`|`manual`), `sectionOrderByGroupBy`, `collapsedSectionIdsByGroupBy`,
  `removedSectionIds`, `filter.show`, `compact`, `subtitle`. Default nel codice: `groupBy:"repository"`,
  `sortAgentsBy:"updated"`, `sortGroupsBy:"manual"`.
- [OK] Impostazioni dell'utente: `groupBy:"workspace"`, `sortGroupsBy:"manual"`, `sortAgentsBy:"updated"`; ordine manuale
  salvato sia per `workspace` (12 id) sia per `repository` (19 id).
- [OK] Id di sezione per `groupBy:"workspace"`: `__environment_instance_<h>__`, con `<h> = hash("local:path:<cartella>")`
  (oppure `hash("local:home")` senza cartella). `hash` e' quello di VS Code (int32 con segno: parte da 0, per le stringhe
  `h=(h<<5)-h+149417`, poi per ogni code unit UTF-16 `h=(h<<5)-h+c`). Ricostruiti dai dati reali: 7 id salvati su 12; gli
  altri 5 sono con ogni probabilita' sezioni non piu' esistenti. Per `repository`: `repo:<url remoto normalizzato>` oppure
  `workspace:<workspaceId>` / `workspace:home`.
- [CODICE] Algoritmo con `sortGroupsBy:"manual"` (`s3v`/`LO0`): prima le sezioni correnti NON presenti nell'ordine salvato
  (in ordine di default), poi l'ordine salvato filtrato alle sezioni presenti. Ordine di default: `max(lastUpdatedAt)` delle
  chat della sezione, decrescente; a pari merito per etichetta (nome cartella). Dentro la sezione con `sortAgentsBy:"updated"`:
  `lastUpdatedAt` decrescente. Con `sortGroupsBy:"updated"` vale solo l'ordine di default. La sidebar mostra 5 chat per
  sezione e poi "More".
- [OK, 12/10] Confronto visivo con lo screenshot della sidebar dell'utente (dopo aver escluso i progetti rimossi, 8.2): i 7 gruppi
  escono nello stesso ordine, nome di cartella per nome di cartella (i nomi dei progetti dell'utente non si riportano qui)
  e con le stesse dimensioni (2, 1, 1, 1, 1, 1, 2 chat).
- [CODICE, 12/10] Stato "compresso" di un gruppo (bundle `workbench.glass.main.js`, `hmI`): `filterEmpty ?? transient ??
  (persisted || stale)`. L'elenco in `collapsedSectionIdsByGroupBy` e' solo il valore di base: gruppi svuotati dal filtro
  sono compressi, un valore di sessione (click) lo scavalca. [NON SPIEGATO] Nello screenshot due gruppi sono aperti
  pur risultando compressi nei dati letti 24 minuti dopo (potrebbero essere stati compressi dopo lo screenshot, oppure vale
  un valore di sessione): il campo `collapsed` della PWA riflette solo l'elenco salvato.

### 8.4 Da chat a cartella/workspace
- [OK] Delle 35 chat visibili: 24 si risolvono con `agentLocation.environment.uri`, 10 con `workspaceIdentifier.uri`,
  1 con `workspaceStorage/<id>/workspace.json` (campo `workspace`, multi-root). Nessuna non risolta. Le 249 con
  `workspaceIdentifier:{id}` senza `uri` non sono mai chat visibili: 142 bozze (136 archiviate, 6 attive), 98 chat vuote
  attive, 9 archiviate.
- Priorita' di risoluzione: 1) `agentLocation.environment.uri`, 2) `workspaceIdentifier.uri`, 3) `workspace.json`
  (`folder` o `workspace`), 4) `empty-window` -> sezione "home". `workspaceStorage`: 77 cartelle, 73 con `folder`,
  3 con `workspace`, 1 senza `workspace.json`.

### 8.5 Chat in corso e chat finita
- [CODICE] `unfinishedRunAt` nell'header vale `lastUpdatedAt ?? createdAt` solo mentre `composerData.status === "generating"`
  (funzione `aqr`) e sparisce (chiave assente) quando la run finisce. Se Cursor muore durante una run il marcatore resta:
  3 header archiviati lo mostrano da 2 a 10 giorni.
- [CODICE] Cursor considera "turno completato" (`bJm`) quando `composerData.status === "completed"` e inoltre: non e'
  sottoagente, non e' archiviata, `queueItems` vuoto, nessun tool in primo piano, nessun sottoagente in background, nessun goal
  in continuazione.
- [OK] Sulla chat dell'agente che ha fatto queste misure (in corso): l'header ha `unfinishedRunAt` per tutta la run;
  `lastUpdatedAt`, `unfinishedRunAt` e `hasBlockingPendingActions` NON cambiano durante la run; cambia solo
  `conversationCheckpointLastUpdatedAt` (circa ogni 30-60 s).
- [OK] `composerData.status` persistito resta "aborted" per tutta una run in corso: NON e' affidabile durante la run. A riposo
  vale `completed` (26 chat su 33), `aborted` (6), `none` (1).
- [OK] `lastUpdatedAt` dell'header = ora dell'ultimo messaggio DELL'UTENTE (inizio dell'ultimo turno; scarto mediano 0,0 s),
  non l'ultima attivita'. `conversationCheckpointLastUpdatedAt` = circa 3,5 s dopo l'ultimo bubble (mediana): segue la fine
  del turno.
- [OK] I bubble sono scritti nel database entro meno di 1 s: ritardo osservato tra `createdAt` del bubble e visibilita' al
  campionatore (passo 0,5 s) da pochi ms a 853 ms. `composerData.fullConversationHeadersOnly[i]` ha `bubbleId`, `createdAt`
  (ISO), `startedAtMs`, `type` (1 utente, 2 assistente), `grouping`: l'ora dell'ultimo bubble si legge senza aprirlo.
- [OK] Stati di un tool in `toolFormerData.status`: `loading`, `completed`, `cancelled`, `error`. `additionalData.status`:
  terminale `success`/`error` a fine (e `cancelled` mentre e' ancora `loading`, valore fuorviante); `ask_question`
  `submitted` (risposta data) / `pending` (SENZA risposta: ancora in attesa, o superata da un messaggio libero; vedi 9.1) /
  `cancelled`; `task_v2` `pending` -> `running`.
- Una scansione di 25 chat x 40 bubble (793 bubble) costa 0,4 s: il polling a 1 s e' sostenibile.
- Segnale scelto (CALIBRATO dal vivo in 9.2): una chat e' "in corso" se l'header ha `unfinishedRunAt` oppure l'ultimo bubble
  e' recente; e' "finita" quando passa da in corso a non in corso (`unfinishedRunAt` sparito, nessuna domanda ne' flag, ultimo
  bubble non `loading`, stabile per qualche secondo). `composerData.status` solo per distinguere `completed` da `aborted`
  (interrotta: nessuna notifica di default). [Versione implementata e perche' e' diversa: 9.2.]
- [NON PROVATO] L'hook `stop`: richiede di modificare `~/.cursor/hooks.json` (conferma e backup). Con questi segnali
  potrebbe non servire.

### 8.6 Sottoagenti
- [OK] Un sottoagente `explore` lanciato per prova NON ha creato alcuna riga in `composerHeaders` (588 prima e dopo): quelli
  leggeri sono effimeri. Quelli presenti (130) hanno `isSubagent=1`, `subagentInfo.parentComposerId`, id del tipo `task-...`.

## 9. Fase 1 - decisioni di implementazione e cosa e' stato verificato
Daemon e PWA sono scritti; 93 test automatici (`cd daemon && npm test`). Le etichette sono quelle della sezione 8.
Tutto cio' che dipende da dettagli interni di Cursor e' confinato in `daemon/src/cursor/`.

### 9.1 Traccia dal vivo di una domanda e regole che ne derivano
Il campionatore (`research/phase0_sampler.py`, passo 0,5 s, solo metadati) ha registrato dal vivo una domanda `ask_question`
vera. Orari in UTC; le chat sono indicate dai primi 8 caratteri dell'id.
- [OK] Ciclo di vita di una domanda (chat `be5784e2`, posta alle 18:08:47):
  1. Il bubble `ask_question` nasce con `toolFormerData.status: "loading"`; 3 ms dopo l'header passa a
     `hasBlockingPendingActions: true`.
  2. Dopo 33 s (18:09:20) il turno dell'agente finisce: il bubble passa a `completed` con `additionalData.status: "pending"`, il
     composer passa da `aborted` a `completed` e `unfinishedRunAt` sparisce dal composerData. La domanda NON e' risolta: il
     flag e' rimasto acceso per ore (nessun cambio fino alla fine del campionamento, 20:07) e la risposta e' arrivata la
     mattina dopo.
  3. Alla risposta: bubble `submitted`, flag spento, nuova run con un nuovo `unfinishedRunAt` (letto a posteriori).
  Su un'altra chat (`6814061b`) la finestra `loading` e' durata 5,6 s. Quindi `loading` NON e' un marcatore affidabile di
  "domanda in attesa": quasi sempre il bubble e' `completed`/`pending`. (Le sezioni 2, 8.1 e 8.5 e la prima versione del
  daemon assumevano il contrario: con quella regola ogni domanda sarebbe diventata un "residuo" dopo pochi secondi e il
  daemon avrebbe mandato anche un "Chat finita" fuori luogo quando il turno finiva con la domanda. Corretto e coperto da test.)
- [OK] Cursor puo' RISCRIVERE il bubble della domanda mentre aspetta: `createdAt` si sposta in avanti (`be5784e2`: 19:04 e
  20:45; `6814061b`: 21:39) e l'elenco dei bubble nel composerData porta la stessa ora riscritta. L'ora del bubble non e'
  quindi l'ora della domanda: la chiave stabile e' il `toolCallId`.
- [OK] Una domanda `pending` resta tale se l'utente risponde con un messaggio libero invece di usare il questionario
  (`6814061b`: la domanda delle 16:54 resta `pending` e viene seguita da altri bubble). Il flag non si spegne per questo.
  Una domanda superata da altri messaggi, o gia' risposta, con il flag ancora acceso e' un residuo vero.
- [OK] Dati reali dopo la correzione (12/10 mattina): 34 chat visibili, 9 con il flag acceso: 8 con un `ask_question`
  `completed`/`pending` come ultimo bubble (da 11 a 323 ore) e 1 con ultimo bubble di testo (residuo vero). Con la regola
  vecchia tutte e 9 sarebbero risultate residui.
- [DECISIONE] La richiesta in attesa si classifica guardando l'ultimo bubble: `domanda` (`ask_question` non `submitted`:
  `loading` oppure `additionalData.status: "pending"`; chiave `toolCallId`), `piano`, `residuo` (flag o piano acceso ma l'ultimo
  bubble non e' una domanda aperta). Solo la `domanda` e' "viva" e puo' essere notificata. La domanda e' viva se il flag e'
  acceso OPPURE se e' RECENTE (bubble creato da meno di 120 s): l'header di Cursor arriva in ritardo (9.7). Con il flag spento
  una domanda vecchia non conta: Cursor non mostra il pallino e potrebbe essere un tool rimasto `loading` per una run interrotta.
- [OK, 12/10] Il flag acceso corrisponde anche a una domanda VECCHIA ancora `pending` dentro la conversazione, non solo
  all'ultimo bubble: `a9d0c36d` ha un `ask_question` `completed`/`pending` di 34 ore prima, seguito da altri bubble (la chat e'
  proseguita senza usare il questionario) e il flag resta acceso. Per questo molti residui "veri" sono in realta' domande
  dimenticate. Sempre per effetto del flag, Cursor mostra il pallino arancione anche mentre l'agente LAVORA (`6814061b`, in
  corso da quasi un'ora con il flag acceso: nello screenshot ha il pallino come le chat ferme in attesa).
- [OK, IPOTESI SMENTITA] Un tool in esecuzione NON si distingue da un'approvazione. La prima versione classificava come `azione`
  ogni tool diverso da `ask_question` in `loading` e senza `userDecision` a flag acceso. Dopo l'abbinamento dell'iPhone (12/10,
  circa 12:00 UTC) si e' visto che la chat `6814061b` (flag acceso da una vecchia domanda irrisolta, ora al lavoro con una
  serie di comandi da terminale) generava da 1 a 5 "richieste nuove" al minuto: 68 chiavi distinte in 28 minuti (11:36-12:04
  UTC; tra una e l'altra da 5 s a 161 s, mediana 15 s), cioe' un evento per ogni comando. 14 sono diventate push realmente
  inviate all'iPhone. Su quei bubble `userDecision` e' assente e `additionalData.status` e' `cancelled` mentre il comando e'
  ancora `loading`. Correzione: nessuna classificazione delle approvazioni; solo `ask_question` puo' essere una richiesta
  viva; qualunque altro tool a flag acceso e' un `residuo` (nessuna notifica). Test di regressione in `model.test.js` e
  `watcher.test.js`, verificati reintroducendo il difetto (falliscono entrambi). Dopo il riavvio del daemon: 0 eventi.
  Lezione: un'ipotesi non provata non deve mai poter generare notifiche. (Il segnale vero delle approvazioni, `reviewData`, e'
  in 11; questa regola resta valida per ogni tool SENZA `reviewData`.)
- [DECISIONE] Una richiesta resta in "Richiedono attenzione" per 24 h (`CP_PENDING_AFTER_HOURS`) dal suo inizio (ora del bubble
  per domanda e azione, ultimo aggiornamento della chat per residuo e piano), poi passa in "In sospeso" (motivo `vecchia`).
  Una domanda viva da giorni non sparisce: resta visibile in "In sospeso" (nelle intenzioni, azionabile in fase 2).
- [DECISIONE] Ignora: chiave `(chatId, key)`; `key` = `toolCallId` (domanda e azione), ultimo tool o ultimo bubble (residuo),
  `plan:<bubble>` (piano). Scrive solo `daemon/data/store.db`. Passa la richiesta in "In sospeso" (motivo `ignorata`), reversibile.
  Con una nuova richiesta la chiave cambia e il pallino ricompare.

### 9.2 Notifiche
- [DECISIONE] Si notificano solo transizioni, mai lo stato iniziale. Chiavi di deduplica persistenti: `a:<chat>:<toolCallId>`
  (domanda o approvazione) e `d:<chat>:<lastUpdatedAt>` (chat finita). All'avvio le domande vive piu' vecchie di 300 s sono segnate come gia'
  notificate senza inviare nulla; quelle piu' recenti partono (copre un riavvio del daemon a ridosso di una domanda).
- [DECISIONE] "In corso" = l'header ha `unfinishedRunAt` (non piu' vecchio di 12 h) E lo stato del composer non e' `completed`.
  L'euristica "ultimo bubble recente" ipotizzata in 8.5 non e' stata adottata: il marcatore da solo e' piu' semplice e non
  richiede soglie da calibrare.
- [OK] L'header resta indietro rispetto al composer. Alla fine della run di `be5784e2` il composer ha tolto `unfinishedRunAt`
  alle 18:09:20 e l'header 27 s dopo; per una run di 35 s (`6814061b`) l'header non ha mai mostrato la run; in un terzo caso
  (`7cb1e28c`, run di 1 s) le due scritture sono state contemporanee. Il composer invece cambia subito: `status` passa a
  `aborted` quando l'utente invia il messaggio e torna a `completed` nell'istante in cui la run finisce (3 casi su 3, insieme alla
  scomparsa di `unfinishedRunAt`); durante la run non e' mai `completed` (nessuna eccezione in oltre un'ora di run).
  Quindi `completed` e' un segnale affidabile di "run finita": una chat che l'header dice ancora in corso si considera finita se
  il composer e' `completed` (fine anticipata). L'header resta il segnale di inizio.
- [DECISIONE] "Chat finita" = era in corso, poi ferma per 5 s, senza richieste vive e senza una domanda aperta (una run che
  finisce con una domanda NON e' finita: aspetta l'utente), senza messaggi in coda, dopo una run di almeno 20 s. Una run gia'
  in corso all'avvio del daemon conta come lunga.
- [DECISIONE] Tutte le chat visibili si rileggono ogni 5 s anche a header invariato (prima solo quelle con flag, in corso o
  appena finite): una domanda nuova in una chat con il flag gia' acceso (`6814061b`) non cambia l'header per decine di secondi
  e, in una chat senza flag, l'header arriva fino a 60 s dopo il bubble (9.7). Costo misurato: 11 ms per 9 chat.
- [LIMITE] Il daemon NON distingue una run fermata a mano (o fallita) da una finita bene: non e' mai stata osservata e a riposo
  `status` e' `aborted` in 6 chat su 33 (8.5). Notifica "Chat finita" comunque: meglio una notifica in piu' che una persa.
- [LIMITE] Il daemon impara l'inizio di una run dall'header, che puo' arrivare con ritardo o mancare: una run di 20-60 s puo'
  non produrre "Chat finita" e una piu' lunga puo' essere misurata piu' corta del vero. Non cambia le run di minuti o ore.
- [CODICE] iOS richiede che ogni push mostri una notifica (sezione 6): il service worker chiama sempre `showNotification`, anche
  con payload assente o non valido (c'era un bug con JSON `null`, trovato da un test e corretto).
- [OK] Il contatto VAPID (`CP_VAPID_SUBJECT`) arriva ai servizi push nel claim `sub`. Il valore predefinito usa un dominio
  d'esempio e Apple (`web.push.apple.com`) lo ha accettato: la push di prova del 12/10 e' stata consegnata (`push_sent
  kind=test sent=1 failed=0`). Impostare un indirizzo reale resta consigliato.

### 9.3 Sicurezza (cosa e' implementato e come e' coperto)
- Autenticazione obbligatoria su tutte le API (tranne `/healthz`, `/api/session`, `/api/pair`): codice di abbinamento monouso di
  8 caratteri (15 min, 5 errori ogni 10 min), sessione con cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` su HTTPS), di codici e
  sessioni si salva solo l'impronta SHA-256. Controlli su `Host` (421), `Origin` (403), `Content-Type` (415), dimensione (413).
- Log con ALLOW-LIST (prima era una deny-list: troppo fragile): numeri e booleani passano, le stringhe solo per poche chiavi note.
  Un test verifica che titoli e testi delle chat non compaiano mai nei log.
- Il database di Cursor si apre con `readOnly` + `PRAGMA query_only`; un test confronta l'hash SHA-256 del file prima e dopo.
- Web Push: endpoint ammessi solo se HTTPS e di servizi push noti (anti SSRF); 404/410 eliminano la sottoscrizione.

### 9.4 PWA: cosa e' stato verificato
- [OK] Nel browser integrato di Cursor (emulazione 390 px, tema chiaro e scuro), sul daemon vero con database sintetico
  (`npm run demo`): abbinamento con codice sbagliato e giusto, home, Ignora e Ripristina (stato, conteggi, titolo della scheda),
  impostazioni, aggiornamenti in diretta (SSE), banner a daemon spento, ritorno al login su 401, uscita, attivazione del service
  worker con pre-cache di 19 file senza dati delle API, avvio a freddo senza rete dalla cache. Contrasto testo/sfondo >= 4.5:1
  (WCAG AA) in entrambi i temi.
- [OK] iPhone reale (12/10): la PWA e' raggiungibile via `tailscale serve`, installata in Home da Safari e abbinata con il
  codice; l'utente ha concesso il permesso e ha ricevuto la notifica di prova. Lato daemon: `paired`, `push_subscribed`
  (servizio `web.push.apple.com`), `push_sent kind=test sent=1 failed=0`.
- [NON PROVATO] Push con PWA chiusa o schermo bloccato (non verificato esplicitamente), tocco sulla notifica che apre la chat,
  badge sull'icona, notifica "chat finita" vera, comportamento a lungo termine (sessione, sottoscrizione). Il comportamento del service worker alla pressione di una notifica e' provato solo con una
  simulazione (`daemon/test/sw.test.js`).
- [OK] `tailscale serve --bg 8787` (Tailscale 1.104.1, con il consenso dell'utente, dopo che ha abilitato i certificati HTTPS nel
  pannello: `CertDomains` passato da 0 a 1). `serve status` riporta `(tailnet only)`. Dal Mac, via HTTPS con certificato
  verificato: `/healthz` 200 (la prima richiesta ha impiegato circa 30 s per l'emissione del certificato), `/` 200 (HTML),
  `/api/state` senza sessione 401; il controllo `Host` accetta `*.ts.net`. `serve` passa `X-Forwarded-Proto: https`: il
  daemon risponde con HSTS via HTTPS e senza via loopback, quindi il cookie di sessione avra' `Secure` (dedotto da HSTS, il
  cookie in se' si vedra' con l'abbinamento). Per togliere l'esposizione: `tailscale serve --https=443 off` o
  `tailscale serve reset`.
- [OK, TRABOCCHETTO] Con l'app di Tailscale ferma (`WantRunning` falso, per esempio dopo un aggiornamento) `BackendState` e'
  `Stopped` e `CertDomains` risulta vuoto anche se i certificati sono abilitati: verificare lo stato prima di dedurre che
  manchi l'abilitazione. Lo si legge con `tailscale debug prefs` (campo `WantRunning`).

### 9.5 Altre osservazioni del campionatore
- [OK] Prima della domanda, 54 minuti con una sola chat in corso (questa): nell'header e' cambiato solo
  `conversationCheckpointLastUpdatedAt` (55 volte, circa ogni 60 s); nessun flag e nessuno `status` di composer sono cambiati.
- [OK] All'invio di un messaggio il composer fa: `status` -> `aborted` e `genUUID` -> vuoto; 2-8 s dopo arrivano il nuovo
  `genUUID`, `lastUpdatedAt` e `unfinishedRunAt` (stesso valore: l'ora dell'invio).
- [OK] `hasUnreadMessages` NON e' un segnale di "finita": su `7cb1e28c` e' passato a `true` all'INIZIO di una run di 1 s, non
  alla fine (conferma 8.1).
- Durante le chiamate di tool `additionalData.status` ha assunto `pending`, `running`, `cancelled`: possibile discriminatore
  per le approvazioni di tool, NON provato.

### 9.6 Limiti noti
- L'eta' mostrata di una domanda si basa sull'ora del bubble, che Cursor puo' riscrivere (9.1): puo' risultare piu' recente
  del vero. Un'ancora affidabile sarebbe l'ora in cui il daemon ha visto la domanda per la prima volta (gia' salvata nello
  store per la deduplica), non ancora usata.
- `removedSectionIds` (sezioni tolte a mano dalla sidebar) non e' gestito: nessun caso nei dati reali. Diverso da
  `glass.removedProjects`, che invece e' gestito (8.2).
- [SUPERATO IN 11] Le approvazioni di tool ("Run"/"Allow", anche quelle chieste da un hook) ora si riconoscono da
  `reviewData.status: "Requested"` e generano una notifica; resta da provare dal vivo che il database lo contenga DURANTE
  l'attesa (11.4). Un tool senza `reviewData` non e' mai una richiesta.
- Un progetto rimosso e poi ri-aggiunto, o una nuova chat in un progetto rimosso: comportamento di Cursor non verificato (8.2).

### 9.7 Ritardo dell'header di Cursor e rilevamento delle domande
Segnalazione dell'utente (12/10): la notifica di una domanda "e' arrivata, un po' in ritardo". Misura con un campionatore
read-only (passo 0,3 s: scritture nuove di `cursorDiskKV` via `rowid` e cambi di `composerHeaders`), orari UTC.
- [OK] Cursor scrive gli header in due modi: (a) una scrittura PERIODICA ogni 60 s, a `:19,5` secondi (12:24:19 ... 12:30:19,
  7 minuti consecutivi senza saltarne uno; la fase dipende dall'avvio di Cursor, non e' assoluta), che di norma aggiorna solo
  `conversationCheckpointLastUpdatedAt`; (b) scritture legate agli EVENTI (fine di una run, risposta a una domanda) che
  portano con se' anche le modifiche in sospeso di altre chat.
- [OK] Il flag `hasBlockingPendingActions` compare quindi nell'header con ritardo variabile rispetto al bubble della domanda.
  Due casi dal vivo: `e2681e06` bubble alle 12:24:32,9, flag alle 12:24:37,7 (+4,8 s, a bordo di una scrittura di fine run);
  `5cb3de41` bubble alle 12:24:38,6, flag alle 12:25:19,5 (+41 s, ha dovuto aspettare quella periodica). Coerente con lo storico
  del daemon: le domande rilevate in chat senza flag precedente cadono tutte a `:18-:19` secondi di ogni minuto
  (12:08:19, 12:10:19, 12:12:19, tre chat diverse), cioe' un ritardo da pochi secondi a 60 s, in media circa 30 s.
- [OK] Il BUBBLE della domanda invece e' scritto subito: `createdAt` 12:24:32,712 per una riga vista nel registro alle
  12:24:32,909. I campi `loading -> completed/pending` e il `composerData` sono aggiornati SUL POSTO (stesso `rowid`: 1.135.286
  per un bubble creato 30 s prima di un massimo di 1.135.943; `composerData` 1.004.523): il `rowid` vede solo le creazioni.
  Per questo non si usa come registro delle modifiche.
- [DECISIONE] Si rilegge ogni 5 s la "coda" di TUTTE le chat visibili (`composerTail` + ultimo bubble: 11 ms in totale per
  9 chat; 0,5 ms per 1000 bubble, 3 ms per 5000) e una domanda senza risposta creata da meno di 120 s vale come viva anche a flag
  spento (`FRESH_QUESTION_MS`, due cicli di scrittura periodica). Chiave `toolCallId`, quindi il flag che arriva dopo non genera
  una seconda notifica. Ritardo atteso: al massimo `fullScanMs` (5 s) piu' il passo di lettura (1 s).
- [OK, A SENSAZIONE] Con la correzione attiva l'utente ha riferito che la notifica "sembra subito" (12/10). Non e' una
  misura: per un valore in secondi serve il campionatore su una domanda vera.
- [OK] Una chat che LAVORA con il flag acceso non e' "in attesa di te": nella PWA e' "In corso" (non "Richiedono attenzione")
  finche' la run non finisce; poi il residuo torna e si puo' ignorare. Resta in attenzione solo una domanda viva.
- [OK, 12/10] Costo del daemon in regime (35 chat visibili, lettura ogni secondo e rilettura profonda ogni 5 s, dopo le
  funzioni di fase 2 e le approvazioni): CPU 0,2%, memoria 24 MB secondo `top` (68 MB di RSS secondo `ps`), 8 thread.

## 10. Fase 2 - azioni dalla PWA (provate su simulatori e, dal 13/10, su un Cursor reale: vedi 10.6)
Stato (12/10): rispondere alle domande, saltarle e scrivere messaggi sono implementati (`daemon/src/actions.js`,
`daemon/src/cursor/agents-ui.js`, `daemon/src/cursor/cdp.js`) e provati con test automatici su un finto Cursor e su un
Chromium vero con una pagina che riproduce la struttura ricavata dal bundle. Fino al 12/10 nulla era stato provato su un Cursor vero (esiti in 10.6):
serve riavviarlo con `--remote-debugging-port=9222` (`tools/cursor-cdp.sh`), cosa che interrompe le chat in corso, quindi
si chiede prima all'utente. Finche' la porta non c'e' le azioni risultano "non attive" e la PWA resta in sola lettura con
una spiegazione (nessun errore).

### 10.1 Cosa dice il bundle di Cursor 3.24.6 [CODICE]
Letto `out/vs/workbench/workbench.glass.main.js` (mai modificato). Oltre ai selettori della sezione 5:
- Il questionario e' il componente `kVC` (classe `glass-questionnaire-tray`): una domanda per "step". Il pulsante primario
  del footer e' sempre quello che manda la risposta finale ("Next" finche' ci sono altri step, "Continue" sull'ultimo);
  "Skip" e' il secondario.
- Toccare l'opzione GIA' selezionata di una domanda a scelta SINGOLA la DESELEZIONA (funzione `Weg`). Per questo il daemon
  controlla lo stato prima di cliccare: l'azione e' idempotente. In scelta singola scegliere un'opzione fa avanzare da solo
  allo step successivo (`Jnl`); in scelta multipla si avanza con il pulsante primario.
- La voce libera ha id `__freeform_other__` ed e' aggiunta da Cursor stesso: le opzioni dell'agente che sembrano "Altro"
  vengono nascoste da Cursor e il daemon le filtra con la stessa regola (`isOtherLabel`).
- Composer: editor Lexical (classe `aislash-editor-input`) e pulsante con `aria-label="Send message"`.
- Sidebar: righe con `data-sidebar-item-key`, forma `row:<composerId>` [IPOTESI ricavata dal codice].
- L'esito si legge dal bubble della domanda nel database: `additionalData.status: "submitted"` con `currentSelections` e
  `freeformTexts` (vedi sezioni 2 e 9.1). E' il segnale con cui il daemon conferma.

### 10.2 Come agisce il daemon [DECISIONE]
- Si agisce solo su cio' che il daemon vede ORA: la richiesta porta la chiave (`toolCallId`) della domanda che l'utente ha
  davanti; se non e' piu' quella corrente la risposta e' 409 `stale` e Cursor non viene toccato.
- Le risposte si validano contro la domanda vera letta dal database (opzioni esistenti, "Altro" con testo, una sola
  opzione nelle domande a scelta singola, lunghezze massime), non contro cio' che manda il telefono.
- Una sola azione alla volta (coda seriale: manipolano la stessa finestra). Se scade il tempo
  (`CP_ACTION_TIMEOUT_SECONDS`, 45 s) il telefono riceve subito 504, ma la coda resta occupata finche' il lavoro vero non
  finisce: nessuna seconda azione parte sopra la prima.
- Deduplica: stessa risposta entro 60 s, o stesso testo di messaggio entro 8 s, e' 409 `already_sent`.
- Il messaggio non parte se c'e' una domanda in attesa (409 `question_pending`: si risponde prima), se c'e' un'approvazione
  in attesa (409 `approval_pending`: con "ferma e invia" attivo in Cursor annullerebbe il comando, quindi si decide prima dal
  Mac; sezione 11) ne' se nel composer di Cursor c'e' gia' una bozza (`draft_not_empty`): il lavoro dell'utente sul Mac non
  si sovrascrive mai.
- Si apre la chat nella sidebar (il questionario esiste solo per la chat visibile) e a fine azione si RIPRISTINA la
  selezione precedente (`CP_RESTORE_SELECTION`, vero di default), cosi' il telefono non sposta la vista dell'utente. Con
  `Emulation.setFocusEmulationEnabled` la pagina si comporta come se avesse il focus anche con Cursor in secondo piano
  (vale solo per la sessione CDP).
- Verifica sul database dopo l'azione, fino a 12 s: risposta = `submitted` con la selezione attesa (altrimenti l'esito
  porta `warning: "differs"`); salta = lo stato non e' piu' `pending`; messaggio = aumentano i bubble o la coda del composer.
  Se Cursor non lo scrive in tempo l'esito e' `verified: false` e la PWA lo dice senza fingere un successo.
- Nei log solo tipo di azione, durata, esito e codice d'errore: mai testi. Il client CDP accetta solo URL WebSocket su
  loopback, sulla porta attesa e con percorso `/devtools/page/<id>`; il WebSocket di Node non invia l'intestazione `Origin`.
- Stato esposto alla PWA in `status.actions`: `ok` | `off` (porta chiusa) | `no_window` (finestra Agents non aperta) |
  `disabled` (`CP_ACTIONS=false`). Il daemon ricontrolla ogni `CP_CDP_POLL_MS` (5 s, solo HTTP).

### 10.3 Cosa e' stato provato e con cosa
- [OK] Client CDP (`daemon/test/cdp.test.js`): validazione degli URL, errori, timeout, chiusura, clic e testo, richieste
  parallele. Con un WebSocket finto e un server vero.
- [OK] `agents-ui.js` su un Chromium vero con `daemon/test/helpers/mock-agents-page.html` (sidebar e questionario costruiti
  come da bundle): scelta singola, multipla, "Altro" con a capo, piu' domande con avanzamento automatico, opzione gia'
  selezionata che non si clicca, domanda sbagliata (`mismatch`), chat inesistente, "Skip", ripristino della chat aperta.
  La suite salta questi test se non trova un Chromium (`CP_TEST_CHROME` o quello di Playwright): resta senza dipendenze.
- [OK] Servizio delle azioni (`daemon/test/actions.test.js`, 19 test): coda, scadenza con 504 immediato, deduplica,
  `stale`, validazione, verifica sul database, messaggi in coda, endpoint HTTP, stato esposto.
- [OK] Logica della PWA (`daemon/test/pwa-logic.test.js`, 15 test): stato delle risposte, messaggi d'errore, riconoscimento
  del doppio tocco e calcolo dell'altezza della tastiera.
- [OK] PWA in browser veri con il server dimostrativo (finto Cursor, nessun dato reale), `tools/ui-check.mjs`: 51 controlli
  in WebKit (il motore di Safari, build di Playwright) e in Chromium, tema chiaro e scuro, viewport iPhone 14. Verificano:
  logo in alto a sinistra, `touch-action`, campi a 16 px (niente zoom al focus), questionario (singola, multipla, "Altro",
  piu' domande, "Salta" con doppia conferma), compositore (ancorato in fondo, cresce con il testo, bozza conservata,
  esito), doppio tocco bloccato con tocchi veri (`touchscreen.tap`: il secondo tocco ravvicinato e' annullato, il primo e uno
  isolato no), schermata di approvazione (tipo di azione senza il comando, nessun compositore, Ignora e Ripristina),
  nessuno scorrimento orizzontale, nessuna violazione della CSP.
- [TRABOCCHETTO] In WebKit ogni `page.screenshot()` di Playwright provoca un errore CSP spurio (uno per screenshot, zero
  prima): non viene dalla pagina. Il controllo CSP rigoroso e' l'esecuzione senza `--shots`.
- [OK, TROVATO DAL TEST] Dopo una risposta riuscita il questionario spariva appena il daemon vedeva `submitted`, e con lui
  la scritta "Risposta inviata": l'utente poteva non vedere mai la conferma. Ora l'esito resta alcuni secondi sopra il
  compositore (`composer.flash`).

### 10.4 Safari/iOS: scelte e cio' che non si puo' provare qui
- Zoom: niente `maximum-scale` ne' `user-scalable=no` (iOS li ignora dalla versione 10, per accessibilita'). Si usano
  `touch-action: manipulation` ovunque, campi di testo a 16 px (sotto, iOS ingrandisce al focus) e una rete di sicurezza in
  JavaScript (`pwa/js/viewport.js`) che annulla il SECONDO tocco di un doppio tocco (entro 350 ms e 36 px, solo se pulito:
  non un trascinamento ne' una pressione lunga), esclusi i campi di testo, dove il doppio tocco serve a selezionare. Il pinch
  resta libero. Un doppio tocco su "Invia" non invia due volte.
- Tastiera: su iOS la tastiera non ridimensiona la pagina ma solo il visual viewport; `--kb` (CSS) ne segue l'altezza
  (soglia 80 px, ignorando il pinch) e il compositore resta sopra la tastiera.
- Altro: `viewport-fit=cover` e margini di sicurezza, `100dvh`, `-webkit-text-size-adjust`, niente rilevamento automatico di
  numeri di telefono o indirizzi, selezione di testo disattivata solo sui controlli.
- [NON PROVATO] Su un iPhone vero: il blocco effettivo dello zoom con doppio tocco, il compositore sopra la tastiera, la PWA a
  schermo intero e la barra di stato. La logica, il CSS e il DOM sono verificati nei motori, non il comportamento di iOS.
- Marchio: il logo di Cursor e' un marchio di Anysphere. Sta in un file a parte (`pwa/icons/cursor-logo.svg`, riproduzione
  piatta) per poterlo sostituire con facilita'; vedi `docs/SETUP.md`. Per scelta dell'utente (12/10) e' anche l'icona
  sulla schermata Home e la favicon: `tools/make-icons.mjs` legge i poligoni dall'SVG e genera le PNG (180, 192, 512 px, a
  tutto campo: gli angoli li arrotonda iOS) senza dipendenze; cambiando l'SVG basta rilanciarlo.

### 10.4b Interfaccia iOS rivista (14/10) [OK in browser, NON PROVATO su iPhone]
Pacchetto scelto dall'utente: (1) barra in basso Chat / Impostazioni con badge delle richieste che richiedono attenzione, nascosta
nelle chat (li' c'e' il compositore); (2) righe con titolo, progetto e stato su righe distinte, icona del tipo di richiesta
(domanda, approvazione, piano), anteprima della domanda; (3) testo dell'agente formattato (titoli, elenchi, codice, citazioni,
grassetto e corsivo) con un formattatore proprio e sicuro (`pwa/js/markdown.js`: solo nodi DOM, nessun link cliccabile, HTML
resta testo; 6 test); (4) scorrere una riga verso sinistra scopre "Ignora" (eventi Pointer, `touch-action: pan-y pinch-zoom`,
l'elenco non si ridisegna durante il gesto) e tirare giu' l'elenco in cima lo aggiorna (eventi tocco); (5) dissolvenza di 160 ms
tra le schermate, solo opacita' (una trasformazione sposterebbe il compositore fisso) e spenta da "Riduci movimento".
Verificato: `tools/ui-check.mjs` in WebKit e Chromium, tema chiaro e scuro (74-80 controlli, compresi trascinamento con il
mouse, "Ignora" dalla riga, tocchi veri via CDP in Chromium per "tira per aggiornare"). NON provato: il comportamento di questi
gesti con il dito su un iPhone vero (conflitto con il gesto "indietro" ai bordi, rimbalzo di Safari in cima, scorrimento).

### 10.4c Attivita' recente e aggiornamento del dettaglio (15/10) [OK in browser e su dati reali di sola lettura, NON PROVATO su iPhone]
Richiesta dell'utente: piu' aggiornamenti mentre l'agente lavora e nessun "blocco" dopo aver risposto a una domanda. Causa: il
dettaglio (ultimo messaggio, domanda) si rileggeva solo quando cambiava la scheda della chat, e Cursor scrive l'intestazione con
ritardo (dopo una risposta la chat resta ~20 s "domanda live" senza altro da mostrare). Ora: `GET /api/chats/:id` restituisce
anche `activity` (ultimi 10 bubble: tipo, ora, categoria e ETICHETTA del tool, anteprima di una riga dei messaggi; mai comandi
ne' percorsi: `daemon/src/state/present.js` `activityOf`, `db.recentActivity`, ~2 ms) e la PWA rilegge il dettaglio ogni 4 s (1,5 s mentre l'agente lavora o si attende la sua reazione) a
schermata aperta e visibile (e al ritorno in primo piano). Dopo una risposta o un messaggio dal telefono il daemon rilegge quella
chat ogni secondo per 2 minuti (`watcher.boost`): nei log reali la nuova domanda veniva vista 2-5 s dopo la sua creazione (rilettura
periodica da 5 s), ora ~1 s. Pannello "L'agente sta lavorando" (tool con stato `loading` o chat in
corso), "Inviato: in attesa dell'agente" (dopo una risposta o un messaggio, fino al primo passo nuovo (confronto per id del bubble, non per orari) o a 90 s) o "Attivita' recente". Un tool rimasto `loading` da oltre 15 minuti e'
considerato un residuo. Forma dei bubble osservata sulla chat di prova: tipo 1 utente, tipo 2 assistente (testo) o tool
(`toolFormerData.name/status`, es. `ask_question`, `run_terminal_command_v2`, stato `completed`); NESSUN bubble di "pensiero".
Limite: se Cursor non scrive i passi nel database finche' non finiscono (non verificato su un'esecuzione lunga in diretta),
il pannello non puo' mostrare piu' di quanto Cursor ha scritto.

Misura dal vivo sulla chat di prova (osservatore in sola lettura ogni 0,5 s, dopo una risposta data dal daemon): 1,5 s dopo la
risposta la domanda diventa "residuo" (flag dell'header ancora acceso); l'agente lavora (comandi) ma `unfinishedRunAt` NON viene
scritto, quindi `running` resta falso per tutta la fase e la chat risulta in attesa senza esserlo; la domanda nuova compare come
bubble `loading` dopo ~16 s (stato "domanda live") ma `toolFormerData.params` e' vuoto fino al passaggio a `completed`, ~17 s
dopo (34 s dalla risposta): finche' l'agente non finisce di formulare la domanda Cursor non ne salva il testo. Conseguenze nella
PWA: durante quella finestra il pannello dice "L'agente sta preparando la domanda" (non piu' "apri Cursor sul Mac"), il
"residuo" non si mostra se l'agente sta lavorando o si attende la sua reazione, e il dettaglio si rilegge ogni 1,5 s fino alla
comparsa del testo. Leggere la domanda dalla finestra di Cursor invece che dal database NON accorcia l'attesa in modo praticabile: il vassoio
(`.glass-questionnaire-tray`) esiste nel DOM solo per la chat in primo piano nell'Agents Window (in una seconda misura la
finestra mostrava un'altra chat e il testo del vassoio corrispondeva a quella, non alla chat di prova); per leggere quella
giusta bisognerebbe portarla in primo piano, cambiando cio' che l'utente vede sul Mac. Seconda misura: domanda viva a +8,5 s,
testo nel database a +10 s (la prima volta 17 s: dipende da quanto l'agente impiega a formularla).
Ritardo residuo segnalato dall'utente ("arriva comunque in ritardo di qualche secondo su iOS"): nei log `detectMs` (dalla
creazione del bubble al rilevamento) era 2-5 s perche' la rilettura profonda delle chat era ogni 5 s; costo misurato di una
rilettura profonda di tutte le 11 chat visibili: ~25 ms. `CP_FULL_SCAN_MS` portato a 1000 (~2,5% di un core): atteso ~0,5-1,5 s.
Non c'e' nessun ritardo artificiale nel percorso daemon -> SSE/push; restano la scrittura di Cursor nel database e, per la
notifica, l'invio (`sendMs` ~0,6 s) piu' il recapito di Apple (non misurabile da qui).
Dopo il rilevamento piu' veloce l'utente riferisce: notifica push quasi immediata, ma la pagina della chat aperta si aggiorna con
~10 s di ritardo. Ipotesi (NON verificata, serve l'iPhone): il flusso live (SSE) arriva in ritardo o a scatti (iOS, proxy di
`tailscale serve`), mentre la pagina dipendeva da esso per lo STATO della chat (il dettaglio si rileggeva gia' ogni 1,5-4 s).
Mosse: la pagina della chat ora rilegge anche `/api/state` a ogni giro (stesso ritmo) e quindi non dipende piu' dal flusso;
Impostazioni ha un riquadro "Diagnostica connessione" (flusso attivo, numero e eta' degli eventi SSE, ritardo stimato
Mac->telefono con `at` aggiunto al payload FUORI dall'hash, aggiornamenti trovati dal controllo periodico prima che il flusso li
consegnasse, tempo di risposta del daemon): serve a dire se il ritardo sta nel flusso, nella rete o altrove.
Ottimizzazione successiva (l'utente: pagina piu' veloce, ma la notifica arriva ancora prima; senza pesare sul Mac): un giro del
watcher senza riletture profonde costa ~1,1 ms e una rilettura profonda di una chat 2-3 ms, quindi per una chat "guardata"
(qualunque richiesta di dettaglio la tiene calda per 15 s) o a cui si e' appena risposto/scritto (2 minuti) il watcher gira ogni
250 ms e la rilegge a ogni giro (costo ~1,5% di un core, solo in quei periodi); a riposo resta 1 giro al secondo. La pagina, in
attesa dell'agente, rilegge ogni 1 s. La notifica resta comunque un passo avanti perche' parte dal daemon senza aspettare la
pagina e senza bisogno del testo della domanda.
TROVATO IL VERO COLLO DI BOTTIGLIA (misura dal vivo, chat di prova, sola lettura, solo nomi e lunghezze dei campi): il bubble della
domanda nasce con `toolFormerData.status: "loading"`, SENZA `params`, ma gia' con `toolCallBinary` (base64, ~300 caratteri =
la stessa domanda serializzata); `params` arriva ~27 s dopo (in altre misure 1,5-17 s, e per ~40 s o piu' nel caso peggiore
riferito dall'utente), insieme al passaggio a `completed`. Su Cursor il vassoio con le opzioni era visibile subito. Il binario
e' un messaggio Protocol Buffers: campo 23 { campo 1 { 1: titolo, 2 (ripetuto): domanda { 1: id, 2: testo, 3 (ripetuto): opzione
{ 1: id, 2: etichetta }, 4: scelta multipla } } }, campo 57 = toolCallId, campo 59 = istante. Nessuno schema ufficiale: decodificatore
rigido in `daemon/src/cursor/questions.js` (`decodeQuestionBinary`; a ogni dubbio null) usato da `db.toolParams` quando `params`
e' vuoto. Confronto con `params` su TUTTE le domande reali di sola lettura delle chat visibili (80 bubble per chat): 109 su 110
identiche (titolo, id, testi, opzioni, scelta multipla, domande multiple); l'unica restante ha il campo 23 vuoto (argomenti non
ancora scritti), per cui si ricade sull'attesa dei `params`. Effetto atteso: il testo e le opzioni compaiono sul telefono
(e nella notifica) appena nasce la domanda, senza la fase "sta preparando".
Zoom al tocco di un campo di testo su iOS (segnalato dall'utente, i font erano gia' a 16 px): aggiunto `maximum-scale=1` al
viewport, che su iOS 10+ impedisce lo zoom automatico al focus ma lascia lo zoom con due dita (accessibilita'). NON provato su iPhone.

### 10.4d Schede, preferite e pagine alleggerite (15/10) [OK in browser, NON PROVATO su iPhone]
- Scelte dell'utente: barra a 4 voci (Attenzione, Chat, Preferite, Impostazioni), barra SEMPRE ferma in basso, niente note
  esplicative nelle schermate di lavoro (spostate in "Come funziona", sotto Impostazioni), cuore per le preferite.
- Attenzione = richieste da decidere + chat in corso + in sospeso; Chat = gruppi per progetto come la sidebar, con ricerca;
  Preferite = chat con il cuore. Preferite e silenziate sono preferenze LOCALI del daemon (`chat_prefs` in `store.db`,
  `POST /api/chats/:id/prefs {favorite?, muted?}`), non toccano Cursor. Scorrere una riga: "Ignora" se richiede attenzione,
  altrimenti il cuore.
- Barra in basso: l'utente segnala che sull'iPhone a volte sale a meta' schermo mentre scorre la lista. Non riprodotto nei
  browser di prova (li' e' ferma). Difese, TUTTE da provare sul telefono: livello proprio (`translate3d`, `will-change`) e
  riallineamento al fondo del visual viewport (`--vv-shift`, `bottomShift` in `viewport.js`, solo senza tastiera ne' zoom);
  con la tastiera aperta (ricerca) la barra si nasconde. Se non basta: scorrimento in un contenitore interno con la barra
  fuori dal flusso (piu' invasivo: tocca pull-to-refresh e posizione di scorrimento).

### 10.4e Silenzia e orari senza notifiche (15/10) [OK in test, NON PROVATO su iPhone]
- Silenzio per chat (campanella nella pagina della chat), per progetto (Impostazioni > Progetti silenziati; chiave
  `ws:<sectionId>` in `chat_prefs`) e fascia oraria (`quiet_hours` in `meta`, ora locale del Mac, anche a cavallo della
  mezzanotte; `GET/POST /api/settings/quiet`). Gli eventi vengono comunque segnati come notificati: finita la fascia non
  arriva un'ondata di avvisi vecchi. Il motivo dello scarto e' nel log (`push_skipped {reason, kind}`), mai il contenuto.

### 10.4f Ferma l'agente dal telefono (15/10) [OK su pagina finta e in browser, NON PROVATO su Cursor reale]
- `POST /api/chats/:id/stop`: il daemon apre la chat in Cursor (CDP) e preme "Stop generation" (stesso pulsante di invio, che con
  il campo vuoto e l'agente al lavoro cambia etichetta: FINDINGS 8). Solo se la chat risulta in corso e senza domanda o
  approvazione vive (409 `not_running` / `attention_pending`). Esito: il pulsante sparisce (`settled`) oppure la chat risulta ferma
  nello stato letto dal database. Nel log solo `stop_agent {verified}`.
- PWA: nel compositore, a campo vuoto e agente al lavoro, il pulsante di invio diventa "Ferma" (quadrato); serve un secondo tocco
  entro 4 s (diventa rosso). Scrivendo del testo torna "Invia". Da provare dal vivo: etichetta e posizione del pulsante in Cursor 3.x.

### 10.4g Dispositivi abbinati e badge (15/10) [OK in test, NON PROVATO su iPhone]
- Impostazioni > Dispositivi abbinati (compare solo con almeno due dispositivi): `GET /api/devices` (id = hash dell'hash del
  token, etichetta, ultimo accesso, notifiche attive; mai token ne' hash) e `POST /api/devices/:id/revoke` (rimuove la sessione e
  le sue sottoscrizioni push; il dispositivo corrente non si scollega da qui: per quello c'e' "Esci"). Due tocchi.
- Badge sull'icona: gia' presente dalla Fase 1 (`setAppBadge` dal service worker con il valore `badge` della notifica push, e dalla
  pagina aperta con il numero di chat che richiedono attenzione). Limite iOS: con l'app chiusa il numero cambia solo quando arriva
  una notifica (non esistono push silenziose): se risolvi una domanda sul Mac, il numero si aggiorna alla notifica successiva.

### 10.4h Conversazione intera, a pagine (15/10) [OK in test, NON PROVATO su iPhone]
- `GET /api/chats/:id/history?before=<indice>&limit=<n>` (limite 60, default 30): i bubble che precedono l'indice, in ordine
  cronologico, letti SOLO per indice dalla lista `fullConversationHeadersOnly` (mai l'intera conversazione, mai una scansione). Utente
  e assistente con il testo (tagliato a 6000 caratteri, con `truncated`); i tool come righe (tipo di azione e stato, mai comandi ne'
  percorsi); i bubble vuoti si saltano. Sola lettura: nessuna azione verso Cursor. Il contenuto non finisce mai nei log.
- PWA: `#/chat/<id>/storia` (link "Conversazione intera" nella pagina della chat): parte dal fondo, "Messaggi precedenti" carica
  la pagina prima mantenendo il punto di lettura. Testo dell'agente in Markdown sicuro (nessun link attivo).

### 10.4i Mac sveglio mentre un agente lavora (15/10) [OK in test; `caffeinate`, lettura di schermo/batteria/luminosita' verificati a mano; chiusura schermo e `pmset` NON PROVATI]
- Opzionale, SPENTO di default (Impostazioni > Mac sveglio; `GET/POST /api/settings/awake` con `enabled`, `closed`, `dim`; stato in `meta`).
- Livello 1 (sempre, nessun permesso): con almeno una chat in corso, `caffeinate -i -m -s -w <pid del daemon>`; dopo l'ultima chat resta
  2 minuti (tolleranza) poi si chiude. Verificato con `pmset -g assertions` (`PreventSystemSleep`, `PreventUserIdleSystemSleep`). Lo
  schermo NON e' tenuto acceso (niente `-d`). Chiudendo lo schermo `-s` vale solo con il caricatore (a batteria macOS lo ignora).
- Livello 2 "anche a schermo chiuso e a batteria": `sudo -n pmset -a disablesleep 1|0` dal daemon, possibile SOLO dopo
  `sudo tools/mac/power-setup.sh install` (regola sudoers che ammette esattamente quei due comandi; controllata con `visudo -cf`;
  `uninstall` la toglie). Rimesso a 0 con quattro protezioni: fine lavoro, spegnimento del daemon, processo di guardia
  (`/bin/sh` staccato che attende la morte del daemon, anche per SIGKILL), batteria < 20% a batteria (si riprende sopra il 25%).
  All'avvio il daemon ripara un `disablesleep 1` o una luminosita' rimasti da un arresto brusco (segni in `meta`); durante il lavoro
  riporta a 1 il valore se qualcuno lo rimette a 0. Se mai restasse a 1: `sudo pmset -a disablesleep 0`.
- Luminosita' a zero: `tools/mac/build.sh` compila `daemon/data/bin/cp-brightness` (Swift, DisplayServices non documentato; letta con
  successo: 1.0). Con lo schermo chiuso (`ioreg AppleClamshellState = Yes`) e un agente al lavoro si porta a 0 salvando il valore
  (anche in `meta` e nella guardia); si ripristina all'apertura o a fine lavoro. Non prova possibile senza chiudere davvero lo schermo.

### 10.4j Rinomina, archivia, ripristina (15/10) [PROVATO DAL VIVO su una chat di prova in Cursor; PWA NON PROVATA su iPhone]
- Dalla pagina di una chat: "Rinomina" (campo con il nome attuale) e "Archivia" (due tocchi, disattivato se l'agente lavora). Da
  Impostazioni > Chat archiviate: elenco con "Ripristina". API: `POST /api/chats/:id/rename {name}`, `POST /api/chats/:id/archive`,
  `GET /api/archived`, `POST /api/archived/:id/restore`.
- Tutto passa dal menu contestuale della riga nella sidebar di Cursor (tasto destro via CDP, `Input.dispatchMouseEvent` con
  `button: 'right'`, `buttons: 2`): voci `Rename`, `Archive`, `Unarchive`. Rinomina = campo `input.ui-text-editable` gia' selezionato,
  si scrive e si preme Invio (verificato il focus prima di scrivere); esito letto dal database (`composerHeaders.value.name`).
  Archivia = `composerHeaders.isArchived` diventa 1 (letto dal database).
- Le righe archiviate non sono nella sidebar: il ripristino accende il filtro "Archived" (menu "Customize Sidebar", voce
  `menuitemcheckbox`), usa "Unarchive" e RIMETTE il filtro com'era (impostazione persistente di Cursor). Verificato dal vivo: tornato spento.
- Prova dal vivo (Test Chat): rinomina e ritorno al nome originale; archivia -> `isArchived` true -> ripristina -> false, filtro spento.
- NON provato: archiviare una chat con una domanda in attesa; non si archivia una chat in corso (409 `running`).

### 10.5 Da verificare dal vivo, con Cursor riavviato con la porta di debug [NON PROVATO]
Ogni punto ha una diagnostica pronta: `cd daemon && npm run cdp -- status | inspect | tray` (stampa la struttura della
pagina e mai i testi).
1. `/json/list` espone davvero la pagina "Cursor Agents" (titolo o URL con `glass`).
2. Forma delle chiavi delle righe della sidebar (`row:<composerId>`), marcatore della riga selezionata, sezioni compresse.
3. Selettori del questionario su una domanda vera: opzioni, "Other...", editor libero (come si scrive e come si svuota),
   pulsanti "Next"/"Continue"/"Skip".
4. Clic "affidabili" con Cursor in secondo piano (`Emulation.setFocusEmulationEnabled`).
5. Quanto in fretta Cursor scrive `submitted` nel database (la verifica aspetta fino a 12 s).
6. Composer: invio con il pulsante, a capo con Maiusc+Invio, bozza gia' presente.
7. Messaggio a una chat che sta lavorando: Cursor lo mette in coda o ferma la run e lo invia? Il testo di esito nella PWA
   presume la coda (`queued` si legge dal database).
8. Domande "morte" dopo un riavvio di Cursor (flag acceso ma nessun questionario): oggi risposta 409 `no_question`; da
   verificare se serve degradare a un nuovo messaggio.
9. Ritardo con cui il database riflette un messaggio inviato (verifica con `bubbleCount`).

### 10.6 Esito della prova dal vivo (13/10, Cursor 3.24.6 riavviato con la porta di debug) [OK]
Prova fatta su una chat di prova creata apposta dall'utente (nessuna chat di lavoro toccata), con i moduli veri del daemon
(`createApp`, archivio temporaneo) e il database vero in sola lettura.
- [OK] Porta 9222 attiva; `/json/list` espone UNA finestra, la "Cursor Agents" (titolo di 13 caratteri). Righe della sidebar
  con chiave `row:<composerId>`.
- [OK] Selettori del questionario (`.glass-questionnaire-tray`, `.ui-tray-option`, `.questionnaire-freeform-option`,
  `.ui-tray-footer__primary/secondary button`) corretti al primo colpo. Provati e CONFERMATI dal database (`submitted` con le
  scelte attese, azione + verifica in 3-4 s): scelta singola, scelta multipla (due opzioni), "Other..." con testo libero,
  due domande in una sola chiamata (singola + multipla).
- [OK] Messaggio libero alla chat: scritto e inviato, confermato dal database (`bubbleCount` aumentato) in circa 0,5 s.
- Scoperte che i test su pagina finta NON potevano dare (corrette in `agents-ui.js`, con test di regressione):
  1. `innerText` del questionario e' VUOTO anche se visibile: serve `textContent` (senza, il confronto domanda/schermo falliva).
  2. Il composer non e' Lexical ma tiptap/ProseMirror (`.ui-prompt-input-editor__input`). Il pulsante di invio ha etichetta
     "Start voice input" a campo vuoto, "Send message" con testo, "Stop generation" mentre l'agente lavora.
  3. Cursor tiene vivi i pannelli di piu' chat (ognuno `data-agent-panel-conversation-shell` con `data-glass-agent-id` =
     composerId); quelli in secondo piano stanno dentro `data-keep-alive-hidden` e hanno un LORO composer. Composer, vassoio e
     invio si cercano ora solo nel pannello in primo piano (senza, il testo poteva finire nella chat sbagliata).
  4. Nessun marcatore di "riga selezionata" nella sidebar: la chat aperta si riconosce dal pannello in primo piano.
- Bug trovato dall'utente dal suo iPhone (14/10): su una domanda ignorata o vecchia (oltre 24 h, stato "In sospeso") la PWA
  diceva "Per rispondere apri Cursor sul Mac" e le opzioni non erano cliccabili, contro la regola "rispondere anche dopo ore o
  giorni". Corretto: se Cursor la tiene ancora aperta (`attention.live`) il modulo di risposta compare anche per le domande in
  sospeso (titolo "(ignorata)" / "(non risolta da tempo)", il pulsante "Ignora" diventa "Ripristina"); se non e' piu' aperta il
  daemon risponde 409. Controlli del browser: 54 per run.
- Latenze reali dal log (`push_sent`): domanda rilevata in 0,9-4,5 s, invio della notifica in 0,6-1,5 s.
- Non ancora provato: "Skip"; messaggio mentre la chat sta DAVVERO lavorando (coda o interruzione: l'esito `queued` letto era
  falso, ma non e' certo che la chat lavorasse in quel momento); clic con Cursor in secondo piano; ripristino della chat che
  l'utente stava guardando; se un questionario "morto" dopo un riavvio esiste (la domanda aperta al momento del riavvio e'
  rimasta cliccabile e la risposta e' arrivata).
- Da capire: subito dopo una risposta la chat risulta ancora con una domanda "viva" per alcuni secondi e i suoi parametri non
  si leggono (il bubble successivo non e' ancora completo): innocuo (409 `stale`/`no_question`), ma la PWA puo' mostrarla un attimo.

## 11. Approvazioni di tool ("Allow"/"Run"): segnale, regole e cosa NON e' provato
Richiesta dell'utente (12/10): in un suo progetto una chat si era fermata ad aspettare un "allow" (a causa di un hook) e non era
arrivata alcuna notifica: si puo' notificare anche questo?

### 11.1 Il segnale [OK] [CODICE]
- [OK] In un bubble di tool, `toolFormerData.additionalData` ha la chiave `reviewData` (e, se di mezzo c'e' un hook,
  `blockReason`) SOLO quando e' coinvolta una revisione umana: 2 bubble su 5274 controllati (query per `composerId`, nessuna
  scansione intera). Uno e' un comando di terminale della chat `6814061b`, creato alle 17:19:49, seguito dal bubble successivo
  solo 67 s dopo (17:20:56): coincide con l'attesa riferita dall'utente (circa 17:20-17:21).
- [OK] Forma di una revisione RISOLTA (comando approvato dall'utente): `reviewData: { approvalType: "user", selectedOption: "run",
  status: "Done", allowlistOptions: [], candidatesForAllowlist: [], defaultAllowlistOptionIds: [], hasClassifierSuggestions:
  false, isShowingInput: false, selectedAllowlistOptionIds: [] }`. `blockReason` e' una stringa prodotta dall'hook (contiene
  la parola "hook"); il testo non si riporta ne' si legge nel daemon: potrebbe contenere comandi.
- [CODICE] `reviewData.status` e' un enum con tre valori: `None`, `Requested`, `Done`. Cursor cerca da solo, tra gli ULTIMI DUE
  bubble (`getLastBubbleWithReviewStatusFromLast2Bubbles`), un tool con `status === "Requested"` tra: EDIT_FILE,
  EDIT_FILE_V2, RUN_TERMINAL_COMMAND_V2, MCP, CALL_MCP_TOOL, READ_MCP_RESOURCE, CREATE_PLAN, WEB_FETCH.
- [CODICE] `reviewData.approvalType` e' un enum: `user`, `allowlist`, `full_auto`, `none`; `selectedOption`: `run`, `skip`,
  `allowlistCommands`, `rejectAndTellWhatToDoDifferently`, `edit`. In modalita' automatica Cursor scrive lui stesso
  `approvalType: full_auto` e seleziona `run` (funzione `_autoApproveAllComposersInMode`, che scorre proprio i bubble con
  `reviewData.status === "Requested"`): per questo `allowlist` e `full_auto` non contano come attesa.
- [CODICE] Indizio che `Requested` sia scritto nei dati del composer (quindi nel database) e sopravviva a un ricaricamento: una
  funzione di pulizia dei tool in sospeso ha un'opzione `preservePendingApprovals` che salta i bubble con `reviewData.status`
  `Requested` o `Done`. Non prova QUANDO viene scritto (11.4).
- [OK] Un `create_plan` resta `Requested` per ore finche' il piano non e' approvato: e' il caso `piano` (ha il suo flag
  `hasPendingPlan`), escluso dalla nuova regola.
- [OK] L'hook dell'utente e' per progetto (`.cursor/hooks.json`, evento `beforeShellExecution`, esecuzione a "failClosed") e
  risponde `permission: "ask"` ai comandi fuori policy, cioe' chiede l'approvazione all'utente: e' la causa dell'attesa. Non
  esiste un hook globale (`~/.cursor/hooks.json`).

### 11.2 Regole adottate [DECISIONE]
- Tipo di richiesta `approvazione`: l'ultimo o il penultimo bubble e' un tool (non `ask_question`, non `create_plan`) con
  `reviewData.status === "Requested"` e `approvalType` diverso da `allowlist` e `full_auto` (un tipo assente o sconosciuto non
  esclude). Chiave = `toolCallId` (stessa deduplica delle domande).
- E' "viva" se il flag `hasBlockingPendingActions` e' acceso, oppure la chat sta lavorando (l'agente e' fermo ad aspettarti),
  oppure il bubble e' recente (meno di 120 s: l'header di Cursor arriva in ritardo, 9.7). Una `Requested` in una chat ferma,
  senza flag e vecchia e' un residuo (Cursor chiuso a meta') e non conta.
- La notifica parte solo se la richiesta e' ancora in attesa dopo `CP_APPROVAL_DELAY_SECONDS` (8 s): chi e' al Mac e
  approva subito non riceve nulla. Nell'attesa la chat si rilegge ogni secondo. Una sola notifica per richiesta, nessun
  promemoria. All'avvio del daemon valgono le regole delle domande (recenti si', vecchie solo nell'app).
- Il testo della notifica e della PWA riporta solo il TIPO di azione ("Comando da eseguire", "Modifica di un file", "Strumento
  MCP", "Richiesta web", "Azione da approvare"): mai il comando, i percorsi o il testo dell'hook.
- Dalla PWA si approva o si rifiuta SOLO un comando di terminale (11.5); per ogni altro tipo di richiesta il pannello dice di
  decidere sul Mac. "Ignora" vale come per le domande, e un messaggio dal telefono con l'approvazione in attesa e' rifiutato
  (409 `approval_pending`).
- Il log registra `approval_seen` (eta' del bubble, chat in corso, flag, avvio) e `approval_gone` (secondi di attesa, se e'
  stata notificata): solo numeri e booleani. Serve a chiudere 11.4 e a misurare quanto durano le attese. Ogni `push_sent`
  porta anche `detectMs` (dall'inizio della richiesta alla notifica; per le approvazioni comprende il ritardo di 8 s) e `sendMs`
  (durata dell'invio): la prima misura in secondi della latenza vera, per domande e approvazioni.

### 11.3 Cosa e' stato provato
- [OK] Test automatici con bubble sintetici nella forma osservata (suite 176/176): attesa prima di notificare, un solo evento
  per richiesta e nuovo evento per una nuova richiesta, approvazione data dal Mac prima del ritardo (nessuna notifica),
  richiesta gia' presente all'avvio (recente e vecchia), residuo, penultimo bubble, nessun "chat finita" mentre aspetta,
  comando e identificativi mai nel payload ne' nel log, tool senza `reviewData` sempre `residuo`, messaggio rifiutato.
- [OK] Sul database reale (sola lettura, solo conteggi): 35 chat visibili, 0 approvazioni classificate: nessun falso positivo
  (le 2 `reviewData` esistenti sono `Done`).
- [OK] PWA: chat dimostrativa con un'approvazione in WebKit e Chromium, tema chiaro e scuro (`tools/ui-check.mjs`).

### 11.4 Prova con un'approvazione vera (13/10) [OK] e cio' che resta [NON PROVATO]
- [OK] Approvazione vera del 13/10 (hook dell'utente, un suo progetto): nel log `approval_seen` con `{ageSec: 16, running:
  true, flag: false}`, dopo 8 s di attesa `push_sent kind=approvazione` (`detectMs` 24223, `sendMs` 624), alla decisione
  `approval_gone {waitedSec: 92, notified: true}`. Quindi `reviewData.status: "Requested"` VIENE scritto nel database
  DURANTE l'attesa e il segnale funziona; `hasBlockingPendingActions` NON si accende per le approvazioni (la regola non lo
  richiede); la chat risulta "in corso" (`running`).
- Il bubble aveva gia' 16 s quando il daemon l'ha visto (poi +8 s di attesa = 24 s alla notifica): non si sa se la causa e'
  il tempo dell'hook, la scrittura ritardata di Cursor o la scansione. Da misurare con altre approvazioni.
- Che la notifica sia arrivata sull'iPhone lo conferma solo l'utente.

### 11.5 Approvare o rifiutare dal telefono (15/10) [OK sul rifiuto dal vivo, "Esegui" NON provato dal vivo]
- Cursor: la card del comando e' `.ui-shell-tool-call` dentro la riga con `data-message-id` = id del bubble nel database; i
  pulsanti si riconoscono dal testo (Run/Esegui e Skip/Rifiuta). `AgentsUi.approval` apre la chat, trova la carta di QUEL
  bubble (se manca o ha altri pulsanti: errore, nessun clic) e preme il pulsante.
- Daemon: `POST /api/chats/:id/approval {key, decision: approve|reject}`. Rifiuta chiave non piu' attuale (`stale`), tool non
  di terminale (`unsupported`), funzione spenta (`CP_APPROVALS=0`, `approvals_disabled`). Il dettaglio della chat porta
  `approval {key, type, supported, command, description}`: il COMANDO esce solo da questa API autenticata (max 2000
  caratteri), mai da notifiche e log (il log ha `approval_decision {decision, verified}`).
- PWA: comando in carattere monospace + descrizione, pulsanti "Esegui" e "Rifiuta" a DUE tocchi (il primo arma il pulsante
  per 5 s, il secondo invia: un tocco sbagliato non esegue nulla sul Mac).
- Prova dal vivo (15/10, su una vera richiesta in attesa; sul Mac l'utente non stava usando la chat): il rifiuto ha cliccato la
  carta giusta e l'agente ha proseguito. Nel database: subito dopo il clic il bubble resta `loading` con `reviewData.status:
  "Requested"` e `selectedOption: "rejectAndTellWhatToDoDifferently"`; la risposta del daemon e' stata `verified:false` perche'
  dopo 10 s non era cambiato altro. Poco dopo (entro un minuto circa) il bubble risulta `status: "completed"` con
  `additionalData.status: "rejected"` e l'agente, rifiutato, ha riprovato con un nuovo comando (nuovo bubble, nuova
  richiesta `Requested`, quindi nuova approvazione da decidere). Conclusione: `reviewData.status` NON passa a `Done` al
  rifiuto; la scrittura dell'esito e' ritardata. La conferma del daemon accetta la carta che si chiude in Cursor (`settled`), `status != loading` o "la richiesta non e' piu'
  l'attenzione corrente", ma entro 10 s puo' ancora risultare `verified:false` con una decisione riuscita: la PWA lo dice
  ("non riesco ancora a confermare") senza trattarlo come errore.
- [NON PROVATO dal vivo] "Esegui": il comando di quella richiesta faceva `git add -A && git commit` in un altro progetto
  dell'utente, quindi NON e' stato approvato per prova. Il percorso di codice e' lo stesso del rifiuto (cambia solo il
  pulsante), ma l'esito nel database non e' osservato.

#### Storico: cosa non era provato prima

- Che durante l'attesa il database contenga davvero `reviewData.status: "Requested"` per un comando di terminale: le due
  `reviewData` viste erano gia' `Done`. Se Cursor tenesse la richiesta solo in memoria fino alla decisione, il daemon non
  vedrebbe nulla durante l'attesa (nessun errore e nessuna notifica: la situazione di prima). Il bundle fa pensare che sia
  scritta (la funzione che la cerca legge i bubble del composer) ma non prova QUANDO.
- Se `hasBlockingPendingActions` si accende per le approvazioni, e se `unfinishedRunAt` resta impostato durante l'attesa (la
  regola non richiede ne' l'uno ne' l'altro: bastano un bubble recente o la chat in corso).
- Come verificare: alla prossima attesa vera nel log compare `approval_seen` (se c'e', il segnale funziona) e, dopo 8 s,
  `push_sent kind=approvazione`; alla decisione `approval_gone`. Se l'attesa c'e' stata ma il log non mostra nulla, il
  segnale non e' persistito e serve un'altra strada (per esempio l'interfaccia di Cursor via CDP).
