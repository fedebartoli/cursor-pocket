#!/bin/zsh
# Avvia Cursor con la porta di debug (solo 127.0.0.1). Funziona solo se Cursor NON e' gia' in esecuzione.
# Serve alla fase 2 (azioni dal telefono). Non e' necessario per la fase 1 (sola lettura).
if pgrep -x Cursor >/dev/null; then
  echo "Cursor e' gia' in esecuzione: chiudilo (Cmd+Q) e rilancia questo script." >&2
  exit 1
fi
open -a Cursor --args --remote-debugging-port=9222
