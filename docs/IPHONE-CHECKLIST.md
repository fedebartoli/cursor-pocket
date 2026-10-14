# Prove su iPhone vero

Tutto cio' che segue e' stato provato in WebKit/Chromium e sul Cursor vero via CDP, ma NON su un iPhone fisico.
Spunta ogni riga; se qualcosa non va, annota la schermata e cosa ti aspettavi (`docs/FINDINGS.md` va aggiornato con l'esito).

Preparazione: Mac acceso con Cursor avviato con `tools/cursor-cdp.sh`, daemon attivo (`tools/launchd.sh status`), PWA aperta dalla
schermata Home (non da Safari). Per le prove con l'agente usa una chat di prova, non un lavoro vero.

## 1. Installazione e abbinamento
- [ ] La PWA parte a schermo intero (senza barre di Safari), con l'icona giusta.
- [ ] Avvio: niente schermata nera o scheletro infinito; se il Mac e' irraggiungibile compare "Daemon non raggiungibile" con "Riprova" entro ~15 s.
- [ ] Abbinamento con il codice di `npm run pair`; dopo aver chiuso e riaperto l'app non chiede di nuovo il codice.

## 2. Barra in basso e scorrimento
- [ ] La barra (Attenzione, Chat, Preferite, Impostazioni) resta ferma mentre scorri e al rimbalzo a inizio e fine elenco.
- [ ] Tocca il campo di ricerca (tastiera su e giu'): la barra sparisce con la tastiera e torna al suo posto, mai a meta' schermo.
- [ ] Cambiando scheda l'elenco riprende la posizione di prima.
- [ ] Tirando in basso dall'inizio dell'elenco si aggiorna (gesto "tira per aggiornare").
- [ ] Doppio tocco: nessuno zoom. Pizzico con due dita: zoom possibile.

## 3. Notifiche (app chiusa e schermo bloccato)
- [ ] Permesso notifiche concesso da Impostazioni.
- [ ] Domanda dell'agente: arriva la notifica; toccandola si apre quella chat.
- [ ] Approvazione di un comando: arriva la notifica con testo chiaro.
- [ ] Chat finita: arriva la notifica.
- [ ] Il numero rosso sull'icona dell'app corrisponde alle richieste da decidere e scende quando le risolvi.
- [ ] Chat o progetto silenziati, e orari senza notifiche: non arriva nulla.

## 4. Azioni su una chat
- [ ] Rispondere a una domanda (scelta singola, multipla, "Altro" con testo): Cursor registra la risposta.
- [ ] "Ignora" (anche scorrendo la riga): il pallino sparisce, in Cursor non cambia nulla; "Ripristina" lo riporta.
- [ ] Scrivere un messaggio con il compositore sopra la tastiera, anche con un'immagine allegata.
- [ ] "Ferma" l'agente mentre lavora.
- [ ] Approvare o rifiutare un comando.
- [ ] Rinomina, Fissa/Togli, Archivia e Ripristina dal pannello in fondo alla chat.
- [ ] Cuore: la chat compare in Preferite.
- [ ] Conversazione intera (sola lettura): scorre, "Messaggi precedenti" carica altri pezzi.

## 5. Nuova chat
- [ ] "+" nella scheda Chat: scegli progetto, scrivi, avvia: la chat compare e si apre.
- [ ] "Scegli ramo e modello": le liste arrivano da Cursor; "Come in Cursor" e' la scelta di partenza. Con un'altra scelta la chat parte
      con quella, e dopo Cursor ha di nuovo i valori di prima.

## 6. Mac sveglio e tenuta
- [ ] Impostazioni > Mac sveglio: acceso con un agente al lavoro il Mac non va in stop; spento torna normale.
- [ ] Con regola `sudo` installata e schermo chiuso, l'agente continua a lavorare.
- [ ] Dopo uno o due giorni la PWA e' ancora abbinata e le notifiche arrivano ancora.
- [ ] Dopo aver cambiato rete (Wi-Fi/5G) l'app si ricollega da sola.

## 7. Dispositivi
- [ ] Impostazioni > Dispositivi abbinati: il telefono e' elencato; "Scollega" su un secondo dispositivo di prova lo disconnette.
