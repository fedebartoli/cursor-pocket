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
Vedi `docs/ROADMAP.md` (fasi 0-2 fatte, piu' la sezione "Fatto dopo la Fase 2") e `docs/FINDINGS.md` per cio' che e' provato.
Il daemon gira con avvio automatico (launchd, `tools/launchd.sh`) e l'app e' esposta solo con `tailscale serve` (mai Funnel: vedi
`docs/SETUP.md`, sezione Tailscale). Le azioni su Cursor passano da CDP (Cursor avviato con `tools/cursor-cdp.sh`, porta 9222): non
riavviare Cursor da qui, interrompe le chat in corso; chiedere sempre. Prove dal vivo: usare la chat "Test Chat" (id in
`/tmp/cp-testchat.txt` se esiste) e mandare pochi messaggi veri (costano). Non provato su un iPhone vero: vedi ROADMAP.
