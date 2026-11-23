#!/usr/bin/env bash
set -euo pipefail
VER="${1:-1.0}"
OUT=dist-apk
mkdir -p "$OUT"
SRC=$(ls android/app/build/outputs/apk/release/*.apk | head -1)
echo "Unsigned APK: $SRC"

KS=signing/release.jks
if [ -n "${KEYSTORE_BASE64:-}" ]; then
  echo "$KEYSTORE_BASE64" | base64 -d > signing/custom.jks
  KS=signing/custom.jks
fi
ALIAS="${KS_ALIAS:-manga}"
PASS="${KS_PASS:-mangatranslator}"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
BT=""
for d in $(ls -d "$SDK"/build-tools/* | sort -V -r); do
  if [ -x "$d/zipalign" ] && [ -x "$d/apksigner" ]; then BT="$d"; break; fi
done
[ -n "$BT" ] || { echo "build-tools not found in $SDK"; exit 1; }
echo "Using build-tools: $BT"

"$BT/zipalign" -f -p 4 "$SRC" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-key-alias "$ALIAS" \
  --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --out "$OUT/MangaTranslator-$VER.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/MangaTranslator-$VER.apk" | head -3
rm -f "$OUT/aligned.apk" "$OUT"/*.idsig
ls -la "$OUT"
