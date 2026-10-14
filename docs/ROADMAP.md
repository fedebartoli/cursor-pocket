# Roadmap

## Fase 0 - Verifiche rapide (prima di scrivere codice)
Risultati in `docs/FINDINGS.md`, sezione 8.
- [x] Semantica di `hasBlockingPendingActions` e `hasUnreadMessages` (codice del bundle + dati: il flag resta acceso fino alla
  risposta e Cursor lo lascia acceso anche per richieste non piu' risolvibili).
  - [x] Traccia dal vivo del flag con una domanda vera (campionatore `research/phase0_sampler.py`): flag acceso insieme al
    bubble; il bubble passa da `loading` a `completed`/`pending` dopo 5-33 s e la domanda resta in attesa per ore. La prima
    interpretazione (8.1: "19 header su 20 erano residui") era sbagliata: vedi FINDINGS 9.1.
- [x] Valori di `agentLocation` (locale vs cloud): `null` | `local` | `worktree`; nessun cloud agent nel database locale.
- [x] Dove Cursor salva l'ORDINE dei workspace nella sidebar: `ItemTable`, chiave `cursor/glassSidebarSettings`.
  - [x] Confronto visivo con la sidebar reale (screenshot dell'utente, 12/10): stesso ordine e stesse dimensioni dei 7 gruppi,
    le chat classiche compaiono. Scoperto che la sidebar nasconde le chat dei progetti RIMOSSI (`glass.removedProjects`):
    9 chat contro le 35 del filtro precedente (FINDINGS 8.2, 8.3).
- [x] Mappatura dei workspace: copertura 35/35 con `agentLocation`, `workspaceIdentifier.uri`, `workspace.json`.
- [x] "Chat finita": segnali individuati (`unfinishedRunAt` dell'header, definizione di Cursor di turno completato).
  - [x] Osservata dal vivo la fine di 3 run: il composer passa a `completed` subito, l'header segue con ritardo (FINDINGS 9.1).
  - [ ] Osservare una run fermata a mano o fallita (il daemon oggi notifica "finita" anche in quel caso).
  - [ ] Prova dell'hook `stop` (richiede di toccare `~/.cursor/hooks.json`: conferma e backup). Con i segnali di 9.1 potrebbe
    non servire.
- [x] Approvazioni di tool ("Allow"/"Run", anche quelle chieste da un hook): notifica e pannello nella PWA, dal segnale
  `additionalData.reviewData.status === "Requested"` trovato nel database e nel bundle (FINDINGS 11). L'ipotesi "`loading`
  senza `userDecision`" resta smentita (68 notifiche false in 28 minuti, FINDINGS 9.1). Notifica dopo 8 s di attesa continua
  (`CP_APPROVAL_DELAY_SECONDS`), solo il tipo di azione.
  - [ ] Provarla con un'approvazione vera: nel log deve comparire `approval_seen` durante l'attesa e dopo 8 s `push_sent
    kind=approvazione` (FINDINGS 11.4: non e' provato che il database contenga `Requested` MENTRE si aspetta).
  - [x] Approvare/rifiutare dal telefono (solo comandi di terminale, due tocchi; FINDINGS 11.5). Rifiuto provato dal vivo, "Esegui" no.

## Fase 1 - Daemon + PWA in sola lettura con push
- [x] `daemon/`: lettura DB read-only, modello dati, watcher con eventi, SSE (test automatici: `cd daemon && npm test`).
- [x] Store proprio: ignorati, sottoscrizioni push, sessioni, codici di abbinamento, notificati (deduplica).
- [x] Web Push (VAPID) con soli `node:crypto`, deduplica, notifiche "domanda nuova" e "chat finita".
  Verificato con vettori di test (cifratura RFC 8291, firma VAPID), con un servizio push simulato e, il 12/10, con Apple
  (`web.push.apple.com`): la push di prova e' arrivata sull'iPhone.
- [x] `pwa/`: home con Richiedono attenzione / In sospeso / workspace, dettaglio chat, pulsante Ignora (solo locale), manifest,
  service worker. Verificata in browser a 390 px (tema chiaro e scuro) sul daemon reale con dati sintetici (`npm run demo`).
- [x] Autenticazione (codice monouso + sessione) e guida di setup (`docs/SETUP.md`).
- [x] `tailscale serve --bg 8787` eseguito il 12/10 con il consenso dell'utente, dopo che ha abilitato i certificati HTTPS
  nel pannello (`CertDomains` da 0 a 1). Verificato dal Mac: `(tailnet only)`, certificato valido, `/api/state` senza sessione
  risponde 401 via HTTPS; raggiungibile dall'iPhone.
- [x] iPhone reale (12/10): installazione in Home, abbinamento, permesso notifiche, push di prova ricevuta.
  - [ ] Ancora da verificare: push con PWA chiusa e schermo bloccato, tocco che apre la chat, badge sull'icona, notifica
    "domanda" e "chat finita" vere, tenuta nei giorni (sessione e sottoscrizione).
- [x] Confronto visivo dell'ordine dei workspace con la sidebar reale (`npm run probe -- --names`, 12/10).
- [x] Avvio automatico del daemon con launchd (12/10, su richiesta dell'utente): `tools/launchd.sh install|restart|status|
  uninstall`. Verificato: il servizio parte, tiene sessione e sottoscrizione push dell'iPhone, riparte da solo dopo `kill -9`
  (circa 1 s). NON verificato: avvio dopo un riavvio del Mac o un nuovo login.
- [x] Chat dei progetti rimossi dalla sidebar escluse (FINDINGS 8.2).
- [x] Notifica di domanda in ritardo (fino a 60 s): causa trovata (Cursor scrive l'header ogni 60 s, FINDINGS 9.7) e corretta
  con la lettura di tutte le chat e la regola della domanda recente.
  - [x] Latenza: l'utente riferisce che ora la notifica "sembra subito" (12/10). Una misura in secondi non e' stata fatta.
- [x] Chat in corso con il flag residuo acceso: "In corso" invece di "Richiedono attenzione".
- [x] Domanda nella PWA: elenco di sola lettura con la voce "Altro" (resta come ripiego quando le azioni non sono attive;
  rispondere e' la Fase 2).
- [ ] Gestire `removedSectionIds` se emerge un caso reale.

## Fase 2 - Azioni (richiede Cursor avviato con `--remote-debugging-port=9222`)
Scritta e provata su simulatori; dal 13/10 provata anche su un Cursor vero (FINDINGS 10.6): domande singola/multipla/"Altro"/due
domande e messaggio libero funzionano, confermati dal database. Restano: "Skip", messaggio a una chat che lavora davvero,
clic con Cursor in secondo piano, interfaccia dalla PWA su iPhone.
- [x] Client CDP (`cursor/cdp.js`): solo loopback, URL WebSocket validati, errori e scadenze; test con WebSocket finto e con
  server vero.
- [x] `cursor/agents-ui.js`: selettori isolati ricavati dal bundle (FINDINGS 10.1), questionario (singola, multipla, "Altro",
  piu' step), "Skip", messaggio, ripristino della chat aperta; provato su un Chromium vero con una pagina di prova.
- [x] Servizio delle azioni (`actions.js`): coda seriale, validazione contro il database, deduplica, verifica sul database
  (`submitted`, bubble, coda del composer), endpoint `answer` / `skip` / `message`, stato `status.actions`, CLI `npm run cdp`.
- [x] PWA: questionario interattivo, compositore dei messaggi, esiti, riquadro "Rispondere dal telefono" nelle Impostazioni.
- [x] Safari/iOS: blocco del solo doppio tocco (pinch libero), campi a 16 px, margini di sicurezza, compositore sopra la
  tastiera, logo di Cursor in alto a sinistra. Verificato in WebKit e Chromium (`tools/ui-check.mjs`, 125-127 controlli, tema
  chiaro e scuro).
- [x] Attivita' recente nella chat (passi dell'agente, stato "in attesa" dopo una risposta) con aggiornamento ogni 1,5-4 s a schermata aperta e rilettura ogni secondo dopo un'azione (FINDINGS 10.4c).
- [x] `tools/cursor-cdp.sh`: avvia Cursor con la porta di debug (solo a Cursor chiuso) e ne mostra lo stato.
- [x] (fatto il 13/10, esiti in FINDINGS 10.6 e 11.4; elenco sotto tenuto come procedura di ripresa) Riavviare Cursor con la porta di debug e validare dal vivo
  i punti di FINDINGS 10.5. Primo test: far rispondere il daemon a una domanda vera.
  Ripresa dopo il riavvio (chi apre una chat nuova parte da qui): l'utente chiude Cursor con Cmd+Q, poi da un terminale
  esterno a Cursor esegue `tools/cursor-cdp.sh` dalla cartella del progetto.
  1. `cd daemon && npm run cdp -- status` (porta e finestra Agents), poi `npm run cdp -- inspect` (struttura della pagina,
     senza testi): confrontare con FINDINGS 10.1 e correggere `SEL` in `cursor/agents-ui.js` se differisce.
  2. Con una domanda vera aperta in una chat: `npm run cdp -- tray` (opzioni, campo libero, pulsanti).
  3. Prova completa: far fare all'agente una domanda con `ask_question`, rispondere dalla PWA e controllare che il database
     riporti `submitted` con la selezione scelta (`verified: true`); ripetere con scelta multipla, "Altro" e due domande.
  4. Messaggio a una chat ferma e a una che sta lavorando (coda o interruzione?).
  5. Aggiornare FINDINGS 10.5 (da [NON PROVATO] a esito reale), correggere i selettori e ripetere `npm test`.
  6. Approvazione vera (FINDINGS 11.4): in un progetto con un hook che chiede l'approvazione, far scattare un comando e
     lasciarlo in attesa oltre 8 s. Nel log (`rg 'approval_|approvazione' ~/Library/Logs/cursor-pocket/daemon.log`) devono
     comparire `approval_seen`, poi `push_sent kind=approvazione` (con `detectMs` e `sendMs`) e, alla decisione,
     `approval_gone`. Se la chat aspetta ma il log tace, il segnale non e' scritto durante l'attesa: aggiornare 11.4.
- [ ] Gestione domande morte dopo riavvio di Cursor (oggi 409 `no_question`; valutare il ripiego a nuovo messaggio).
- [ ] Prova su un iPhone vero: nessuno zoom con doppio tocco, compositore sopra la tastiera, PWA a schermo intero.
- [ ] Lanciatore permanente di Cursor con il flag (app o Comando Rapido): solo con il consenso dell'utente.
- [x] Icona dell'app sulla schermata Home e favicon con il logo di Cursor (scelta dell'utente, 12/10): `tools/make-icons.mjs`
  la ricava da `pwa/icons/cursor-logo.svg`. Sulla Home si vedra' solo dopo aver rimosso e riaggiunto l'app (iOS tiene l'icona
  vecchia in cache).

## Fase 3 - Rifinitura e pubblicazione
- [ ] Hardening sicurezza, test, gestione aggiornamenti di Cursor (selettori).
- [ ] README, licenza (da scegliere con l'utente), guida di installazione, avvertenze di sicurezza.
- [ ] Rimuovere ogni dato personale dagli esempi; verificare che il database di Cursor non venga mai scritto.

## Idee rimandate
- Live Activity / app nativa (richiede account Developer a pagamento).
- ntfy come canale di notifica alternativo.
- Vista live delle chat in esecuzione.

## Idee rimandate (su richiesta dell'utente: prima rifinire il resto)
- Archiviare/ripristinare chat e gestire i progetti rimossi dalla sidebar, creare nuove chat dall'iPhone. Nota di ricerca
  (15/10, solo lettura del bundle): in Cursor l'archiviazione passa da `composerDataService` (campo `isArchived` + `lastUpdatedAt`
  e salvataggio) e per le chat locali non c'e' una chiamata di rete da imitare. Poiche' il database di Cursor non si scrive
  mai, la strada e' pilotare i pulsanti dell'Agents Window via CDP, come per le risposte (da provare con una chat di prova).
- Sondaggio di sola lettura della finestra Agents (15/10, nessun clic): tra le etichette dei pulsanti compaiono "New Agent",
  "New Project", "Pin", "Archive", "Stop generation" (con "Stop ^C"), "Attached image", "Add agents, context, tools" e campi di
  ricerca. Quindi per fissare, archiviare, fermare e creare chat esistono controlli da pilotare via CDP; "Rename" non e' emerso
  (probabile menu contestuale o doppio clic: da verificare). Nessuna di queste azioni e' ancora provata.
