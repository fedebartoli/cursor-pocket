# AGENTS.md - cursor-pocket

Progetto: controllare da iPhone (PWA) le chat LOCALI dell'Agents Window di Cursor 3.x su macOS.
Nome provvisorio: cursor-pocket. Possibile pubblicazione pubblica su GitHub.

## Leggi prima di fare qualsiasi cosa
1. `docs/FINDINGS.md`   - tutto cio' che e' stato verificato (con cosa e' provato e cosa no)
2. `docs/ARCHITECTURE.md` - architettura decisa
3. `docs/ROADMAP.md`    - fasi e prossimi passi

## Regole di lavoro (preferenze dell'utente)
- Rispondere SEMPRE in italiano.
- Nessuna emoji nell'interfaccia: solo icone SVG professionali.
- UI sobria: niente effetti glow, niente gradienti, niente palette viola/indaco.
- Flusso continuo: a fine task chiedere come proseguire con lo strumento di domande, finche' l'utente non scrive STOP.
- Prima di cambiare configurazioni dell'utente (`~/.cursor/*`, impostazioni di Cursor) chiedere conferma e fare backup.
- Non riavviare Cursor senza chiedere (interrompe le chat in corso).

## Vincoli tecnici
- Dipendenze minime. Node 22 (SQLite integrato `node:sqlite`, nessun modulo nativo). Python 3.11 solo per script di ricerca.
- Il database di Cursor (`state.vscdb`, ~17 GB) si apre SEMPRE in sola lettura (`mode=ro`) e non si scansiona mai per intero:
  si interroga per `composerId`. Mai scrivere nel database di Cursor.
- Non loggare mai chiavi API, token o contenuti delle chat nei log. Attenzione: la riga di comando di alcuni processi
  Cursor (`ps`) contiene una chiave API in chiaro; non stampare mai l'output grezzo di `ps`.
- Il daemon ascolta solo su localhost; l'esposizione avviene via `tailscale serve` (HTTPS). Autenticazione obbligatoria.
- Dipendenza da dettagli interni di Cursor: isolarli in un solo modulo (`daemon/src/cursor/`) per poterli aggiornare
  quando Cursor cambia.

## Requisiti funzionali (dall'utente)
- Solo chat locali (non cloud), non archiviate, non sottoagenti.
- Raggruppare per workspace/repo, nello stesso ordine della sidebar dell'Agents Window (da verificare dove Cursor lo salva).
- "Need attention": chat con domanda o azione bloccante in attesa. Pallino rosso come in Cursor.
- Pulsante "Ignora" (solo locale al daemon): toglie il pallino, NON manda nulla a Cursor e non modifica la chat.
  Chiave: (composerId, toolCallId). Se la chat pone una NUOVA domanda, il pallino ricompare.
- Notifiche push: nuova domanda, approvazione richiesta ("allow" di un comando, anche da hook), chat finita. Niente promemoria ripetuti per default.
- Azioni: rispondere a una domanda in sospeso (anche dopo ore/giorni, scrivendo nella domanda) e inviare nuovi messaggi a una chat.
- Live view NON necessaria.

## Stato
Vedi `docs/ROADMAP.md`. Fase 0 fatta; Fase 1 (daemon + PWA in sola lettura con push) scritta, testata e in uso su iPhone
reale (push di domanda ricevute, latenza "subito" secondo l'utente); `tailscale serve` attivo; daemon con avvio automatico
via launchd (`tools/launchd.sh`, con il consenso dell'utente). La lista delle chat segue l'Agents Window: esclude i progetti
rimossi dalla sidebar (FINDINGS 8.2). Fase 2 (rispondere, saltare, scrivere messaggi via CDP) SCRITTA e provata solo su
simulatori e browser (FINDINGS 10): manca la validazione su un Cursor vero, che richiede di riavviarlo con
`--remote-debugging-port=9222` (`tools/cursor-cdp.sh`) e quindi di interrompere le chat in corso: chiedere SEMPRE prima.
Il 12/10 l'utente ha acconsentito al riavvio e lo fa da solo (Cmd+Q, poi `tools/cursor-cdp.sh` da un terminale esterno a
Cursor): se la porta 9222 e' attiva (`cd daemon && npm run cdp -- status`), riprendere dalla checklist "Ripresa dopo il
riavvio" in `docs/ROADMAP.md` (Fase 2). Se la porta e' chiusa il riavvio non e' avvenuto: non riavviare Cursor da qui.
Notifica di approvazione ("allow", anche da hook) implementata dal segnale `reviewData` (FINDINGS 11): NON provata su
un'approvazione vera; alla prossima controllare nel log `approval_seen` e `push_sent kind=approvazione` (FINDINGS 11.4).
Guida in `docs/SETUP.md`.
