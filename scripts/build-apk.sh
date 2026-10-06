#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# NEXUS LOGISTICS — Android APK Build Script
# Packages NEXUS Ride & Freight dashboards into a signed Android APK.
# ==============================================================================

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "=================================================="
echo "⚡ NEXUS LOGISTICS — APK BUILD PIPELINE"
echo "=================================================="

# 1. Locate Android SDK
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [ -d "$HOME/Android/Sdk" ]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  else
    echo "❌ Error: ANDROID_HOME is not set and Android SDK was not found in default locations."
    exit 1
  fi
fi

echo "✓ Android SDK: $ANDROID_HOME"

# 2. Locate Build Tools & Platform JAR
BUILD_TOOLS_DIR=$(ls -d "$ANDROID_HOME/build-tools/"* 2>/dev/null | sort -V | tail -n 1)
if [ -z "$BUILD_TOOLS_DIR" ] || [ ! -d "$BUILD_TOOLS_DIR" ]; then
  echo "❌ Error: No build-tools found in $ANDROID_HOME/build-tools/"
  exit 1
fi
echo "✓ Build Tools: $BUILD_TOOLS_DIR"

PLATFORM_JAR=$(ls "$ANDROID_HOME/platforms/"*/android.jar 2>/dev/null | sort -V | tail -n 1)
if [ -z "$PLATFORM_JAR" ] || [ ! -f "$PLATFORM_JAR" ]; then
  echo "❌ Error: No android.jar found in $ANDROID_HOME/platforms/"
  exit 1
fi
echo "✓ Target Platform: $PLATFORM_JAR"

# 3. Verify Required Tools
AAPT2="$BUILD_TOOLS_DIR/aapt2"
D8="$BUILD_TOOLS_DIR/d8"
ZIPALIGN="$BUILD_TOOLS_DIR/zipalign"
APKSIGNER="$BUILD_TOOLS_DIR/apksigner"

for tool in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER" javac keytool; do
  if ! command -v "$tool" >/dev/null 2>&1 && [ ! -x "$tool" ]; then
    echo "❌ Missing tool: $tool"
    exit 1
  fi
done

# 4. Set up Directories
WORK_DIR="$PROJECT_DIR/android/app/build/intermediates"
OUT_DIR="$PROJECT_DIR/android/app/build/outputs/apk/debug"
DIST_DIR="$PROJECT_DIR/dist"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/compiled-res" "$WORK_DIR/gen" "$WORK_DIR/classes" "$WORK_DIR/assets" "$OUT_DIR" "$DIST_DIR"

# 5. Prepare Assets (Mount frontend into assets)
echo "📦 Bundling frontend UI assets..."
cp -R "$PROJECT_DIR/frontend/"* "$WORK_DIR/assets/"

# 6. Compile Android Resources with AAPT2
echo "🎨 Compiling Android resources with AAPT2..."
"$AAPT2" compile --dir "$PROJECT_DIR/android/app/src/main/res" -o "$WORK_DIR/compiled-res/"

echo "🔗 Linking APK resources and assets..."
"$AAPT2" link \
  -I "$PLATFORM_JAR" \
  --manifest "$PROJECT_DIR/android/app/src/main/AndroidManifest.xml" \
  -A "$WORK_DIR/assets" \
  -o "$WORK_DIR/app-res.apk" \
  --java "$WORK_DIR/gen" \
  --auto-add-overlay \
  "$WORK_DIR/compiled-res/"*.flat

# 7. Compile Java Code
echo "☕ Compiling Java source files..."
javac --release 8 \
  -cp "$PLATFORM_JAR" \
  -d "$WORK_DIR/classes" \
  "$WORK_DIR/gen/com/nexus/logistics/R.java" \
  "$PROJECT_DIR/android/app/src/main/java/com/nexus/logistics/MainActivity.java"

# 8. DEX Compilation with D8
echo "⚙️ Converting Java bytecode to Dalvik bytecode (DEX)..."
jar cf "$WORK_DIR/classes.jar" -C "$WORK_DIR/classes" .
"$D8" \
  --output "$WORK_DIR" \
  --lib "$PLATFORM_JAR" \
  --min-api 26 \
  "$WORK_DIR/classes.jar"

# 9. Package DEX into APK
echo "📦 Packaging DEX into unaligned APK..."
cp "$WORK_DIR/app-res.apk" "$WORK_DIR/unaligned.apk"
(cd "$WORK_DIR" && zip -q -u "$WORK_DIR/unaligned.apk" classes.dex)

# 10. Zipalign (4-byte alignment)
echo "📐 Aligning APK with zipalign..."
"$ZIPALIGN" -f -p 4 "$WORK_DIR/unaligned.apk" "$WORK_DIR/aligned.apk"

# 11. Keystore & Code Signing
KEYSTORE="$HOME/.android/debug.keystore"
KS_PASS="android"
KEY_ALIAS="androiddebugkey"

if [ ! -f "$KEYSTORE" ]; then
  KEYSTORE="$PROJECT_DIR/android/debug.keystore"
  if [ ! -f "$KEYSTORE" ]; then
    echo "🔑 Generating debug keystore at $KEYSTORE..."
    keytool -genkeypair -v \
      -keystore "$KEYSTORE" \
      -storepass "$KS_PASS" \
      -alias "$KEY_ALIAS" \
      -keypass "$KS_PASS" \
      -keyalg RSA \
      -keysize 2048 \
      -validity 10000 \
      -dname "CN=Nexus Logistics, OU=Mobile, O=Nexus, L=NYC, ST=NY, C=US"
  fi
fi

echo "✍️ Signing APK with apksigner ($KEYSTORE)..."
FINAL_APK="$DIST_DIR/nexus-logistics.apk"
GRADLE_OUT_APK="$OUT_DIR/nexus-logistics.apk"

"$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-pass "pass:$KS_PASS" \
  --ks-key-alias "$KEY_ALIAS" \
  --key-pass "pass:$KS_PASS" \
  --out "$FINAL_APK" \
  "$WORK_DIR/aligned.apk"

cp "$FINAL_APK" "$GRADLE_OUT_APK"

# 12. Verify APK Signature
echo "🔍 Verifying APK integrity and signature..."
"$APKSIGNER" verify --verbose "$FINAL_APK"

APK_SIZE=$(du -h "$FINAL_APK" | cut -f1)

echo ""
echo "=================================================="
echo "✅ BUILD SUCCESSFUL!"
echo "=================================================="
echo "📱 APK Artifacts:"
echo "   ➜ $FINAL_APK ($APK_SIZE)"
echo "   ➜ $GRADLE_OUT_APK ($APK_SIZE)"
echo ""
echo "🚀 To install on an Android emulator or connected device:"
echo "   adb install -r \"$FINAL_APK\""
echo ""
echo "▶ To launch on device:"
echo "   adb shell am start -n com.nexus.logistics/.MainActivity"
echo "=================================================="
