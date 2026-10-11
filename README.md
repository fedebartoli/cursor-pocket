# cursor-pocket

Controlla da iPhone le chat locali dell'Agents Window di Cursor: notifiche push per domande, approvazioni ("allow") e chat finite,
elenco raggruppato per workspace come nella sidebar, pulsante "Ignora" per togliere il pallino rosso (solo nell'app) e,
se Cursor e' avviato con una porta di debug locale, risposte alle domande, nuovi messaggi e approvazione o rifiuto dei
comandi di terminale dal telefono.

Stato: daemon Node 22 senza dipendenze + PWA, in uso su un iPhone reale con avvio automatico (`tools/launchd.sh install`).
Le azioni su Cursor (rispondere, saltare, scrivere, rifiutare un comando) sono state provate dal vivo su un Cursor vero
(FINDINGS 10.6, 11.5); "Esegui" su un comando vero e' coperto solo da test e dal rifiuto, che usa lo stesso percorso.
Ancora da verificare: zoom e tastiera su iPhone vero, push a schermo bloccato, tocco sulla notifica (anche da una chat
diversa), badge, tenuta nei giorni. Vedi `docs/ROADMAP.md`.

Prova rapida senza toccare i dati reali (nessuna installazione necessaria, serve Node >= 22.13):
```
cd daemon
npm run demo
```

- `docs/SETUP.md`        installazione, Tailscale, iPhone, variabili di configurazione
- `docs/FINDINGS.md`     cosa e' stato verificato (e cosa no)
- `docs/ARCHITECTURE.md` architettura e regole di derivazione
- `docs/ROADMAP.md`      fasi
- `daemon/`              daemon (sola lettura sul database di Cursor), test con `npm test`
- `pwa/`                 app web (HTML/CSS/JS senza build)
- `tools/`               generatori di icone, server dimostrativo, `launchd.sh` (avvio automatico), `cursor-cdp.sh`
                         (Cursor con porta di debug), `ui-check.mjs` (verifica facoltativa nel browser)
- `research/`            script di ricerca e prototipi

Avvertenza: rispondere dal telefono (Fase 2) equivale a controllare un agente con accesso alla shell del Mac, e richiede
una porta di debug di Cursor che, finche' e' aperta, permette a qualunque programma locale di controllarlo. Attivala solo
se ti serve, usa il servizio solo dietro Tailscale e con autenticazione. Il logo di Cursor nell'app e' un marchio di
Anysphere, tenuto in un file sostituibile (vedi `docs/SETUP.md`, "Marchio Cursor").

## Licenza e avvertenze

Codice con licenza MIT (vedi `LICENSE`); le icone derivano da Lucide (licenza ISC, `pwa/icons/LICENSE-lucide.txt`).
Progetto non ufficiale e non affiliato a Anysphere: "Cursor" e il suo marchio appartengono ai rispettivi proprietari.
Dipende da dettagli interni di Cursor (database locale e interfaccia dell'Agents Window) che possono cambiare senza preavviso.
