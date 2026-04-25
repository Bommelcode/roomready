#!/bin/bash
# Snapshot helper — pak huidige staat in als .snapshots/<versie>/
# Gebruik: ./snapshot.sh v3.4.2 "korte beschrijving"

set -e
if [ -z "$1" ]; then
  echo "Gebruik: $0 <versie> [beschrijving]"
  echo "Bijvoorbeeld: $0 v3.4.2 'log spam terug op verzoek'"
  exit 1
fi

VERSION="$1"
DESC="${2:-(geen beschrijving)}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SNAP_DIR="$APP_DIR/.snapshots/$VERSION"

if [ -d "$SNAP_DIR" ]; then
  echo "WAARSCHUWING: $SNAP_DIR bestaat al. Overschrijven? (y/N)"
  read -r ans
  if [ "$ans" != "y" ]; then exit 1; fi
fi

mkdir -p "$SNAP_DIR"
cp "$APP_DIR/main.js" \
   "$APP_DIR/preload.js" \
   "$APP_DIR/renderer.html" \
   "$APP_DIR/preview.html" \
   "$APP_DIR/inventory.html" \
   "$APP_DIR/package.json" \
   "$SNAP_DIR/"

echo "✓ Snapshot $VERSION opgeslagen: $DESC"
echo "  Locatie: $SNAP_DIR"
