#!/bin/bash
# Build the built-in screen brightness helper (requires `swiftc`, included in Xcode Command Line Tools).
# Binary goes to daemon/data/bin/cp-brightness (gitignored folder). No administrator privileges.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(dirname "$(dirname "$HERE")")/daemon/data/bin"
command -v swiftc >/dev/null || { echo "swiftc not found: install Xcode Command Line Tools (xcode-select --install)." >&2; exit 1; }
mkdir -p "$OUT"
swiftc -O "$HERE/brightness.swift" -o "$OUT/cp-brightness"
echo "Created $OUT/cp-brightness (current value: $("$OUT/cp-brightness" get))"
