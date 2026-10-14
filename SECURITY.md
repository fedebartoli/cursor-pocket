# Sicurezza

**English.** cursor-pocket lets a phone drive agents that can run shell commands on your Mac. Treat it like remote access to your
machine. Report vulnerabilities privately (GitHub "Report a vulnerability" on the repository, not a public issue).

## Cosa protegge cosa

- Il daemon ascolta solo su `127.0.0.1`. L'unico modo previsto per raggiungerlo e' `tailscale serve` (HTTPS dentro la tua tailnet).
  **Non usare mai `tailscale funnel`**: pubblica il Mac su Internet e lascia nomi DNS pubblici anche dopo averlo spento
  (vedi `docs/SETUP.md`).
- Ogni dispositivo si abbina con un codice monouso mostrato sul Mac (`npm run pair`) e riceve una sessione propria, revocabile da
  Impostazioni ("Dispositivi abbinati"). Senza sessione l'API risponde 401. Le richieste che cambiano dati verificano anche l'origine (nessuna richiesta da altri siti).
- Il database di Cursor si apre sempre in sola lettura (`mode=ro`) e non viene mai scritto.
- Le chat, le chiavi e i token non vengono scritti nei log. I dati del daemon stanno in `daemon/data/` (permessi 0700, ignorata da git).

## Rischi accettati (da conoscere)

- Le azioni passano dall'interfaccia di Cursor con la porta di debug (CDP). Finche' la porta e' aperta, **qualunque programma locale
  dell'utente** puo' controllare Cursor. La porta e' solo su loopback; attivala solo se ti servono le azioni.
- Chi ottiene una sessione valida puo' rispondere alle richieste, **approvare l'esecuzione di comandi** e scrivere agli agenti.
  Proteggi l'iPhone (codice, Face ID) e scollega i dispositivi persi.
- "Mac sveglio a schermo chiuso" usa una regola `sudo` limitata e senza password (`tools/mac/power-setup.sh`): leggila prima di
  installarla; si toglie con `uninstall`.
- Il progetto dipende da dettagli interni di Cursor che possono cambiare: dopo un aggiornamento di Cursor controlla `docs/FINDINGS.md`.

## Segnalazioni

Usa la funzione privata di GitHub ("Security" > "Report a vulnerability"). Non pubblicare chat, chiavi o screenshot reali nelle issue.
