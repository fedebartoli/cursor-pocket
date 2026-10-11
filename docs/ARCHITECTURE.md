# Architettura

```
iPhone (PWA in Home, Web Push)
        |  HTTPS (tailscale serve) + autenticazione
        v
Daemon Node 22 sul Mac  (ascolta solo su 127.0.0.1, nessuna dipendenza)
  cursor/   [UNICO punto che conosce i dettagli interni di Cursor]
    db.js         lettura in sola lettura di state.vscdb (header, coda di composerData, bubble, impostazioni sidebar)
    model.js      chat visibili, "in corso", richieste in attesa (domanda / residuo / piano)
    questions.js  parametri di ask_question -> domande e opzioni
    workspaces.js chat -> cartella/workspace e id di sezione della sidebar
    sidebar.js    ordine e stato compresso dei gruppi, come nell'Agents Window
    hash.js       hash di VS Code per gli id di sezione
    cdp.js        client CDP minimo (WebSocket di Node, solo loopback) verso 127.0.0.1:9222
    agents-ui.js  selettori e script di pagina dell'Agents Window: aprire una chat, questionario, Salta, messaggio
  actions.js      servizio delle azioni (coda, validazione, deduplica, verifica sul database, stato `actions`)
  watcher.js      polling ~1 s -> snapshot + eventi (domanda nuova, chat finita)
  state/
    present.js    modello -> payload per la PWA (funzione pura e deterministica)
    store.js      stato proprio (SQLite): ignorati, sottoscrizioni push, sessioni, codici, chiavi VAPID, notificati
  push/
    webpush.js    Web Push con soli node:crypto (RFC 8291 cifratura, RFC 8292 VAPID)
    notifier.js   composizione del messaggio, deduplica, invio con tentativi
  auth.js         codici di abbinamento monouso, sessioni, cookie
  http/           server (API REST + SSE + file statici), hub SSE, sicurezza (Host/Origin/CSP), statici
  cli.js          npm run pair | status | probe | cdp
pwa/              HTML/CSS/JS vanilla (moduli ES, nessuna fase di build), service worker, manifest
tools/            vendor-icons.mjs, make-icons.mjs, demo-server.mjs (finto Cursor), launchd.sh, cursor-cdp.sh,
                  ui-check.mjs (verifica facoltativa nel browser: WebKit e Chromium)
research/         script di ricerca e prototipi (non in produzione)
docs/
```

## Modello dati esposto alla PWA (`GET /api/state`)
```
{ version, state, status }
state  = { counts:{attention,pending,running,total}, attention:[Card], pending:[Card],
           workspaces:[{ id, name, home, collapsed, lastUpdatedAt, counts, chats:[Card] }] }
Card   = { id, name, subtitle, sectionId, workspaceName, state, running, unread, mode, lastUpdatedAt,
           attention: { kind, key, live, since, label, reason, title, prompt } | null }
state  = in_corso | attenzione | in_sospeso | finita | inattiva
status = { ok, error: 'db' | null, actions: 'ok' | 'off' | 'no_window' | 'disabled' }
         (volutamente stabile: niente orari, cosi' non genera invii inutili)
```
Il dettaglio (`GET /api/chats/:id`) aggiunge `lastMessage` (testo dell'ultimo messaggio dell'agente) e `question`
(titolo, domande, opzioni) quando la richiesta e' una domanda. `GET /api/info` riporta anche lo stato delle azioni e la
porta di debug attesa (per le Impostazioni).

## Regole di derivazione
- Elenco chat: `composerHeaders` non archiviata, non sottoagente, non bozza, `lastUpdatedAt > 0`; `agentLocation` nullo
  (chat classica, opzionale), `local` o `worktree`. Sono escluse le chat dei progetti RIMOSSI dalla sidebar
  (`ItemTable`, `cursor/glass.removedProjects`, confronto per `workspaceIdentifier.id`; riletto ogni 10 s): senza questa regola
  l'app mostrava 35 chat contro le 9 dell'Agents Window (FINDINGS 8.2).
- Raggruppamento per workspace nello stesso ordine della sidebar (`cursor/glassSidebarSettings`). Ordine predefinito (o se
  `sortGroupsBy` non e' `manual`): ultima attivita' decrescente. Con ordine manuale: prima le sezioni non presenti
  nell'ordine salvato (in ordine predefinito), poi l'ordine salvato filtrato. L'algoritmo e' ricavato dal bundle di Cursor e
  confermato a vista con lo screenshot della sidebar dell'utente (FINDINGS 8.3). Limite noto: `removedSectionIds` non e'
  gestito (nessun caso nei dati reali).
- "Richiede attenzione" = come il pallino di Cursor: `hasBlockingPendingActions` o `hasPendingPlan`. Il flag da solo non dice
  di che richiesta si tratta, quindi si classifica dall'ultimo bubble:
  - `domanda`: ultimo bubble `ask_question` senza risposta, cioe' `loading` (primi secondi) oppure `completed` con
    `additionalData.status: "pending"` (turno finito, domanda in attesa per ore), con il flag acceso OPPURE creata da meno di
    120 s (l'header di Cursor arriva in ritardo fino a 60 s: FINDINGS 9.7); chiave = `toolCallId`; azionabile in fase 2;
  - `approvazione`: l'ultimo o il penultimo bubble e' un tool (non `ask_question` ne' `create_plan`) con
    `additionalData.reviewData.status === "Requested"`, come lo cerca Cursor stesso; chiave = `toolCallId`. Viva se il flag e'
    acceso, oppure la chat sta lavorando, oppure il bubble e' recente (meno di 120 s); altrimenti e' un residuo e non conta.
    Notificata solo dopo `CP_APPROVAL_DELAY_SECONDS` di attesa continua, con il solo TIPO di azione. Non azionabile dalla PWA
    (FINDINGS 11);
  - `piano`: solo piano in attesa;
  - `residuo`: flag acceso ma l'ultimo bubble non e' una domanda aperta (domanda gia' risposta o superata da altri messaggi,
    oppure chat che sta lavorando con il flag rimasto acceso); chiave = ultimo tool o ultimo bubble.
  - Un tool SENZA `reviewData` non e' mai una richiesta: un tool in esecuzione ha lo stesso aspetto di una richiesta di
    approvazione basata su `loading` e assenza di `userDecision` (ipotesi smentita dal vivo, FINDINGS 9.1). Solo `domanda` e
    `approvazione` sono "vive" e generano notifiche; tutto il resto e' sola visualizzazione.
- Una chat che sta LAVORANDO (`running`) con un residuo o un piano non e' in attesa di te: stato "in corso", fuori da
  "Richiedono attenzione" (Cursor invece mostra il pallino anche mentre l'agente lavora). Durante la run conta solo una
  richiesta viva (domanda o approvazione). A run finita il residuo torna visibile e si puo' ignorare.
- "In sospeso" = richieste ignorate (`reason: ignorata`) oppure piu' vecchie di `CP_PENDING_AFTER_HOURS` (`reason: vecchia`).
  Il pallino e il conteggio di "Richiedono attenzione" non le includono.
- Ignora: scrive solo nello store del daemon, chiave `(chatId, key)`. Nessuna interazione con Cursor. Con una nuova richiesta
  la chiave cambia e il pallino ricompare. L'API risponde 409 `stale` se la chiave inviata non e' piu' quella della richiesta
  corrente: si ignora solo cio' che l'utente ha effettivamente visto.
- "In corso" = l'header ha `unfinishedRunAt` piu' recente di `CP_STALE_RUN_HOURS` E lo stato del composer non e' `completed`
  (il composer segnala la fine della run subito, l'header con anche 30 s di ritardo: FINDINGS 9.1).
- "Chat finita" (evento) = era in corso, poi ferma per `CP_DONE_SETTLE_MS`, senza richieste vive, senza una domanda aperta come
  ultimo bubble (una run che termina con una domanda aspetta l'utente: non e' finita), senza messaggi in coda e con un lavoro
  di almeno `CP_MIN_RUN_SECONDS` (un lavoro gia' in corso all'avvio del daemon conta come lungo).
- TUTTE le chat visibili si rileggono (coda del composer e ultimo bubble) ogni `CP_FULL_SCAN_MS` anche a header invariato:
  Cursor scrive l'header a scatti, ogni 60 s o a certi eventi, e dopo il composer; una domanda nuova o una fine run possono
  quindi non cambiarlo per decine di secondi. La rilettura costa 0,5-3 ms a chat (FINDINGS 9.7), per questo non serve limitarla
  alle chat "calde". Ritardo tipico di una notifica di domanda: pochi secondi.

## Esecuzione
- `npm start` per provare; per l'uso quotidiano un LaunchAgent dell'utente (`tools/launchd.sh install`): parte al login con
  il percorso reale di node, e' riavviato da launchd dopo un errore (non dopo un arresto pulito), scrive il log in
  `~/Library/Logs/cursor-pocket/daemon.log`. Non richiede amministratore e non tocca Cursor o Tailscale. L'esposizione HTTPS
  (`tailscale serve`) e' una configurazione di Tailscale che sopravvive ai riavvii da sola.

## Notifiche
- Eventi: domanda nuova (titolo della domanda e prima domanda nel corpo), approvazione richiesta (solo il tipo di azione,
  dopo `CP_APPROVAL_DELAY_SECONDS`), chat finita. Una notifica per evento, niente ripetizioni. Tocco -> apre la chat nella PWA (il service worker porta in primo piano la finestra e chiede la navigazione).
- Deduplica persistente: `a:<chat>:<toolCallId>` per domande e approvazioni, `d:<chat>:<lastUpdatedAt>` per le chat finite.
- Nessuna notifica dallo stato iniziale: all'avvio le domande piu' vecchie di `CP_STARTUP_GRACE_SECONDS` vengono segnate
  come gia' notificate senza inviare nulla.
- Invio: payload cifrato (aes128gcm), VAPID ES256 con durata 12 h, elenco chiuso di host dei servizi push (anti SSRF),
  due ritenti su 429/5xx/rete, sottoscrizione rimossa su 404/410. Il payload porta anche il conteggio per il badge.
- iOS: ogni push deve mostrare una notifica; il service worker chiama sempre `showNotification`, anche con payload anomalo.

## Azioni (fase 2)
Richiedono Cursor avviato con `--remote-debugging-port=9222` (`tools/cursor-cdp.sh`). Senza la porta il daemon resta in sola
lettura e lo dice (`status.actions: 'off'`), ricontrollando ogni 5 s. Dettagli e motivazioni: FINDINGS sezione 10.
```
POST /api/chats/:id/answer   { key, answers: [{ questionId, optionIds: [...], freeform }] }
POST /api/chats/:id/skip     { key }
POST /api/chats/:id/message  { text }
```
- Risposta di successo: `{ ok, verified, warning?, queued? }`. Errori: 400 `bad_answer`, 409 (`stale`, `no_question`, `mismatch`,
  `already_sent`, `question_pending`, `draft_not_empty`, `chat_not_in_sidebar`), 503 `actions_unavailable`, 504 `timeout`,
  502 `ui_failed`. Corpo massimo 64 KB (testi lunghi, anche non ASCII).
- Si agisce solo su cio' che il daemon vede ORA (chiave = `toolCallId`; altrimenti 409 `stale`) e dopo aver validato le
  risposte contro la domanda vera letta dal database.
- Una sola azione alla volta (coda seriale); la scadenza risponde subito 504 ma la coda resta occupata finche' il lavoro vero
  non finisce. Deduplica: stessa risposta 60 s, stesso messaggio 8 s.
- Rispondere: si apre la chat nella sidebar, si controlla che il questionario mostrato sia quello atteso, si compila
  (controllando lo stato prima di cliccare: in scelta singola un secondo clic DESELEZIONA), si preme "Next"/"Continue"; poi si
  riapre la chat che l'utente aveva aperta. Scrivere un messaggio: apre la chat, rifiuta se c'e' una bozza o una domanda in
  attesa, mette il focus sul composer, `Input.insertText` (a capo con Maiusc+Invio), invio.
- Verifica post-azione dal database (fino a 12 s): risposta `submitted` con la selezione attesa; messaggio con piu' bubble o
  coda del composer piu' lunga. Se Cursor non la scrive in tempo: `verified: false`, mai un successo inventato.
- Se Cursor e' stato riavviato e la domanda e' morta (flag acceso e bubble `pending` ma nessun questionario) oggi si risponde
  409 `no_question`. Da verificare dal vivo se il questionario sopravvive al riavvio e se serve degradare a un nuovo messaggio.
- Tutti i selettori sono in `cursor/agents-ui.js` (un solo file da aggiornare quando Cursor cambia) con una diagnostica
  (`npm run cdp -- inspect`) che stampa la struttura della pagina e mai i testi.

## Sicurezza
- Bind su 127.0.0.1; esposizione solo con `tailscale serve`. Autenticazione obbligatoria: codice di abbinamento monouso
  (8 caratteri, 15 minuti, 5 errori ogni 10 minuti) che apre una sessione (cookie `HttpOnly`, `SameSite=Strict`, `Secure`
  quando serve HTTPS, 90 giorni di inattivita'). Di codici e sessioni si conserva solo l'impronta SHA-256.
- Controlli HTTP: `Host` ammesso solo se localhost o `*.ts.net` o configurato (anti DNS rebinding); `Origin` uguale a `Host`
  sulle richieste che modificano dati; `Content-Type` JSON; corpo massimo 16 KB (64 KB per le azioni); CSP senza script o stili inline; `nosniff`,
  `frame-ancestors 'none'`; file statici senza path traversal; opzionale `CP_ALLOWED_TS_LOGINS` sull'identita' Tailscale.
- Log: JSON con allow-list; numeri e booleani passano, le stringhe solo per poche chiavi note. Mai contenuti di chat, mai
  messaggi di errore grezzi, mai chiavi. Test dedicato che cerca i contenuti nei log.
- Il database di Cursor si apre sempre con `mode=ro` e `query_only`; mai scansioni complete (si interroga per `composerId`).
  Test che verifica l'hash del file prima e dopo.
- Porta CDP (fase 2): Cursor la lega a 127.0.0.1, ma finche' e' aperta QUALUNQUE programma sul Mac puo' controllare Cursor.
  E' un rischio da accettare consapevolmente, solo se si vogliono le azioni; per toglierla basta riaprire Cursor normalmente.
  Il daemon non la espone mai: il client accetta solo URL WebSocket su loopback, sulla porta attesa e con percorso
  `/devtools/page/<id>`. Rispondere dal telefono equivale a guidare un agente con accesso alla shell: autenticazione sempre
  attiva, Tailscale, e consigliato `CP_ALLOWED_TS_LOGINS`.
- Le azioni non scrivono mai nel database di Cursor: pilotano l'interfaccia come farebbe l'utente (clic, testo, tasti) e
  leggono il database in sola lettura per verificare.

## UI della PWA
- Home: "Richiedono attenzione" (con conteggio), "In sospeso" (compresso), poi i workspace nell'ordine di Cursor (stato
  compresso come in Cursor, modificabile in locale), 5 chat per gruppo e "Mostra altre N".
- Dettaglio chat: stato, richiesta in attesa, Ignora/Ripristina, ultimo messaggio, compositore in fondo. Per una chat in
  corso il pannello della richiesta non viene mostrato (residuo di Cursor).
  - Con le azioni attive la domanda e' un questionario: opzioni con badge A, B, C (scelta singola = selezione esclusiva,
    multipla = caselle), voce "Altro" con campo di testo libero (sempre in fondo, come in Cursor), una sezione per ogni
    domanda, "Invia risposta" attivo solo a risposte complete, "Salta" con seconda conferma che scade da sola, "Ignora".
    L'esito resta alcuni secondi sopra il compositore anche quando il questionario sparisce.
  - Senza azioni (porta di debug chiusa o offline) le opzioni sono un elenco di sola lettura con la spiegazione e un
    collegamento alle Impostazioni.
  - Compositore (`composer.js`): campo che cresce con il testo (massimo 140 px), bozza conservata in memoria per chat (mai su
    disco), invio disattivato a campo vuoto, nascosto se c'e' una domanda in attesa (si risponde prima), ridotto a una riga
    di spiegazione se le azioni non sono disponibili; con la chat al lavoro avvisa che Cursor mette il messaggio in coda.
  - Il DOM di questionario e compositore e' persistente (aggiornato sul posto): un aggiornamento in diretta non fa perdere
    focus, selezione o testo digitato.
- Impostazioni: riquadro "Rispondere dal telefono" con lo stato (Attivo / porta chiusa / finestra non aperta / disattivato) e
  le istruzioni per attivarlo.
- Safari/iOS: `touch-action: manipulation` e blocco del SOLO secondo tocco di un doppio tocco (pinch libero, campi di testo
  esclusi), campi a 16 px, `viewport-fit=cover` con margini di sicurezza e `100dvh`, compositore che segue la tastiera
  (`visualViewport` -> `--kb`), `format-detection` spento, `-webkit-text-size-adjust`. Logo di Cursor in alto a sinistra nella
  home e nella schermata di abbinamento, e come icona sulla schermata Home (`pwa/icons/cursor-logo.svg`, file separato e
  sostituibile: marchio di Anysphere; `tools/make-icons.mjs` ne ricava le PNG).
- Marcatori: pallino rosso (attenzione), spinner (in corso), pallino blu (da leggere), orologio (in sospeso).
- Niente emoji, icone SVG (Lucide, ISC, vendorizzate); niente gradienti, glow o viola/indaco; un solo accento blu e il rosso
  solo come colore semantico; tema chiaro/scuro automatico; contrasti verificati WCAG AA.
- Il DOM si sostituisce solo quando il markup cambia davvero (`commit`): aggiornamenti periodici identici non interrompono
  selezione del testo o tocchi in corso.
- Offline: il service worker pre-carica tutti i file dell'app (elenco inserito dal daemon); i dati delle chat non vanno mai
  in cache.
