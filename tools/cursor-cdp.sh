#!/bin/bash
# Avvia Cursor con la porta di debug locale: serve alle azioni dal telefono (rispondere alle domande, scrivere messaggi).
# La sola lettura (elenco, notifiche, "Ignora") NON ne ha bisogno.
#
#   tools/cursor-cdp.sh          avvia Cursor con la porta di debug (se Cursor non e' gia' aperto)
#   tools/cursor-cdp.sh status   dice se la porta di debug risponde
#
# Cose da sapere:
#  - Cursor deve essere CHIUSO: la porta si decide all'avvio. Chiudere Cursor interrompe le chat in corso.
#  - La porta ascolta solo su 127.0.0.1 (non e' raggiungibile dalla rete), ma finche' e' aperta qualunque programma
#    sul Mac puo' controllare Cursor. Per toglierla basta chiudere Cursor e riaprirlo normalmente.
#  - Non modifica nessuna impostazione di Cursor ne' file in ~/.cursor: l'opzione vale solo per questo avvio.
set -euo pipefail

PORT="${CP_CDP_PORT:-9222}"
URL="http://127.0.0.1:${PORT}/json/version"

port_up() {
  curl -fsS --max-time 1 "$URL" >/dev/null 2>&1
}

# Il processo principale di Cursor? Si guarda solo il percorso dell'eseguibile (mai la riga di comando: contiene chiavi).
cursor_running() {
  ps -axo comm= | awk '/\/Cursor\.app\/Contents\/MacOS\/Cursor$/ { found = 1 } END { exit !found }'
}

case "${1:-start}" in
  status)
    if port_up; then
      echo "Porta di debug ${PORT}: attiva."
    else
      echo "Porta di debug ${PORT}: chiusa."
      exit 1
    fi
    ;;
  start)
    if port_up; then
      echo "Cursor e' gia' attivo con la porta di debug ${PORT}: non serve fare altro."
      exit 0
    fi
    if cursor_running; then
      # Dopo Cmd+Q il processo impiega qualche secondo a sparire: si aspetta un poco prima di arrendersi.
      echo "Cursor e' ancora aperto: attendo fino a 10 secondi che si chiuda..." >&2
      for _ in $(seq 1 20); do
        cursor_running || break
        sleep 0.5
      done
    fi
    if cursor_running; then
      echo "Cursor e' gia' in esecuzione senza la porta di debug." >&2
      echo "Chiudilo con Cmd+Q (le chat in corso si interrompono: aspetta che finiscano) e rilancia questo comando." >&2
      exit 1
    fi
    open -a Cursor --args "--remote-debugging-port=${PORT}"
    for _ in $(seq 1 40); do
      if port_up; then
        echo "Cursor avviato: porta di debug ${PORT} attiva (solo 127.0.0.1)."
        exit 0
      fi
      sleep 0.5
    done
    echo "Cursor e' stato avviato, ma la porta ${PORT} non risponde ancora: controlla con 'tools/cursor-cdp.sh status'." >&2
    exit 1
    ;;
  *)
    echo "Uso: tools/cursor-cdp.sh [start|status]" >&2
    exit 2
    ;;
esac
