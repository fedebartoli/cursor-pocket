# Setup

Guida per far girare il daemon sul Mac e usare la PWA dall'iPhone. Stato: Fase 1 in uso (sola lettura, notifiche push per domande,
approvazioni e chat finite, pulsante Ignora locale). Fase 2 (rispondere alle domande, saltarle, scrivere messaggi) scritta e provata su simulatori, ma
NON ancora su un Cursor vero: e' facoltativa e si attiva come alla sezione 6.

## 1. Requisiti
- Mac con Cursor 3.x (Agents Window) e Node >= 22.13 (`node -v`). Nessun `npm install`: zero dipendenze.
- iPhone con iOS >= 16.4 (le notifiche push delle PWA esistono solo dalla versione 16.4 e solo per l'app installata
  nella schermata Home).
- Tailscale su Mac e iPhone, con MagicDNS e certificati HTTPS attivi per la tailnet (vedi sezione 4).

## 2. Avviare il daemon
```
cd daemon
npm start
```
- Ascolta solo su `127.0.0.1:8787` (porta con `CP_PORT`): dalla rete non e' raggiungibile.
- Legge il database di Cursor in sola lettura (`mode=ro`, `query_only`): non scrive mai in quel database.
- Conserva i propri dati in `daemon/data/` (permessi 0700): ignorati, sessioni, sottoscrizioni push, chiavi VAPID.
  Cancellare la cartella equivale a ricominciare da zero (sessioni e notifiche da riattivare).
- Controlli rapidi: `npm run status` (daemon attivo o no, dispositivi abbinati, sottoscrizioni push, richieste ignorate),
  `npm run probe` (legge il database di Cursor e riassume chat e gruppi in modo anonimo; con `-- --names` mostra i nomi
  dei workspace, utile per confrontare l'ordine con la sidebar di Cursor).

### Avvio automatico (consigliato per l'uso quotidiano)
```
tools/launchd.sh install     # crea il servizio e avvia il daemon
tools/launchd.sh status      # stato del servizio e della porta
tools/launchd.sh restart     # dopo aver aggiornato il codice
tools/launchd.sh uninstall   # lo toglie (dati e log restano)
tools/launchd.sh print       # mostra il plist senza installare nulla
```
- Crea SOLO `~/Library/LaunchAgents/local.cursor-pocket.daemon.plist` (servizio dell'utente: nessun amministratore) e la cartella
  dei log `~/Library/Logs/cursor-pocket/`. Non tocca Cursor ne' Tailscale. macOS puo' mostrare l'avviso "elemento in background
  aggiunto": e' il servizio di `node`.
- Il daemon parte al login e riparte da solo se si ferma per un errore; se lo fermi tu in modo pulito (`launchctl bootout`,
  `kill` senza `-9`) resta fermo fino al login successivo o a `restart`.
- Usa il percorso REALE di `node` (non il collegamento temporaneo di fnm/nvm): se cambi versione di Node o lo sposti, rilancia
  `tools/launchd.sh install`. Le variabili `CP_*` presenti nell'ambiente al momento dell'installazione vengono copiate nel plist
  (l'installazione ne stampa i nomi).
- Se la porta e' occupata (per esempio un `npm start` ancora attivo) l'installazione si ferma con un messaggio: chiudi prima
  quel daemon.
- Tieni il progetto fuori da Documenti, Scrivania e Download: i servizi lanciati da launchd non vi accedono senza permessi
  extra. Il log contiene solo contatori e tipi di evento.
- Dopo un riavvio del Mac servono comunque Cursor e Tailscale aperti: il primo e' la fonte dei dati, il secondo la strada
  dall'iPhone. `tailscale serve` ricorda la sua configurazione.

## 3. Provare la PWA senza toccare i dati reali
```
cd daemon
npm run demo                 # database di Cursor finto, push simulati, porta 8799
npm run demo -- --animate    # dopo 15 s una chat finisce, dopo 30 s ne compare una con una domanda
```
Il comando stampa l'indirizzo (`http://127.0.0.1:8799/`) e un codice di abbinamento. Nessun dato reale viene letto. Il
server dimostrativo simula anche Cursor (domande a una e due voci, azioni): `npm run demo -- --no-actions` simula invece
la porta di debug chiusa.

### Verifica automatica nel browser (facoltativa, per chi sviluppa)
```
node tools/ui-check.mjs webkit            # il motore di Safari, viewport iPhone 14
node tools/ui-check.mjs chromium --dark   # tema scuro; --shots salva gli screenshot
```
Percorre l'app contro il server dimostrativo (110-112 controlli: logo, questionario, compositore, approvazione, doppio tocco, CSP...). Serve
`playwright-core` con i browser installati (`npx playwright install chromium webkit`), fuori dal repository, che non ne
dipende: se non e' risolvibile imposta `PLAYWRIGHT_CORE=/percorso/node_modules/playwright-core/index.mjs`. Non sostituisce una
prova su un iPhone vero (zoom con doppio tocco, tastiera, schermo intero).

## 4. Rendere il daemon raggiungibile dall'iPhone (HTTPS con Tailscale)
Le notifiche push richiedono HTTPS. `tailscale serve` espone il daemon con un certificato valido SOLO dentro la tua
tailnet (non su Internet).

1. Una volta sola, nel pannello di amministrazione di Tailscale (pagina DNS) abilita "HTTPS Certificates".
   Nota di privacy: il nome della macchina (`<mac>.<tailnet>.ts.net`) finisce nei registri pubblici di Certificate
   Transparency. Senza questo passaggio `tailscale serve` non puo' ottenere il certificato.
2. Sul Mac: `tailscale serve --bg 8787` (eseguito e verificato con Tailscale 1.104.1). L'indirizzo e'
   `https://<mac>.<tailnet>.ts.net/`. La PRIMA richiesta HTTPS puo' impiegare circa 30 secondi perche' Tailscale ottiene il
   certificato; le successive sono immediate. L'app di Tailscale deve essere connessa: da ferma non risultano i certificati.
3. Controllo: `tailscale serve status` (deve riportare `(tailnet only)`). Per togliere l'esposizione:
   `tailscale serve --https=443 off` oppure `tailscale serve reset`.
4. Non usare `tailscale funnel`: rende il servizio pubblico su Internet.
5. Facoltativo ma consigliato: `CP_ALLOWED_TS_LOGINS=tuo@account npm start` accetta solo richieste che portano
   quell'identita' Tailscale (intestazione aggiunta da `serve`; blocca anche un eventuale Funnel, che non la porta).

## 5. Installare la PWA e abbinare l'iPhone
1. Su Mac: `cd daemon && npm run pair` stampa un codice `XXXX-XXXX` (monouso, valido 15 minuti).
2. Su iPhone, in Safari, apri `https://<mac>.<tailnet>.ts.net/`.
3. Condividi, poi "Aggiungi alla schermata Home". Apri l'app DALLA Home: Safari e l'app installata non condividono i dati,
   quindi l'abbinamento va fatto dentro l'app installata.
4. Inserisci il codice. L'accesso resta valido 90 giorni di inattivita' (cookie `HttpOnly`, `SameSite=Strict`).
5. Impostazioni, "Attiva notifiche", consenti, poi "Invia notifica di prova".

Il badge sull'icona mostra quante chat richiedono attenzione.

## 6. Rispondere dal telefono (Fase 2, facoltativo)
Rispondere alle domande di Cursor, saltarle e scrivere messaggi a una chat richiedono che Cursor sia avviato con una porta di
debug locale. Senza, l'app resta in sola lettura (notifiche, elenco, "Ignora") e le Impostazioni lo spiegano.

1. Chiudi Cursor con Cmd+Q. ATTENZIONE: le chat in corso si interrompono; aspetta che abbiano finito.
2. Dalla cartella del progetto: `tools/cursor-cdp.sh`. Apre Cursor con `--remote-debugging-port=9222`; non modifica impostazioni
   di Cursor ne' file in `~/.cursor`: l'opzione vale solo per quell'avvio. `tools/cursor-cdp.sh status` dice se la porta risponde.
3. Nelle Impostazioni dell'app il riquadro "Rispondere dal telefono" passa ad "Attivo" da solo (il daemon controlla ogni 5 s).
   Da terminale: `cd daemon && npm run cdp -- status`.
4. Per toglierla: chiudi Cursor e riaprilo normalmente (Dock, Spotlight). Dopo ogni riavvio del Mac o di Cursor va rifatto il
   passo 2: l'opzione non e' permanente. Un lanciatore permanente (app o Comando Rapido) non e' stato creato.

Cosa fa dal telefono, in chat:
- Domanda in attesa: scegli le opzioni (una o piu', secondo la domanda), oppure "Altro" e scrivi la risposta, poi "Invia
  risposta". "Salta" salta la domanda (chiede una seconda conferma). "Ignora" toglie solo il pallino dall'app.
- Messaggio: il campo in fondo alla chat invia un nuovo messaggio a Cursor. Se l'agente sta lavorando Cursor decide se
  metterlo in coda o inviarlo subito. Non parte se la chat ha una domanda in attesa (rispondi prima) o se nel campo di
  scrittura di Cursor c'e' gia' una bozza.
- L'esito compare sotto forma di conferma; se il daemon non riesce a confermare che Cursor abbia registrato l'azione lo dice,
  senza fingere un successo.

Da sapere:
- RISCHIO: la porta ascolta solo su 127.0.0.1 (non e' raggiungibile dalla rete), ma finche' e' aperta qualunque programma sul
  Mac puo' controllare Cursor. Attivala solo se vuoi le azioni.
- Il daemon pilota la finestra Agents come un utente: apre la chat nella sidebar, compila, e poi riapre la chat che avevi
  aperta (`CP_RESTORE_SELECTION=false` per non farlo). Evita di usare Cursor mentre rispondi dal telefono.
- La finestra Agents deve essere aperta. Che Cursor possa restare in secondo piano (o il Mac con lo schermo spento) e' da
  verificare dal vivo (FINDINGS 10.5): se un'azione non si completa, porta Cursor in primo piano e riprova.
- Stato di maturita': provata su un finto Cursor e su una pagina di prova, NON su un Cursor vero. Se un aggiornamento di
  Cursor cambia l'interfaccia le azioni possono fallire con un errore chiaro; i selettori sono in
  `daemon/src/cursor/agents-ui.js`. Diagnostica: `npm run cdp -- status | inspect | tray` (stampa la struttura, mai i testi;
  `--names` e `--texts` li mostrano: solo per prove tue, mai da condividere). Cosa resta da verificare: FINDINGS 10.5.

## 7. Configurazione (variabili d'ambiente)
| Variabile | Predefinito | Significato |
| --- | --- | --- |
| `CP_PORT` | `8787` | Porta locale del daemon (solo 127.0.0.1) |
| `CP_CURSOR_DB` | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | Database di Cursor (letto solo in lettura) |
| `CP_WORKSPACE_STORAGE` | `.../Cursor/User/workspaceStorage` | Cartelle dei workspace di Cursor |
| `CP_DATA_DIR` | `daemon/data` | Dati propri del daemon |
| `CP_PENDING_AFTER_HOURS` | `24` | Una richiesta in attesa piu' vecchia passa da "Richiedono attenzione" a "In sospeso" (0 = mai) |
| `CP_MIN_RUN_SECONDS` | `20` | "Chat finita" si notifica solo se il lavoro e' durato almeno cosi' |
| `CP_DONE_SETTLE_MS` | `5000` | Attesa di stabilita' prima di dichiarare finita una chat |
| `CP_STALE_RUN_HOURS` | `12` | Un marcatore "in corso" piu' vecchio e' un residuo (Cursor chiuso durante il lavoro) |
| `CP_STARTUP_GRACE_SECONDS` | `300` | All'avvio si notificano solo le domande e le approvazioni piu' recenti di cosi' |
| `CP_APPROVAL_DELAY_SECONDS` | `8` | Un'approvazione si notifica solo se e' ancora in attesa dopo cosi' tanto (0 = subito) |
| `CP_INCLUDE_CLASSIC` | `true` | Include le chat create nell'editor classico (senza `agentLocation`) |
| `CP_POLL_MS` / `CP_FULL_SCAN_MS` | `1000` / `1000` | Frequenza di lettura del database (una rilettura profonda di 11 chat costa ~25 ms) |
| `CP_PAIRING_TTL_MINUTES` | `15` | Validita' del codice di abbinamento |
| `CP_ALLOWED_HOSTS` | (vuoto) | Nomi host aggiuntivi accettati, oltre a localhost e `*.ts.net` |
| `CP_ALLOWED_TS_LOGINS` | (vuoto) | Account Tailscale ammessi (vedi sezione 4) |
| `CP_VAPID_SUBJECT` | `mailto:cursor-pocket@example.com` | Contatto indicato ai servizi push nelle intestazioni VAPID. Consigliato: un indirizzo che controlli. Lo vede solo il servizio push (Apple), non e' pubblico |
| `CP_ACTIONS` | `true` | `false` disattiva le azioni dal telefono (la PWA resta in sola lettura) |
| `CP_APPROVALS` | `true` | `false` disattiva solo Esegui/Rifiuta dal telefono (restano risposte e messaggi) |
| `CP_CDP_PORT` | `9222` | Porta di debug di Cursor (solo loopback) |
| `CP_CDP_POLL_MS` | `5000` | Ogni quanto si controlla se la porta di debug e la finestra Agents rispondono |
| `CP_ACTION_TIMEOUT_SECONDS` | `45` | Tempo massimo di un'azione prima di rispondere "timeout" al telefono |
| `CP_RESTORE_SELECTION` | `true` | Dopo un'azione riapre la chat che avevi aperta in Cursor |
| `CP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## 8. Cosa arriva in notifica
- Nuova domanda in una chat (titolo e prima domanda nel testo): una notifica per ogni domanda, mai ripetuta, di norma entro
  pochi secondi da quando compare in Cursor. Solo le domande vere (questionario dell'agente): i comandi in esecuzione non
  generano notifiche.
- Approvazione richiesta: l'agente e' fermo ad aspettare un tuo "Run"/"Allow" (un comando, una modifica, uno strumento MCP,
  una richiesta web; anche quando a chiederlo e' un hook del progetto). Parte solo se dopo `CP_APPROVAL_DELAY_SECONDS` (8 s)
  sei ancora in attesa, cosi' non ti disturba se approvi subito dal Mac. Il testo dice solo il tipo di azione ("Comando da
  eseguire"), mai il comando. Dal telefono (dentro l'app) puoi approvare o rifiutare un comando di terminale, con due tocchi; le altre richieste le decidi in Cursor sul Mac. Se non arriva mai, vedi
  FINDINGS 11.4 (e il log del daemon: `approval_seen`).
- Chat finita (dopo un lavoro di almeno `CP_MIN_RUN_SECONDS`).
- Toccando la notifica si apre la chat. Il contenuto della notifica e' cifrato end-to-end (RFC 8291) tra il daemon e
  l'iPhone: il servizio push vede solo che esiste una notifica, non il testo.
- Non vengono mai inviate notifiche dallo stato iniziale all'avvio del daemon (salvo domande o approvazioni
  recentissime, vedi `CP_STARTUP_GRACE_SECONDS`).

## 9. Il pulsante "Ignora"
Toglie il pallino rosso SOLO nell'app: non invia nulla a Cursor e non modifica la chat. La richiesta passa a "In sospeso"
e si puo' ripristinare. Se la chat pone una nuova domanda, il pallino ricompare.
Cursor lascia spesso il pallino acceso anche per richieste ormai chiuse ("residui"): l'app le mostra come "Richiesta non
risolta" e consente di ignorarle.

## 10. Risoluzione dei problemi
- "Daemon non raggiungibile": il daemon non gira o Tailscale e' spento su uno dei due dispositivi.
- Errore 421 / "Host non consentito": stai usando un nome diverso da localhost o `*.ts.net`; aggiungilo con `CP_ALLOWED_HOSTS`.
- Nessuna notifica: l'app non e' installata dalla Home, il permesso e' negato (Impostazioni iOS, Notifiche), l'indirizzo non
  e' HTTPS, oppure il test dalle Impostazioni dell'app non riesce. Controlla anche `npm run status`.
- "Database di Cursor non leggibile": controlla `CP_CURSOR_DB`; se Cursor e' aperto il database e' comunque leggibile.
- Mancano chat che avevi in Cursor, o ce ne sono in meno: l'app mostra solo quelle che compaiono nell'Agents Window, quindi
  nasconde le chat dei progetti che hai RIMOSSO dalla sidebar (anche se non le avevi archiviate). `npm run probe` riporta quante
  ne nasconde per questo motivo.
- Una chat che sta lavorando e' "In corso" anche se Cursor le mostra il pallino arancione: il pallino di Cursor resta acceso
  per vecchie domande, l'app lo considera solo quando la chat e' ferma.
- "Porta gia' in uso": un'altra istanza e' attiva, oppure cambia `CP_PORT`.
- Sessione scaduta o revocata: l'app torna da sola alla schermata di abbinamento; genera un nuovo codice con `npm run pair`.
- "Risposte dal telefono: non attive": Cursor non e' stato avviato con la porta di debug (sezione 6). "Finestra Agents
  chiusa": Cursor risponde ma la finestra Agents non e' aperta.
- "La domanda e' cambiata o e' gia' stata risolta": nel frattempo hai risposto sul Mac o l'agente ha fatto un'altra domanda;
  l'app si aggiorna da sola. "La chat non e' visibile nella sidebar": aprila o espandi il gruppo in Cursor.
- "Non riesco ancora a confermare...": l'azione e' partita ma Cursor non l'ha ancora scritta nel database; controlla sul Mac
  prima di ripetere (ripetere la stessa cosa entro pochi secondi viene rifiutato per evitare doppi invii).

## 11. Sicurezza in sintesi
- Il daemon ascolta solo su loopback; verifica `Host` (anti DNS rebinding), `Origin` sulle richieste che modificano dati,
  `Content-Type` JSON, limite di 16 KB per richiesta, CSP senza script o stili inline.
- Codici di abbinamento monouso con limite di 5 tentativi falliti ogni 10 minuti; di sessioni e codici si conserva solo
  l'impronta SHA-256.
- Nei log finiscono solo contatori e tipi di evento: mai chiavi, token, titoli o testi delle chat.
- Rispondere dal telefono (sezione 6) equivale a controllare un agente con accesso alla shell del Mac: usarlo solo dietro
  Tailscale, con l'autenticazione attiva e, meglio, con `CP_ALLOWED_TS_LOGINS`. Le azioni non scrivono mai nel database di
  Cursor: pilotano l'interfaccia come un utente e leggono il database in sola lettura per verificare. Il limite per
  richiesta sale a 64 KB solo per le azioni (testi lunghi).

## 12. Marchio Cursor
Il logo in alto a sinistra e nella schermata di abbinamento (`pwa/icons/cursor-logo.svg`) e' una riproduzione piatta
dell'icona di Cursor, marchio di Anysphere: serve a riconoscere a colpo d'occhio l'app, non indica alcuna affiliazione.
Sta in un file a parte (usato solo da `pwa/js/components.js`, funzione `logoImg`) proprio per poterlo sostituire o togliere:
se pubblichi il progetto valuta se mantenerlo e sostituiscilo con un'icona tua cambiando solo quel file. Lo stesso logo
e' l'icona dell'app sulla schermata Home e la favicon: le PNG (`pwa/icons/icon-192.png`, `icon-512.png`,
`apple-touch-icon.png`) si ricavano da `cursor-logo.svg` con `node tools/make-icons.mjs` (nessuna dipendenza; l'SVG deve
avere un `<rect>` di sfondo e dei `<path>` a linee rette, come quello incluso). Dopo un cambio iOS tiene l'icona vecchia: rimuovi
l'app dalla Home e aggiungila di nuovo.
