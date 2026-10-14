#!/bin/bash
# Permette al daemon di tenere il Mac sveglio ANCHE con lo schermo chiuso e a batteria, SOLO mentre un agente lavora.
#
# Cosa fa: aggiunge una regola sudoers (/etc/sudoers.d/cursor-pocket-pmset) che consente al TUO utente di eseguire, senza
# password, esattamente questi due comandi e nient'altro:
#     /usr/bin/pmset -a disablesleep 1
#     /usr/bin/pmset -a disablesleep 0
# Il daemon li usa cosi': 1 quando un agente lavora (e la funzione e' accesa in Impostazioni), 0 appena finisce, se il daemon
# si ferma, o se la batteria scende sotto la soglia. Un processo di guardia rimette 0 anche se il daemon muore all'improvviso.
#
#   sudo tools/mac/power-setup.sh install     crea la regola (controllata con visudo prima di attivarla)
#   sudo tools/mac/power-setup.sh uninstall   la rimuove e rimette disablesleep a 0
#   tools/mac/power-setup.sh status           dice se la regola c'e' e il valore attuale di disablesleep
#
# ATTENZIONE: con disablesleep a 1 il Mac NON va in stop nemmeno chiudendo lo schermo: in una borsa si scalda. Per questo il
# daemon lo tiene a 1 solo mentre un agente lavora e lo rimette a 0 con quattro protezioni (fine lavoro, spegnimento del daemon,
# processo di guardia, batteria bassa). Se mai restasse a 1:  sudo pmset -a disablesleep 0
set -euo pipefail

RULE="/etc/sudoers.d/cursor-pocket-pmset"
cmd="${1:-status}"

case "$cmd" in
  status)
    if [ -f "$RULE" ]; then echo "Regola sudoers: presente ($RULE)"; else echo "Regola sudoers: assente"; fi
    echo "Stato attuale: $(pmset -g | awk '/SleepDisabled|disablesleep/ {print $1 "=" $2}' | head -1)"
    echo "Prova senza password: $(sudo -n -l /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1 && echo consentita || echo non consentita)"
    ;;
  install)
    [ "$(id -u)" -eq 0 ] || { echo "Esegui con sudo: sudo $0 install" >&2; exit 1; }
    USER_NAME="${SUDO_USER:-}"
    [ -n "$USER_NAME" ] && [ "$USER_NAME" != "root" ] || { echo "Lancia il comando con sudo da un utente normale (serve SUDO_USER)." >&2; exit 1; }
    TMP="$(mktemp)"
    printf '%s ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0\n' "$USER_NAME" > "$TMP"
    visudo -cf "$TMP" >/dev/null || { rm -f "$TMP"; echo "La regola non e' valida: nessuna modifica." >&2; exit 1; }
    install -m 0440 -o root -g wheel "$TMP" "$RULE"
    rm -f "$TMP"
    echo "Regola creata per l'utente $USER_NAME: $RULE"
    ;;
  uninstall)
    [ "$(id -u)" -eq 0 ] || { echo "Esegui con sudo: sudo $0 uninstall" >&2; exit 1; }
    /usr/bin/pmset -a disablesleep 0
    rm -f "$RULE"
    echo "Regola rimossa e disablesleep rimesso a 0."
    ;;
  *)
    echo "Uso: [sudo] $0 install | uninstall | status" >&2
    exit 64
    ;;
esac
