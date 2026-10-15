#!/bin/bash
# Start Cursor with a local debug port: needed for phone actions (answer questions, send messages).
# Read-only use (list, notifications, Dismiss) does NOT need it.
#
#   tools/cursor-cdp.sh          start Cursor with the debug port (if Cursor is not already open)
#   tools/cursor-cdp.sh status   report whether the debug port responds
#
# Notes:
#  - Cursor must be CLOSED: the port is chosen at startup. Quitting Cursor interrupts in-progress chats.
#  - The port listens only on 127.0.0.1 (not reachable from the network), but while open any program
#    on the Mac can control Cursor. To remove it, quit Cursor and reopen it normally.
#  - Does not change any Cursor settings or files under ~/.cursor: the option applies only to this launch.
set -euo pipefail

PORT="${CP_CDP_PORT:-9222}"
URL="http://127.0.0.1:${PORT}/json/version"

port_up() {
  curl -fsS --max-time 1 "$URL" >/dev/null 2>&1
}

# Cursor main process? Only the executable path is checked (never the command line: it contains keys).
cursor_running() {
  ps -axo comm= | awk '/\/Cursor\.app\/Contents\/MacOS\/Cursor$/ { found = 1 } END { exit !found }'
}

case "${1:-start}" in
  status)
    if port_up; then
      echo "Debug port ${PORT}: active."
    else
      echo "Debug port ${PORT}: closed."
      exit 1
    fi
    ;;
  start)
    if port_up; then
      echo "Cursor is already running with debug port ${PORT}: nothing else to do."
      exit 0
    fi
    if cursor_running; then
      # After Cmd+Q the process takes a few seconds to disappear: wait briefly before giving up.
      echo "Cursor is still open: waiting up to 10 seconds for it to quit..." >&2
      for _ in $(seq 1 20); do
        cursor_running || break
        sleep 0.5
      done
    fi
    if cursor_running; then
      echo "Cursor is already running without the debug port." >&2
      echo "Quit with Cmd+Q (in-progress chats will stop: wait for them to finish) and run this command again." >&2
      exit 1
    fi
    open -a Cursor --args "--remote-debugging-port=${PORT}"
    for _ in $(seq 1 40); do
      if port_up; then
        echo "Cursor started: debug port ${PORT} active (127.0.0.1 only)."
        exit 0
      fi
      sleep 0.5
    done
    echo "Cursor was started, but port ${PORT} is not responding yet: check with 'tools/cursor-cdp.sh status'." >&2
    exit 1
    ;;
  *)
    echo "Usage: tools/cursor-cdp.sh [start|status]" >&2
    exit 2
    ;;
esac
