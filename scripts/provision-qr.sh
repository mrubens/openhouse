#!/bin/bash
# The QR code that sets a freshly reset tablet up as the display, with no cable (docs/self-update.md, "Setup without a
# cable"): on the tablet's welcome screen, tap six times in the same spot, scan this, and Android downloads the display
# from the URL, checks it's signed with the release key, and makes it the tablet's owner.
#
#   scripts/provision-qr.sh <display.apk> <https URL it's served at> [--runtime https://…/runtime.tar.gz]
#       [--update-url https://…/update.json] [--wifi SSID [--wifi-password P] [--wifi-security WPA]] [--out qr.png or qr.svg]
#
# Writes qr.json (what the code holds) and qr.png. Wi-Fi details in it are readable by anyone who sees the code.
set -eo pipefail
cd "$(dirname "$0")/.."
. scripts/env.sh
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
APK=$1 URL=$2; shift 2 || { sed -n '2,10p' "$0"; exit 1; }
RUNTIME= UPDATE= SSID= WPASS= SEC=WPA OUT=qr.png
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME=$2; shift ;; --update-url) UPDATE=$2; shift ;; --wifi) SSID=$2; shift ;;
    --wifi-password) WPASS=$2; shift ;; --wifi-security) SEC=$2; shift ;; --out) OUT=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac; shift
done
# https only, except for the emulator's computer when testing (OPENHOUSE_QR_TEST=1, docs/self-update.md).
case "$URL" in https://*) ;; http://10.0.2.2:*) [ -n "$OPENHOUSE_QR_TEST" ] || { echo "http only for an emulator test (OPENHOUSE_QR_TEST=1)." >&2; exit 1; } ;; *) echo "Android downloads the display over https only." >&2; exit 1 ;; esac
# The APK file's own SHA-256, base64url without padding: Android checks the download against it. Not the signer's
# checksum: Android's setup compares that with the oldest key in the APK's lineage, the debug key, which isn't secret.
# So the code is for this one APK: point it at that release's file, not a "latest" link (it updates itself after).
"$BT/apksigner" verify --min-sdk-version 29 "$APK" >/dev/null || { echo "$APK isn't a properly signed APK." >&2; exit 1; }
# The admin component from the APK itself (a release's IDs, not the debug builds' in env.sh).
PKG=$("$BT/aapt2" dump packagename "$APK")
SUM=$(shasum -a 256 "$APK" | cut -d' ' -f1 | xxd -r -p | base64 | tr '+/' '-_' | tr -d '=')
JSON=${OUT%.*}.json
node - "$JSON" <<JS
const x = {
  'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': '$PKG/dev.openhouse.shell.AdminReceiver',
  'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': '$URL',
  'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': '$SUM',
  'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
  // Go on with Android's own setup if Google's device-management app can't be updated first (no Play on the tablet).
  'android.app.extra.PROVISIONING_ALLOW_OFFLINE': true,
  // Fewer of Android's own screens, and theirs say whose it is: the household's, not "your organization" (where the
  // tablet's setup shows the name; Samsung's own screens may still say organization).
  'android.app.extra.PROVISIONING_SKIP_EDUCATION_SCREENS': true,
  'android.app.extra.PROVISIONING_ORGANIZATION_NAME': 'your household',
  'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': {},
};
if ('$RUNTIME') x['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'].runtime_url = '$RUNTIME';
if ('$UPDATE') x['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'].update_url = '$UPDATE';
if ('$SSID') Object.assign(x, { 'android.app.extra.PROVISIONING_WIFI_SSID': '$SSID', 'android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE': '$SEC',
  ...('$WPASS' ? { 'android.app.extra.PROVISIONING_WIFI_PASSWORD': '$WPASS' } : {}) });
require('fs').writeFileSync(process.argv[2], JSON.stringify(x, null, 1));
JS
ZX=$(find ~/.gradle/caches/modules-2 -name 'core-3.5.3.jar' -path '*zxing*' | head -1)
[ -n "$ZX" ] || (cd shell && ./gradlew -q :app:dependencies >/dev/null) # fetches it with the display's own libraries
ZX=${ZX:-$(find ~/.gradle/caches/modules-2 -name 'core-3.5.3.jar' -path '*zxing*' | head -1)}
java -cp "$ZX" scripts/qr/Qr.java "$JSON" "$OUT"
cat "$JSON"; echo; echo "QR code: $OUT"
