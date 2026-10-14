#!/bin/bash
# Automatic daemon startup with launchd (macOS): user LaunchAgent, no administrator privileges.
#
#   tools/launchd.sh install     creates ~/Library/LaunchAgents/local.cursor-pocket.daemon.plist and starts the daemon
#   tools/launchd.sh uninstall   stops the daemon and removes the plist (data and logs remain)
#   tools/launchd.sh restart     restarts the daemon (after updating the code)
#   tools/launchd.sh status      service and port status
#   tools/launchd.sh print       prints the plist that would be created, without installing anything
#
# The daemon starts at login and is restarted if it stops due to an error (not if you stop it cleanly).
# Does not touch Cursor or Tailscale. The plist includes: real path to node, project path, and any
# CP_* variables present in the environment at install time (only NAMES are printed).
# The project must not live in Documents, Desktop, or Downloads: launchd requires extra permissions there.
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
  echo "Error: $*" >&2
  exit 1
}

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# REAL node path: the shell's node may be a temporary symlink (e.g. fnm) that changes every session.
resolve_node() {
  local candidate="${CP_INSTALL_NODE:-$(command -v node || true)}"
  [ -n "$candidate" ] || die "node not found on PATH (Node >= 22.13 required)."
  "$candidate" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
    || die "Node >= 22.13 required (found: $("$candidate" -v))."
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
  # CP_* variables from the environment (CP_INSTALL_* belong to the installer, not the daemon).
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
  <!-- Restart only after an error: a clean stop (launchctl stop/bootout) is not overridden. -->
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
  [ "$(uname)" = "Darwin" ] || die "macOS only."
  [ -f "$DAEMON_DIR/src/index.js" ] || die "cannot find $DAEMON_DIR/src/index.js."
  local node_bin
  node_bin="$(resolve_node)"

  if is_loaded; then
    echo "Service already installed: updating it."
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    sleep 1
  fi
  if port_in_use; then
    die "port $PORT is already in use (daemon started manually?). Stop it and retry: the service cannot start."
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  chmod 700 "$LOG_DIR"
  render_plist "$node_bin" >"$PLIST"
  chmod 644 "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "invalid plist: $PLIST"

  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl enable "$DOMAIN/$LABEL"

  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if port_in_use; then break; fi
    sleep 1
  done
  echo "Service:  $LABEL"
  echo "Plist:     $PLIST"
  echo "Node:      $node_bin"
  echo "Project:   $DAEMON_DIR"
  echo "Log:       $LOG_FILE"
  local names
  names="$(compgen -e | grep '^CP_' | grep -v '^CP_INSTALL_' | tr '\n' ' ' || true)"
  echo "CP_* variables copied into plist: ${names:-none}"
  if port_in_use; then
    echo "Daemon listening on 127.0.0.1:$PORT. Starts automatically at each login."
  else
    echo "Daemon is not listening on 127.0.0.1:$PORT: check the log ($LOG_FILE)." >&2
    exit 1
  fi
}

cmd_uninstall() {
  if is_loaded; then
    launchctl bootout "$DOMAIN/$LABEL" || true
  fi
  rm -f "$PLIST"
  echo "Service removed. Data in $DAEMON_DIR/data and logs in $LOG_DIR were not touched."
}

cmd_restart() {
  is_loaded || die "service not installed: run 'tools/launchd.sh install' first."
  launchctl kickstart -k "$DOMAIN/$LABEL"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if port_in_use; then echo "Daemon restarted, listening on 127.0.0.1:$PORT."; return 0; fi
  done
  die "after restart the daemon is not listening: check the log ($LOG_FILE)."
}

cmd_status() {
  if [ -f "$PLIST" ]; then echo "Plist:     $PLIST"; else echo "Plist:     not installed"; fi
  if is_loaded; then
    # Only a few lines: no environment or other detail.
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*(state|pid|runs|last exit code) = / { sub(/^[[:space:]]+/, ""); print "Service:  " $0 }'
  else
    echo "Service:  not loaded"
  fi
  if port_in_use; then echo "Port:     $PORT listening"; else echo "Port:     $PORT free (daemon not active)"; fi
  [ -f "$LOG_FILE" ] && echo "Log:       $LOG_FILE ($(wc -c <"$LOG_FILE" | tr -d ' ') bytes)" || true
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  print) cmd_print ;;
  *) echo "Usage: tools/launchd.sh <install|uninstall|restart|status|print>" >&2; exit 2 ;;
esac
