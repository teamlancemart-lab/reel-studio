#!/usr/bin/env bash
# Fetch the three fonts rules.json type_systems names, at image build time.
#
# macOS system fonts (SnellRoundhand, Georgia, Times) do not exist in
# node:20-bookworm-slim. docs/hook-v4.mjs and docs/retune.mjs fall back to
# ImageFont.load_default() when they are missing, which renders an unusable card.
# So the container carries its own.
#
#   sans_pill        -> Inter
#   serif_smallcaps  -> Playfair Display (title) + Inter (subtitle)
#   script accent    -> Great Vibes (the "Coming" of "Coming Soon" in the v4 card)
set -euo pipefail

DEST="${1:-assets/fonts}"
mkdir -p "$DEST"

BASE="https://raw.githubusercontent.com/google/fonts/main/ofl"

fetch() {
  local url="$1" out="$2"
  echo "  $out"
  curl -fsSL --retry 3 --retry-delay 2 --max-time 120 -o "$DEST/$out" "$url"
  # A GitHub error page is a 200 with HTML in some proxies; a font is not tiny.
  local bytes
  bytes=$(wc -c <"$DEST/$out")
  if [ "$bytes" -lt 20000 ]; then
    echo "ERROR: $out is only ${bytes} bytes, that is not a font" >&2
    exit 1
  fi
}

echo "fetching fonts into $DEST"
fetch "$BASE/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf" "PlayfairDisplay-Variable.ttf"
fetch "$BASE/greatvibes/GreatVibes-Regular.ttf"             "GreatVibes-Regular.ttf"
fetch "$BASE/inter/Inter%5Bopsz%2Cwght%5D.ttf"              "Inter-Variable.ttf"

# OFL requires the licence to travel with the fonts.
curl -fsSL --retry 3 --max-time 60 -o "$DEST/OFL-Inter.txt"           "$BASE/inter/OFL.txt" || true
curl -fsSL --retry 3 --max-time 60 -o "$DEST/OFL-PlayfairDisplay.txt" "$BASE/playfairdisplay/OFL.txt" || true
curl -fsSL --retry 3 --max-time 60 -o "$DEST/OFL-GreatVibes.txt"      "$BASE/greatvibes/OFL.txt" || true

ls -la "$DEST"
