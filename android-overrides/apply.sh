#!/usr/bin/env bash
# ปรับแต่งโปรเจกต์ Android ที่ Capacitor สร้างให้ (ปลั๊กอิน OCR/บันทึกไฟล์, ไอคอน, ลายเซ็น, ขนาด APK)
set -euo pipefail
RUN="${1:-1}"
VER="${2:-1.0}"
APP=android/app
PKG_DIR="$APP/src/main/java/com/personal/mangatranslator"
RES="$APP/src/main/res"

# 1) โค้ด Java: MainActivity + ปลั๊กอิน MangaNative
mkdir -p "$PKG_DIR"
cp android-overrides/java/*.java "$PKG_DIR"/

# 2) ไอคอน / splash
find "$RES" -path '*mipmap-*' \( -name 'ic_launcher*.png' -o -name 'ic_launcher*.webp' \) -delete || true
cp -r android-overrides/res/. "$RES"/
find "$RES" -name 'splash.png' -exec cp android-overrides/splash.png {} \; || true

# 3) เวอร์ชัน
sed -i -E "s/versionCode [0-9]+/versionCode $RUN/; s/versionName \"[^\"]*\"/versionName \"$VER\"/" "$APP/build.gradle"

# 4) targetSdk 34 (ไม่บังคับ edge-to-edge บน Android 15+)
sed -i -E 's/targetSdkVersion *= *[0-9]+/targetSdkVersion = 34/' android/variables.gradle

# 5) ML Kit OCR (ญี่ปุ่น/เกาหลี/จีน/ละติน) + ลดขนาด APK เหลือ arm64
cat >> "$APP/build.gradle" <<'GRADLE'

// ---- Manga Translator additions ----
android {
    defaultConfig {
        ndk { abiFilters "arm64-v8a" }
    }
    lint {
        abortOnError false
        checkReleaseBuilds false
    }
}
dependencies {
    implementation 'com.google.mlkit:text-recognition:16.0.1'
    implementation 'com.google.mlkit:text-recognition-chinese:16.0.1'
    implementation 'com.google.mlkit:text-recognition-japanese:16.0.1'
    implementation 'com.google.mlkit:text-recognition-korean:16.0.1'
}
GRADLE
echo "apply.sh done (versionCode=$RUN, versionName=$VER)"
