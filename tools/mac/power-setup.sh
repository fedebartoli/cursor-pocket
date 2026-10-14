#!/bin/bash
# Lets the daemon keep the Mac awake EVEN with the lid closed and on battery, ONLY while an agent is working.
#
# What it does: adds a sudoers rule (/etc/sudoers.d/cursor-pocket-pmset) allowing YOUR user to run, without
# password, exactly these two commands and nothing else:
#     /usr/bin/pmset -a disablesleep 1
#     /usr/bin/pmset -a disablesleep 0
# The daemon uses them as: 1 while an agent works (and the feature is on in Settings), 0 when it finishes, if the daemon
# stops, or if battery drops below the threshold. A watchdog process sets 0 even if the daemon dies unexpectedly.
#
#   sudo tools/mac/power-setup.sh install     create the rule (validated with visudo before enabling)
#   sudo tools/mac/power-setup.sh uninstall   remove it and set disablesleep back to 0
#   tools/mac/power-setup.sh status           whether the rule exists and the current disablesleep value
#
# WARNING: with disablesleep at 1 the Mac does NOT sleep even with the lid closed: it heats up in a bag. That is why the
# daemon keeps it at 1 only while an agent works and restores 0 with four safeguards (work finished, daemon shutdown,
# watchdog process, low battery). If it ever stays at 1:  sudo pmset -a disablesleep 0
set -euo pipefail

RULE="/etc/sudoers.d/cursor-pocket-pmset"
cmd="${1:-status}"

case "$cmd" in
  status)
    if [ -f "$RULE" ]; then echo "Sudoers rule: present ($RULE)"; else echo "Sudoers rule: absent"; fi
    echo "Current state: $(pmset -g | awk '/SleepDisabled|disablesleep/ {print $1 "=" $2}' | head -1)"
    echo "Passwordless test: $(sudo -n -l /usr/bin/pmset -a disablesleep 1 >/dev/null 2>&1 && echo allowed || echo not allowed)"
    ;;
  install)
    [ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0 install" >&2; exit 1; }
    USER_NAME="${SUDO_USER:-}"
    [ -n "$USER_NAME" ] && [ "$USER_NAME" != "root" ] || { echo "Run the command with sudo as a normal user (SUDO_USER required)." >&2; exit 1; }
    TMP="$(mktemp)"
    printf '%s ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0\n' "$USER_NAME" > "$TMP"
    visudo -cf "$TMP" >/dev/null || { rm -f "$TMP"; echo "Rule is invalid: no changes made." >&2; exit 1; }
    install -m 0440 -o root -g wheel "$TMP" "$RULE"
    rm -f "$TMP"
    echo "Rule created for user $USER_NAME: $RULE"
    ;;
  uninstall)
    [ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0 uninstall" >&2; exit 1; }
    /usr/bin/pmset -a disablesleep 0
    rm -f "$RULE"
    echo "Rule removed and disablesleep set back to 0."
    ;;
  *)
    echo "Usage: [sudo] $0 install | uninstall | status" >&2
    exit 64
    ;;
esac
