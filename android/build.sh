#!/usr/bin/env bash
# Build KERF for Android without Gradle: aapt2 → javac → d8 → zipalign → apksigner.
#   ANDROID_BUILD_TOOLS=/path/to/build-tools/36.x  ANDROID_JAR=/path/to/platforms/android-36/android.jar \
#   KERF_KEYSTORE=/safe/place/kerf-release.jks KERF_KS_PASS=…  ./android/build.sh
# Run `npm run build` in the repository root first. Keep the keystore out of the repository: every update
# must be signed with the same key, so lose it and phones cannot update — they must uninstall first.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
: "${ANDROID_BUILD_TOOLS:?set ANDROID_BUILD_TOOLS to an Android build-tools directory (36.x)}"
: "${ANDROID_JAR:?set ANDROID_JAR to platforms/android-36/android.jar}"
: "${KERF_KEYSTORE:?set KERF_KEYSTORE to your release keystore (.jks)}"
: "${KERF_KS_PASS:?set KERF_KS_PASS to the keystore password}"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"; OUT="$HERE/out"; BT="$ANDROID_BUILD_TOOLS"
VERSION="$(node -p "require('$ROOT/package.json').version")"
CODE="$(node -p "const [a,b,c]='$VERSION'.split('.').map(Number); a*10000+b*100+c")"
[ -f "$ROOT/dist/index.html" ] || { echo "Build the web app first: npm run build"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/assets/web" "$OUT/gen" "$OUT/classes" "$OUT/dex"

# 1 · the web app, minus the base64 copies that only text-only web hosts need
(cd "$ROOT/dist" && tar --exclude=./embed --exclude=./artifact.html -cf - .) | (cd "$OUT/assets/web" && tar -xf -)

# 2 · resources + manifest
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"
"$BT/aapt2" link -I "$ANDROID_JAR" --manifest "$HERE/AndroidManifest.xml" -R "$OUT/res.zip" -A "$OUT/assets" \
  --java "$OUT/gen" --min-sdk-version 26 --target-sdk-version 36 --version-code "$CODE" --version-name "$VERSION" \
  -0 wasm -0 gz -0 zip --auto-add-overlay -o "$OUT/kerf-unsigned.apk"

# 3 · Java → DEX
javac --release 17 -Xlint:-options -encoding UTF-8 -classpath "$ANDROID_JAR" -d "$OUT/classes" $(find "$HERE/src" "$OUT/gen" -name '*.java')
"$BT/d8" --release --lib "$ANDROID_JAR" --min-api 26 --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j "$OUT/kerf-unsigned.apk" classes.dex)

# 4 · align + sign (v2/v3 signatures)
"$BT/zipalign" -p -f 4 "$OUT/kerf-unsigned.apk" "$OUT/kerf-aligned.apk"
"$BT/apksigner" sign --ks "$KERF_KEYSTORE" --ks-key-alias kerf --ks-pass env:KERF_KS_PASS --key-pass env:KERF_KS_PASS \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --out "$OUT/KERF-$VERSION-android.apk" "$OUT/kerf-aligned.apk"
"$BT/apksigner" verify --verbose "$OUT/KERF-$VERSION-android.apk" | head -6
echo "built $OUT/KERF-$VERSION-android.apk ($(du -h "$OUT/KERF-$VERSION-android.apk" | cut -f1))"
