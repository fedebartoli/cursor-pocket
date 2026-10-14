#!/bin/zsh
# Start Cursor with the debug port (127.0.0.1 only). Works only if Cursor is NOT already running.
# Needed for phase 2 (phone actions). Not required for phase 1 (read-only).
if pgrep -x Cursor >/dev/null; then
  echo "Cursor is already running: quit it (Cmd+Q) and run this script again." >&2
  exit 1
fi
open -a Cursor --args --remote-debugging-port=9222
