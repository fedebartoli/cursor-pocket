#!/bin/bash
# Compila l'assistente per la luminosita' dello schermo (serve `swiftc`, incluso negli Xcode Command Line Tools).
# Il binario va in daemon/data/bin/cp-brightness (cartella ignorata da git). Nessun privilegio di amministratore.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(dirname "$(dirname "$HERE")")/daemon/data/bin"
command -v swiftc >/dev/null || { echo "swiftc non trovato: installa gli Xcode Command Line Tools (xcode-select --install)." >&2; exit 1; }
mkdir -p "$OUT"
swiftc -O "$HERE/brightness.swift" -o "$OUT/cp-brightness"
echo "Creato $OUT/cp-brightness (valore attuale: $("$OUT/cp-brightness" get))"
