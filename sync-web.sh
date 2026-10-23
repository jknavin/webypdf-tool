#!/usr/bin/env bash
# Copies the website (../webypdf) into the app. Run after you change the website, then rebuild.
set -e
SRC="${1:-../webypdf}"
DST="app/src/main/assets/www"
rm -rf "$DST" && mkdir -p "$DST"
cp -r "$SRC"/index.html "$SRC"/manifest.webmanifest "$SRC"/css "$SRC"/js "$SRC"/vendor "$SRC"/icons "$DST"/
echo "Synced web app into $DST"
