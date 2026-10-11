#!/bin/bash
# Avvio automatico del daemon con launchd (macOS): LaunchAgent dell'UTENTE, senza privilegi di amministratore.
#
#   tools/launchd.sh install     crea ~/Library/LaunchAgents/local.cursor-pocket.daemon.plist e avvia il daemon
#   tools/launchd.sh uninstall   ferma il daemon e rimuove il plist (dati e log restano)
#   tools/launchd.sh restart     riavvia il daemon (dopo aver aggiornato il codice)
#   tools/launchd.sh status      stato del servizio e della porta
#   tools/launchd.sh print       stampa il plist che verrebbe creato, senza installare nulla
#
# Il daemon parte al login e viene riavviato se si ferma per un errore (non se lo fermi tu in modo pulito).
# Non tocca Cursor ne' Tailscale. Nel plist finiscono: percorso reale di node, percorso del progetto e le eventuali
# variabili CP_* presenti nell'ambiente al momento dell'installazione (se ne stampano solo i NOMI).
# Il progetto non deve stare in Documenti, Scrivania o Download: da launchd quelle cartelle richiedono permessi extra.
set -euo pipefail

LABEL="local.cursor-pocket.daemon"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DAEMON_DIR="$REPO/daemon"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/cursor-pocket"
LOG_FILE="$LOG_DIR/daemon.log"
PORT="${CP_PORT:-8787}"

die() {
  echo "Errore: $*" >&2
  exit 1
}

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Percorso REALE di node: quello della shell puo' essere un collegamento temporaneo (es. fnm) che cambia a ogni sessione.
resolve_node() {
  local candidate="${CP_INSTALL_NODE:-$(command -v node || true)}"
  [ -n "$candidate" ] || die "node non trovato nel PATH (serve Node >= 22.13)."
  "$candidate" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
    || die "serve Node >= 22.13 (trovato: $("$candidate" -v))."
  "$candidate" -p "require('fs').realpathSync(process.execPath)"
}

port_in_use() {
  nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1
}

is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

env_entries() {
  local name
  # Variabili CP_* dell'ambiente (CP_INSTALL_* sono dell'installatore, non del daemon).
  for name in $(compgen -e | grep '^CP_' | grep -v '^CP_INSTALL_' || true); do
    printf '    <key>%s</key><string>%s</string>\n' "$(printf '%s' "$name" | xml_escape)" "$(printf '%s' "${!name}" | xml_escape)"
  done
}

render_plist() {
  local node_bin="$1"
  local entries
  entries="$(env_entries)"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(printf '%s' "$node_bin" | xml_escape)</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$(printf '%s' "$DAEMON_DIR" | xml_escape)</string>
  <key>RunAtLoad</key><true/>
  <!-- Riavvio solo dopo un errore: un arresto pulito (launchctl stop/bootout) non viene contrastato. -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(printf '%s' "$LOG_FILE" | xml_escape)</string>
  <key>StandardErrorPath</key><string>$(printf '%s' "$LOG_FILE" | xml_escape)</string>
$( [ -n "$entries" ] && printf '  <key>EnvironmentVariables</key>\n  <dict>\n%s\n  </dict>' "$entries" )
</dict>
</plist>
PLIST
}

cmd_print() {
  render_plist "$(resolve_node)"
}

cmd_install() {
  [ "$(uname)" = "Darwin" ] || die "solo macOS."
  [ -f "$DAEMON_DIR/src/index.js" ] || die "non trovo $DAEMON_DIR/src/index.js."
  local node_bin
  node_bin="$(resolve_node)"

  if is_loaded; then
    echo "Servizio gia' installato: lo aggiorno."
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep 1
  fi
  if port_in_use; then
    die "la porta $PORT e' gia' occupata (daemon avviato a mano?). Fermalo e riprova: il servizio non puo' partire."
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  chmod 700 "$LOG_DIR"
  render_plist "$node_bin" >"$PLIST"
  chmod 644 "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "plist non valido: $PLIST"

  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl enable "$DOMAIN/$LABEL"

  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if port_in_use; then break; fi
    sleep 1
  done
  echo "Servizio:  $LABEL"
  echo "Plist:     $PLIST"
  echo "Node:      $node_bin"
  echo "Progetto:  $DAEMON_DIR"
  echo "Log:       $LOG_FILE"
  local names
  names="$(compgen -e | grep '^CP_' | grep -v '^CP_INSTALL_' | tr '\n' ' ' || true)"
  echo "Variabili CP_* copiate nel plist: ${names:-nessuna}"
  if port_in_use; then
    echo "Daemon in ascolto su 127.0.0.1:$PORT. Parte da solo a ogni login."
  else
    echo "Il daemon non risulta in ascolto su 127.0.0.1:$PORT: controlla il log ($LOG_FILE)." >&2
    exit 1
  fi
}

cmd_uninstall() {
  if is_loaded; then
    launchctl bootout "$DOMAIN/$LABEL" || true
  fi
  rm -f "$PLIST"
  echo "Servizio rimosso. I dati in $DAEMON_DIR/data e i log in $LOG_DIR non sono stati toccati."
}

cmd_restart() {
  is_loaded || die "servizio non installato: usa prima 'tools/launchd.sh install'."
  launchctl kickstart -k "$DOMAIN/$LABEL"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if port_in_use; then echo "Daemon riavviato, in ascolto su 127.0.0.1:$PORT."; return 0; fi
  done
  die "dopo il riavvio il daemon non risulta in ascolto: controlla il log ($LOG_FILE)."
}

cmd_status() {
  if [ -f "$PLIST" ]; then echo "Plist:     $PLIST"; else echo "Plist:     non installato"; fi
  if is_loaded; then
    # Solo poche righe: niente ambiente ne' altro dettaglio.
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*(state|pid|runs|last exit code) = / { sub(/^[[:space:]]+/, ""); print "Servizio:  " $0 }'
  else
    echo "Servizio:  non caricato"
  fi
  if port_in_use; then echo "Porta:     $PORT in ascolto"; else echo "Porta:     $PORT libera (daemon non attivo)"; fi
  [ -f "$LOG_FILE" ] && echo "Log:       $LOG_FILE ($(wc -c <"$LOG_FILE" | tr -d ' ') byte)" || true
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  print) cmd_print ;;
  *) echo "Uso: tools/launchd.sh <install|uninstall|restart|status|print>" >&2; exit 2 ;;
esac
